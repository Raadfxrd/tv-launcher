/**
 * What's hot on each streaming service in the Netherlands right now, from
 * TMDB, for the launcher's background: rest on Netflix and the screen shows
 * what people are watching on Netflix NL this week, with large backdrops.
 *
 * "Popular on a service" on its own gives all-time catalogue giants (every
 * service has Law & Order and The Office). So the titles come from TMDB's
 * trending list for this week, and each is checked for being included in the
 * subscription (flatrate) in NL. Only a service with too few of those is
 * topped up with its most popular recent releases.
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
const MIN_TRENDING = 5;       // fewer trending titles than this: top up with recent releases
const TRENDING_PAGES = 3;     // per kind, 20 titles a page
const RECENT_YEARS = 2;       // "recent release" for the top-up

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

function toTitle(t, kind) {
	return {
		title: t.name || t.title,
		kind,
		year: String(t.first_air_date || t.release_date || '').slice(0, 4) || null,
		backdrop: `${IMAGE}${t.backdrop_path}`,
		// Full size, for the TV: Vercel scales it to 1920 wide (see vercel.json).
		original: `https://image.tmdb.org/t/p/original${t.backdrop_path}`,
	};
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
		.map((t) => toTitle(t, t.kind));
}

/**
 * Trending titles (in trending order) that are in a service's subscription in
 * NL. `trending` is [{id, kind, ...tmdb}], `available` maps "kind:id" to the
 * flatrate provider ids in NL.
 */
function pickTrending(trending, available, providerId) {
	return trending
		.filter((t) => t.backdrop_path && (t.name || t.title))
		.filter((t, i, all) => all.findIndex((o) => o.kind === t.kind && o.id === t.id) === i)
		.filter((t) => (available.get(`${t.kind}:${t.id}`) || []).includes(providerId))
		.slice(0, PER_SERVICE)
		.map((t) => toTitle(t, t.kind));
}

/* Trending first, then recent releases to fill up, without repeats. */
function fillUp(trendingTitles, recentTitles) {
	if (trendingTitles.length >= MIN_TRENDING) return trendingTitles;
	const seen = new Set(trendingTitles.map((t) => `${t.kind}:${t.title}`));
	const extra = recentTitles.filter((t) => !seen.has(`${t.kind}:${t.title}`));
	return [...trendingTitles, ...extra].slice(0, PER_SERVICE);
}

async function tmdb(path, params, env) {
	const url = new URL(`${BASE}${path}`);
	url.searchParams.set('api_key', env.TMDB_API_KEY);
	for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
	const res = await fetch(url, {signal: AbortSignal.timeout(8000)});
	if (!res.ok) throw new Error(`TMDB ${path}: HTTP ${res.status}`);
	return res.json();
}

/* Runs fn over items, at most `limit` at a time. */
async function inBatches(items, limit, fn) {
	const out = new Array(items.length);
	let next = 0;
	await Promise.all(
		Array.from({length: Math.min(limit, items.length)}, async () => {
			while (next < items.length) {
				const i = next++;
				out[i] = await fn(items[i]);
			}
		})
	);
	return out;
}

async function trendingThisWeek(env, language) {
	const pages = [];
	for (const kind of ['tv', 'movie']) {
		for (let page = 1; page <= TRENDING_PAGES; page++) {
			pages.push(
				tmdb(`/trending/${kind}/week`, {language, page}, env)
					.then((d) => (d.results || []).map((t) => ({...t, kind: kind === 'tv' ? 'series' : 'film', tmdbKind: kind})))
					.catch(() => [])
			);
		}
	}
	// Interleave series and films by trending rank, so neither crowds the other out.
	const lists = await Promise.all(pages);
	const tv = lists.slice(0, TRENDING_PAGES).flat();
	const movies = lists.slice(TRENDING_PAGES).flat();
	const mixed = [];
	const seen = new Set();
	const add = (t) => {
		// Trending pages shift while they're read, so a title can appear twice.
		const key = `${t.kind}:${t.id}`;
		if (seen.has(key)) return;
		seen.add(key);
		mixed.push(t);
	};
	for (let i = 0; i < Math.max(tv.length, movies.length); i++) {
		if (tv[i]) add(tv[i]);
		if (movies[i]) add(movies[i]);
	}
	return mixed;
}

async function availability(titles, env) {
	const available = new Map();
	await inBatches(titles, 20, async (t) => {
		const d = await tmdb(`/${t.tmdbKind}/${t.id}/watch/providers`, {}, env).catch(() => null);
		const flatrate = d?.results?.[REGION]?.flatrate || [];
		available.set(`${t.kind}:${t.id}`, flatrate.map((p) => p.provider_id));
	});
	return available;
}

async function recentReleases(providerId, env, language, now) {
	const since = new Date(now);
	since.setFullYear(since.getFullYear() - RECENT_YEARS);
	const from = since.toISOString().slice(0, 10);
	const common = {
		with_watch_providers: providerId,
		watch_region: REGION,
		with_watch_monetization_types: 'flatrate',
		sort_by: 'popularity.desc',
		'vote_count.gte': 20,
		language,
	};
	const [tv, movies] = await Promise.all([
		tmdb('/discover/tv', {...common, 'first_air_date.gte': from}, env).catch(() => ({results: []})),
		tmdb('/discover/movie', {...common, 'primary_release_date.gte': from}, env).catch(() => ({results: []})),
	]);
	return mergeTitles(tv.results, movies.results);
}

async function loadTrending(env = process.env, now = new Date()) {
	if (!env.TMDB_API_KEY) return {configured: false, services: {}};
	const language = env.TMDB_LANGUAGE || 'en-US';
	const [tvProviders, movieProviders, trending] = await Promise.all([
		tmdb('/watch/providers/tv', {watch_region: REGION, language}, env),
		tmdb('/watch/providers/movie', {watch_region: REGION, language}, env),
		trendingThisWeek(env, language),
	]);
	const ids = matchProviders([...(tvProviders.results || []), ...(movieProviders.results || [])]);
	const available = await availability(trending, env);
	const services = {};
	await Promise.all(
		Object.entries(ids).map(async ([key, id]) => {
			const hot = pickTrending(trending, available, id);
			services[key] = hot.length >= MIN_TRENDING ? hot : fillUp(hot, await recentReleases(id, env, language, now));
		})
	);
	return {configured: true, region: REGION, services};
}

module.exports = {loadTrending, matchProviders, mergeTitles, pickTrending, fillUp, SERVICES};
