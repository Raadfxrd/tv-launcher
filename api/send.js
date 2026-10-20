const {authorised, send, deny} = require('../lib/http');

/**
 * POST /api/send?token=FEED_TOKEN — a push notification to your phone, via
 * ntfy (https://ntfy.sh): install the ntfy app, subscribe to NTFY_TOPIC, done.
 * Body (sent as text/plain so the TV's page needs no CORS preflight):
 *   {"title": "...", "message": "...", "url": "https://<this site>/trip/#..."}
 * Tapping the notification opens the url.
 *
 * Env: NTFY_TOPIC (a long random name: anyone who knows it can read it),
 *      NTFY_SERVER (default https://ntfy.sh), NTFY_TOKEN (optional, for a
 *      protected topic on your own server or an ntfy account).
 */

async function readBody(req) {
	if (req.body && typeof req.body === 'object') return req.body;
	if (typeof req.body === 'string') return JSON.parse(req.body);
	const chunks = [];
	for await (const chunk of req) chunks.push(chunk);
	return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

module.exports = async function handler(req, res) {
	if (!authorised(req)) return deny(res);
	const env = process.env;
	if (req.method === 'GET') return send(res, 200, {configured: Boolean(env.NTFY_TOPIC)});
	if (req.method !== 'POST') return send(res, 405, {error: 'POST only'});
	if (!env.NTFY_TOPIC) return send(res, 200, {configured: false});
	let body;
	try {
		body = await readBody(req);
	} catch {
		return send(res, 400, {error: 'body is not JSON'});
	}
	const title = String(body.title || '').slice(0, 120);
	const message = String(body.message || '').slice(0, 1000);
	if (!message) return send(res, 400, {error: 'nothing to send'});
	// Only links back to this site's own pages are passed on.
	const host = req.headers['x-forwarded-host'] || req.headers.host || '';
	let click;
	try {
		const u = new URL(String(body.url || ''));
		if (u.host === host) click = u.toString();
	} catch {}

	const server = (env.NTFY_SERVER || 'https://ntfy.sh').replace(/\/$/, '');
	const r = await fetch(server, {
		method: 'POST',
		headers: {'Content-Type': 'application/json', ...(env.NTFY_TOKEN ? {Authorization: `Bearer ${env.NTFY_TOKEN}`} : {})},
		body: JSON.stringify({topic: env.NTFY_TOPIC, title, message, tags: ['train'], ...(click ? {click} : {})}),
		signal: AbortSignal.timeout(8000),
	}).catch((err) => ({ok: false, status: 0, statusText: err.message}));
	if (!r.ok) return send(res, 502, {error: `ntfy answered ${r.status} ${r.statusText || ''}`.trim()});
	send(res, 200, {configured: true, sent: true});
};
