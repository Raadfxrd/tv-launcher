const crypto = require('node:crypto');

/**
 * Apple Maps Server API: turns addresses into coordinates, and gives a public
 * transport travel time when the NS planner isn't available.
 *
 * Auth: a JWT signed with your Maps private key (ES256) is exchanged at
 * /v1/token for a short-lived access token, which is cached until it nearly
 * expires. Needs an Apple Developer account with a Maps ID and private key.
 *
 * Env: APPLE_MAPS_TEAM_ID, APPLE_MAPS_KEY_ID, APPLE_MAPS_PRIVATE_KEY (the .p8
 * file's contents; "\n" escapes are fine).
 */

const BASE = 'https://maps-api.apple.com';

function configured(env = process.env) {
	return Boolean(env.APPLE_MAPS_TEAM_ID && env.APPLE_MAPS_KEY_ID && env.APPLE_MAPS_PRIVATE_KEY);
}

function b64url(input) {
	return Buffer.from(input).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

/* The signed "auth token" Apple swaps for an access token. */
function signAuthToken(env = process.env, now = Math.floor(Date.now() / 1000)) {
	const header = {alg: 'ES256', kid: env.APPLE_MAPS_KEY_ID, typ: 'JWT'};
	const payload = {iss: env.APPLE_MAPS_TEAM_ID, iat: now, exp: now + 30 * 60, scope: 'server_api'};
	const data = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
	const key = String(env.APPLE_MAPS_PRIVATE_KEY).replace(/\\n/g, '\n');
	const signature = crypto.sign('sha256', Buffer.from(data), {key, dsaEncoding: 'ieee-p1363'});
	return `${data}.${b64url(signature)}`;
}

let access = null; // {token, expires}

async function accessToken(env = process.env) {
	if (access && access.expires - Date.now() > 60000) return access.token;
	const res = await fetch(`${BASE}/v1/token`, {
		headers: {Authorization: `Bearer ${signAuthToken(env)}`},
		signal: AbortSignal.timeout(8000),
	});
	if (!res.ok) throw new Error(`Apple Maps token: HTTP ${res.status}`);
	const data = await res.json();
	access = {token: data.accessToken, expires: Date.now() + (data.expiresInSeconds || 1800) * 1000};
	return access.token;
}

async function call(path, params, env) {
	const url = new URL(path, BASE);
	for (const [k, v] of Object.entries(params)) if (v != null) url.searchParams.set(k, String(v));
	const res = await fetch(url, {
		headers: {Authorization: `Bearer ${await accessToken(env)}`},
		signal: AbortSignal.timeout(8000),
	});
	if (!res.ok) throw new Error(`Apple Maps ${path}: HTTP ${res.status}`);
	return res.json();
}

/* Addresses don't move, so each is looked up once per server instance. */
const geocodeCache = new Map();

async function geocode(address, env = process.env) {
	const key = address.trim().toLowerCase();
	if (geocodeCache.has(key)) return geocodeCache.get(key);
	const data = await call('/v1/geocode', {q: address, limitToCountries: 'NL', lang: 'nl-NL'}, env);
	const c = data.results?.[0]?.coordinate;
	if (!c) throw new Error(`Apple Maps couldn't find "${address}"`);
	const point = {lat: c.latitude, lng: c.longitude};
	geocodeCache.set(key, point);
	return point;
}

/* Public transport travel time, arriving by a given moment. No line details:
   Apple's server API only returns a duration for transit. */
async function transitMinutes(from, to, arriveBy, env = process.env) {
	const data = await call(
		'/v1/etas',
		{
			origin: `${from.lat},${from.lng}`,
			destinations: `${to.lat},${to.lng}`,
			transportType: 'Transit',
			arrivalDate: arriveBy.toISOString().replace(/\.\d{3}Z$/, 'Z'),
		},
		env
	);
	const eta = data.etas?.[0];
	if (!eta) throw new Error('Apple Maps found no transit route');
	return Math.round((eta.expectedTravelTimeSeconds || eta.staticTravelTimeSeconds) / 60);
}

module.exports = {configured, signAuthToken, geocode, transitMinutes};
