const {authorised, deny, send} = require('../../lib/http');
const tidal = require('../../lib/tidal');

/**
 * GET /api/tidal/login?token=FEED_TOKEN — open this in a browser once: it
 * sends you to TIDAL's login, and TIDAL sends you back to /api/tidal/callback.
 * Register https://<this site>/api/tidal/callback as the redirect URI of your
 * app on developer.tidal.com.
 */
module.exports = async function handler(req, res) {
	if (!authorised(req)) return deny(res);
	if (!tidal.configured()) return send(res, 200, {configured: false, error: 'set TIDAL_CLIENT_ID and TIDAL_CLIENT_SECRET in Vercel first'});
	const host = req.headers['x-forwarded-host'] || req.headers.host;
	const proto = req.headers['x-forwarded-proto'] || 'https';
	try {
		const url = await tidal.loginUrl(`${proto}://${host}/api/tidal/callback`);
		res.statusCode = 302;
		res.setHeader('Location', url);
		res.setHeader('Cache-Control', 'no-store');
		res.end();
	} catch (err) {
		send(res, 500, {error: err.message});
	}
};
