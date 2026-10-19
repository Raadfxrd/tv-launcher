/**
 * What's popular on each streaming service in the Netherlands right now, from
 * TMDB, for the launcher's top shelf: rest on Netflix and the top half of the
 * screen shows what's big on Netflix NL, with large backdrops.
 *
 * Services are found by TMDB's own provider names for region NL (so a change
 * of id on TMDB's side doesn't break anything); "with Ads" tiers are ignored.
 *
 * Env: TMDB_API_KEY (same as home-dashboard), TMDB_LANGUAGE (optional).
 */

const BASE = 'https://api.themoviedb.org/3';
const IMAGE = 'https://image.tmdb.org/t/p/w1280';
const REGION = 'NL';

// Launcher key → TMDB provider names, in order of preference.
const SERVICES = {
	apple: ['Apple TV+', 'Apple TV Plus', 'Apple TV'],
	netflix: ['Netflix'],
	disney: ['Disney Plus', 'Disney+'],
	prime: ['Amazon Prime Video', 'Prime Video'],
	hbo: ['HBO Max', 'Max'],
	crunchyroll: ['Crunchyroll'],
};

const PER_SERVICE = 8;

/* Picks each service's provider id from TMDB's list of providers in NL. */
function matchProviders(providers) {
	const byName = new Map();
	for (const p of providers) {
		const name = String(p.provider_name || '').trim().toLowerCase();
		if (!name || /with ads|amazon channel|apple tv channel/i.test(name)) continue;
		if (!byName.has(name)) byName.set(name, p.provider_id);
	}
	const ids = {};
	for (const [key, names] of Object.entries(SERVICES)) {
		const hit = names.map((n) => byName.get(n.toLowerCase())).find((id) => id != null);
		if (hit != null) ids[key] = hit;
	}
	return ids;
}

/* Films and series together, most popular first, only ones with a backdrop. */
function mergeTitles(tv = [], movies = []) {
	const seen = new Set();
	return [...tv.map((t) => ({...t, kind: 'series'})), ...movies.map((m) => ({...m, kind: 'film'}))]
		.filter((t) => t.backdrop_path && (t.name || t.title))
		.sort((a, b) => (b.popularity || 0) - (a.popularity || 0))
		.filter((t) => {
			const key = `${t.kind}:${t.id}`;
			return seen.has(key) ? false : seen.add(key);
		})
		.slice(0, PER_SERVICE)
		.map((t) => ({
			title: t.name || t.title,
			kind: t.kind,
			year: String(t.first_air_date || t.release_date || '').slice(0, 4) || null,
			backdrop: `${IMAGE}${t.backdrop_path}`,
		}));
}

async function tmdb(path, params, env) {
	const url = new URL(`${BASE}${path}`);
	url.searchParams.set('api_key', env.TMDB_API_KEY);
	for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
	const res = await fetch(url, {signal: AbortSignal.timeout(8000)});
	if (!res.ok) throw new Error(`TMDB ${path}: HTTP ${res.status}`);
	return res.json();
}

async function loadTrending(env = process.env) {
	if (!env.TMDB_API_KEY) return {configured: false, services: {}};
	const language = env.TMDB_LANGUAGE || 'en-US';
	const [tvProviders, movieProviders] = await Promise.all([
		tmdb('/watch/providers/tv', {watch_region: REGION, language}, env),
		tmdb('/watch/providers/movie', {watch_region: REGION, language}, env),
	]);
	const ids = matchProviders([...(tvProviders.results || []), ...(movieProviders.results || [])]);
	const services = {};
	await Promise.all(
		Object.entries(ids).map(async ([key, id]) => {
			const common = {
				with_watch_providers: id,
				watch_region: REGION,
				with_watch_monetization_types: 'flatrate',
				sort_by: 'popularity.desc',
				'vote_count.gte': 30,
				language,
			};
			const [tv, movies] = await Promise.all([
				tmdb('/discover/tv', common, env).catch(() => ({results: []})),
				tmdb('/discover/movie', common, env).catch(() => ({results: []})),
			]);
			services[key] = mergeTitles(tv.results, movies.results);
		})
	);
	return {configured: true, region: REGION, services};
}

module.exports = {loadTrending, matchProviders, mergeTitles, SERVICES};
