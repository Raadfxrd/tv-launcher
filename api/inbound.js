const crypto = require('node:crypto');
const {normalise, forwardingConfirmation} = require('../lib/mail');
const {askClaude, validate, verifyDhl, merge, stale} = require('../lib/parcels');
const {getParcels, putParcel, deleteParcels, logInbound} = require('../lib/store');
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

	// Proton's "accept forwarding" email: keep the link where you can click it.
	const confirm = forwardingConfirmation(mail);
	if (confirm) {
		await logInbound({...entry, result: 'forwarding confirmation: open the link to accept', link: confirm.link}, env);
		return {result: 'forwarding-confirmation'};
	}

	const reading = validate(await askClaude(mail, env), mail);
	if (reading.rejected) {
		await logInbound({...entry, result: `ignored: ${reading.rejected}`}, env);
		return {result: 'ignored', reason: reading.rejected};
	}

	const parcels = await getParcels(env);
	const key = `${reading.carrier}:${reading.code}`;
	let parcel = merge(parcels.find((p) => p.key === key), reading, mail);
	parcel = await verifyDhl(parcel, env).catch(() => parcel);
	await putParcel(parcel, env);
	await deleteParcels(stale(parcels.filter((p) => p.key !== key)), env);
	await logInbound({...entry, result: `${parcel.carrier} ${parcel.code}: ${parcel.status}${parcel.verified ? ' (confirmed by carrier)' : ''}`}, env);
	return {result: 'parcel', key, status: parcel.status};
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
