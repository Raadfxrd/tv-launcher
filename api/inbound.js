const crypto = require('node:crypto');
const {normalise, forwardingConfirmation} = require('../lib/mail');
const {askClaude, validate, verifyDhl, merge, stale, placeOf, looksLikeShipping} = require('../lib/parcels');
const {getParcels, putParcel, deleteParcels, logInbound, seenBefore, markSeen, withLock} = require('../lib/store');
const {send} = require('../lib/http');

/**
 * POST /api/inbound?token=INBOUND_TOKEN — one email in, a parcel out.
 *
 * Postmark's inbound webhook posts here (its JSON shape), and so could a
 * Proton Mail Bridge poller later ({from, subject, text|html, date}). Every
 * email is logged with what happened to it; read the log at
 * /api/inbox?token=FEED_TOKEN. Errors answer 500 so Postmark retries later.
 */

function allowed(req, env = process.env) {
	const expected = env.INBOUND_TOKEN || '';
	if (!expected) return false;
	const given = new URL(req.url, 'http://localhost').searchParams.get('token') || '';
	const a = Buffer.from(given);
	const b = Buffer.from(expected);
	return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function readBody(req) {
	if (req.body && typeof req.body === 'object') return req.body;
	if (typeof req.body === 'string') return JSON.parse(req.body);
	const chunks = [];
	for await (const chunk of req) chunks.push(chunk);
	return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

async function handle(mail, env = process.env) {
	const entry = {at: new Date().toISOString(), from: mail.from, subject: mail.subject.slice(0, 140)};

	// The same email twice (a Postmark retry, or forwarded from two addresses).
	if (await seenBefore(mail.id, env)) {
		await logInbound({...entry, result: 'skipped: this email was already processed'}, env);
		return {result: 'duplicate'};
	}
	const done = async (result, extra = {}) => {
		await logInbound({...entry, result, ...extra}, env);
		await markSeen(mail.id, env);
	};

	// Proton's "accept forwarding" email: keep the link where you can click it.
	const confirm = forwardingConfirmation(mail);
	if (confirm) {
		await done('forwarding confirmation: open the link to accept', {link: confirm.link});
		return {result: 'forwarding-confirmation'};
	}

	// Newsletters to the shipping address don't cost a Claude call.
	if (!looksLikeShipping(mail)) {
		await done('ignored: not about shipping');
		return {result: 'ignored', reason: 'not about shipping'};
	}

	const {readings, rejected} = validate(await askClaude(mail, env), mail);
	if (!readings.length) {
		await done(`ignored: ${rejected.join('; ')}`);
		return {result: 'ignored', reason: rejected.join('; ')};
	}

	// One email can be about several parcels (a split order); each is merged
	// under its own lock, keyed by tracking code alone, so the shop's email and
	// the carrier's email about the same parcel end up as one.
	const results = [];
	for (const reading of readings) {
		const parcel = await withLock(reading.code, async () => {
			const all = await getParcels(env);
			const existing = all.find((p) => p.code === reading.code);
			let next = merge(existing, reading, mail);
			next.place = placeOf(next.postalCode, env);
			next = await verifyDhl(next, env).catch(() => next);
			await putParcel(next, env);
			if (existing && existing.key !== next.key) await deleteParcels([existing.key], env); // older carrier:code keys
			return next;
		}, env);
		results.push(parcel);
	}
	const all = await getParcels(env);
	await deleteParcels(stale(all.filter((p) => !results.some((r) => r.key === p.key))), env);

	const describe = (p) => `${p.carrier} ${p.code}: ${p.status}${p.place && p.place !== 'home' ? ` (for ${p.place})` : ''}${p.verified ? ' (confirmed by carrier)' : ''}`;
	await done([...results.map(describe), ...rejected.map((r) => `skipped ${r}`)].join('; '));
	return {result: 'parcel', parcels: results.map((p) => ({key: p.key, status: p.status}))};
}

module.exports = async function handler(req, res) {
	if (req.method !== 'POST') return send(res, 405, {error: 'POST only'});
	if (!allowed(req)) return send(res, 401, {error: 'missing or wrong token'});
	let mail;
	try {
		mail = normalise(await readBody(req));
	} catch {
		return send(res, 400, {error: 'body is not JSON'});
	}
	try {
		send(res, 200, await handle(mail));
	} catch (err) {
		await logInbound({at: new Date().toISOString(), from: mail.from, subject: mail.subject.slice(0, 140), result: `error: ${err.message}`}).catch(() => null);
		send(res, 500, {error: err.message});
	}
};

module.exports.handle = handle;
