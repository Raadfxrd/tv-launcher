const crypto = require('node:crypto');
const {redis} = require('./store');

/**
 * TIDAL: your My Daily Discovery mix, for the launcher's Tidal tile.
 *
 * Login is TIDAL's OAuth with PKCE, done once from a browser
 * (/api/tidal/login?token=FEED_TOKEN). The refresh token lands in Upstash and
 * is used from then on; access tokens are refreshed when they run out.
 *
 * Endpoints are TIDAL's v2 API (openapi.tidal.com/v2, JSON:API). Daily
 * Discovery moved in September 2026 from userRecommendations to
 * /userDiscoveryMixes/me, whose items are the mix (a playlist) with tracks.
 *
 * Env: TIDAL_CLIENT_ID, TIDAL_CLIENT_SECRET (developer.tidal.com),
 *      TIDAL_SCOPES (default "user.read recommendations.read playlists.read"),
 *      TIDAL_COUNTRY (default NL).
 */

const LOGIN = 'https://login.tidal.com/authorize';
const TOKEN = 'https://auth.tidal.com/v1/oauth2/token';
const API = 'https://openapi.tidal.com/v2';
const AUTH_KEY = 'tidal:auth';
const PER_MIX = 10;

function configured(env = process.env) {
	return Boolean(env.TIDAL_CLIENT_ID && env.TIDAL_CLIENT_SECRET);
}
function scopes(env) {
	return (env.TIDAL_SCOPES || 'user.read recommendations.read playlists.read').trim();
}
function b64url(buf) {
	return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/* Step 1: where to send the browser, with a PKCE challenge remembered for ten minutes. */
async function loginUrl(redirectUri, env = process.env) {
	const verifier = b64url(crypto.randomBytes(48));
	const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
	const state = b64url(crypto.randomBytes(18));
	await redis(['SET', `tidal:pkce:${state}`, JSON.stringify({verifier, redirectUri}), 'EX', '600'], env);
	const q = new URLSearchParams({
		response_type: 'code',
		client_id: env.TIDAL_CLIENT_ID,
		redirect_uri: redirectUri,
		scope: scopes(env),
		code_challenge: challenge,
		code_challenge_method: 'S256',
		state,
	});
	return `${LOGIN}?${q}`;
}

async function tokenRequest(body, env) {
	const res = await fetch(TOKEN, {
		method: 'POST',
		headers: {'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8'},
		body: new URLSearchParams({client_id: env.TIDAL_CLIENT_ID, client_secret: env.TIDAL_CLIENT_SECRET, scope: scopes(env), ...body}).toString(),
		signal: AbortSignal.timeout(10000),
	});
	const data = await res.json().catch(() => ({}));
	if (!res.ok) throw new Error(`TIDAL login answered HTTP ${res.status}${data.error_description || data.error ? `: ${data.error_description || data.error}` : ''}`);
	return data;
}

async function saveTokens(data, previous = {}, env) {
	const auth = {
		access_token: data.access_token,
		refresh_token: data.refresh_token || previous.refresh_token,
		expires_at: Date.now() + (Number(data.expires_in) || 3600) * 1000 - 60000,
		scope: data.scope || previous.scope || null,
		user: data.user_id || data.user?.userId || previous.user || null,
		connectedAt: previous.connectedAt || new Date().toISOString(),
	};
	await redis(['SET', AUTH_KEY, JSON.stringify(auth)], env);
	return auth;
}

/* Step 2: TIDAL sends the browser back with a code; trade it for tokens. */
async function finishLogin({code, state}, env = process.env) {
	if (!code || !state) throw new Error('TIDAL sent no code back');
	const saved = await redis(['GET', `tidal:pkce:${state}`], env);
	if (!saved) throw new Error('this login link has expired; start again');
	await redis(['DEL', `tidal:pkce:${state}`], env).catch(() => null);
	const {verifier, redirectUri} = JSON.parse(saved);
	const data = await tokenRequest({grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: redirectUri}, env);
	return saveTokens(data, {}, env);
}

async function accessToken(env) {
	const raw = await redis(['GET', AUTH_KEY], env);
	if (!raw) return null;
	const auth = JSON.parse(raw);
	if (auth.access_token && Date.now() < auth.expires_at) return auth.access_token;
	if (!auth.refresh_token) return null;
	const data = await tokenRequest({grant_type: 'refresh_token', refresh_token: auth.refresh_token}, env);
	return (await saveTokens(data, auth, env)).access_token;
}

async function api(path, params, token, env) {
	const url = new URL(`${API}${path}`);
	for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
	const res = await fetch(url, {headers: {Authorization: `Bearer ${token}`, Accept: 'application/vnd.api+json'}, signal: AbortSignal.timeout(10000)});
	if (!res.ok) {
		const j = await res.json().catch(() => null);
		const detail = j?.errors?.[0]?.detail || j?.errors?.[0]?.title || '';
		throw new Error(`TIDAL ${path.split('?')[0]} answered HTTP ${res.status}${detail ? `: ${detail}` : ''}`);
	}
	return res.json();
}

/* The largest artwork file up to 1280 px wide (the TV draws at 1080p). */
function bestFile(artwork) {
	const files = (artwork?.attributes?.files || []).slice().sort((a, b) => (a.meta?.width || 0) - (b.meta?.width || 0));
	return (files.filter((f) => (f.meta?.width || 0) <= 1280).pop() || files.pop())?.href || null;
}

/* JSON:API: tracks, with their artists and their album's cover, from one document. */
function tracksFrom(doc) {
	const included = doc.included || [];
	const find = (type, id) => included.find((r) => r.type === type && r.id === id);
	const rel = (r, name) => r?.relationships?.[name]?.data || [];
	return (doc.data || [])
		.map((ref) => find(ref.type, ref.id) || ref)
		.filter((r) => r.type === 'tracks' && r.attributes)
		.map((t) => {
			const album = rel(t, 'albums').map((a) => find('albums', a.id)).find(Boolean);
			const art = album && rel(album, 'coverArt').map((a) => find('artworks', a.id)).find(Boolean);
			return {
				id: t.id,
				title: t.attributes.title + (t.attributes.version ? ` (${t.attributes.version})` : ''),
				artist: rel(t, 'artists').map((a) => find('artists', a.id)?.attributes?.name).filter(Boolean).join(', ') || null,
				album: album?.attributes?.title || null,
				cover: bestFile(art),
			};
		});
}

async function loadDiscovery(env = process.env) {
	if (!configured(env)) return {configured: false, connected: false, tracks: []};
	const token = await accessToken(env);
	if (!token) return {configured: true, connected: false, tracks: []};
	const country = env.TIDAL_COUNTRY || 'NL';
	const mixes = await api('/userDiscoveryMixes/me', {include: 'items', countryCode: country, locale: 'en-US'}, token, env);
	const ref = mixes.data?.relationships?.items?.data?.[0];
	if (!ref) return {configured: true, connected: true, mix: null, tracks: []};
	const mixInfo = (mixes.included || []).find((r) => r.type === ref.type && r.id === ref.id);

	let doc;
	if (ref.type === 'playlists') {
		doc = await api(`/playlists/${ref.id}/relationships/items`, {include: 'items,items.artists,items.albums,items.albums.coverArt', countryCode: country}, token, env);
	} else {
		// Some mixes may list their tracks directly.
		doc = await api('/userDiscoveryMixes/me/relationships/items', {include: 'items,items.artists,items.albums,items.albums.coverArt', countryCode: country}, token, env);
	}
	const tracks = tracksFrom(doc).filter((t) => t.cover).slice(0, PER_MIX);
	return {
		configured: true,
		connected: true,
		mix: {id: ref.id, type: ref.type, name: mixInfo?.attributes?.name || 'My Daily Discovery', url: ref.type === 'playlists' ? `https://tidal.com/browse/playlist/${ref.id}` : null},
		tracks,
	};
}

module.exports = {configured, loginUrl, finishLogin, loadDiscovery, tracksFrom, bestFile};
