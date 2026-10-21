const crypto = require('node:crypto');
const {send} = require('../lib/http');
const {config: storeConfig} = require('../lib/store');

/**
 * GET /api/status[?token=…] — is the API up, and is this token the right one?
 * Works without a token (so the TV can tell "can't reach it" from "wrong
 * token"); with the right token it also says which services are set up
 * (yes/no only, never a value). Never cached.
 */
function tokenState(given, expected) {
	if (!expected) return 'not-set';
	if (!given) return 'missing';
	const a = Buffer.from(given);
	const b = Buffer.from(expected);
	return a.length === b.length && crypto.timingSafeEqual(a, b) ? 'ok' : 'wrong';
}

module.exports = function handler(req, res) {
	const env = process.env;
	const given = new URL(req.url, 'http://localhost').searchParams.get('token') || '';
	const token = tokenState(given, env.FEED_TOKEN || '');
	const body = {up: true, time: new Date().toISOString(), token};
	if (token === 'ok') {
		body.services = {
			calendar: Boolean((env.ICLOUD_USERNAME && env.ICLOUD_APP_PASSWORD) || env.CALENDAR_ICS_URLS),
			google: Boolean(env.GOOGLE_MAPS_API_KEY),
			ns: Boolean(env.NS_API_KEY),
			weather: Boolean(env.HOME_LAT && env.HOME_LON),
			parcels: Boolean(storeConfig(env) && env.ANTHROPIC_API_KEY && env.INBOUND_TOKEN),
			trending: Boolean(env.TMDB_API_KEY),
			photos: Boolean(env.UNSPLASH_ACCESS_KEY && env.UNSPLASH_COLLECTION_ID),
			push: Boolean(env.NTFY_TOPIC),
		};
	}
	send(res, 200, body);
};
