const crypto = require('node:crypto');

/* The feed holds your calendar, so it is never public: every request needs
   ?token=FEED_TOKEN. The token sits in the query rather than a header so
   Vercel's edge cache keys on it (a header wouldn't be part of the key). */
function authorised(req, env = process.env) {
	const expected = env.FEED_TOKEN || '';
	if (!expected) return false;
	const url = new URL(req.url, 'http://localhost');
	const given = url.searchParams.get('token') || '';
	const a = Buffer.from(given);
	const b = Buffer.from(expected);
	return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function send(res, status, body, cacheSeconds = 0) {
	res.statusCode = status;
	res.setHeader('Content-Type', 'application/json; charset=utf-8');
	// The launcher page runs from inside the TV app (no web origin), so it
	// needs this to read the feed. Every answer still requires the token.
	res.setHeader('Access-Control-Allow-Origin', '*');
	res.setHeader(
		'Cache-Control',
		cacheSeconds > 0 ? `public, max-age=0, s-maxage=${cacheSeconds}, stale-while-revalidate=${cacheSeconds * 3}` : 'no-store'
	);
	res.end(JSON.stringify(body));
}

function deny(res) {
	send(res, 401, {error: 'missing or wrong token'});
}

module.exports = {authorised, send, deny};
