/**
 * Tiny Redis client for Upstash's REST API (free tier, added through the
 * Vercel Marketplace). No dependency: every command is one POST.
 *
 * Env: UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN, or the KV_REST_API_URL
 * + KV_REST_API_TOKEN names the Vercel integration sets.
 */

/* Upstash's names depend on how it was connected: UPSTASH_REDIS_REST_*,
   KV_REST_API_*, or the same with a custom prefix (STORAGE_KV_REST_API_URL…).
   Any matching pair works; the read-only token is never picked. */
function config(env = process.env) {
	const find = (patterns) => {
		for (const re of patterns) {
			const name = Object.keys(env).find((k) => re.test(k) && env[k] && !/READ_ONLY/i.test(k));
			if (name) return env[name];
		}
		return '';
	};
	const url = find([/^UPSTASH_REDIS_REST_URL$/, /^KV_REST_API_URL$/, /(^|_)REDIS_REST_URL$/, /(^|_)KV_REST_API_URL$/]);
	const token = find([/^UPSTASH_REDIS_REST_TOKEN$/, /^KV_REST_API_TOKEN$/, /(^|_)REDIS_REST_TOKEN$/, /(^|_)KV_REST_API_TOKEN$/]);
	return url && token ? {url: url.replace(/\/$/, ''), token} : null;
}

async function redis(command, env = process.env) {
	const cfg = config(env);
	if (!cfg) throw new Error('storage not configured (UPSTASH_REDIS_REST_URL / _TOKEN)');
	const res = await fetch(cfg.url, {
		method: 'POST',
		headers: {Authorization: `Bearer ${cfg.token}`, 'Content-Type': 'application/json'},
		body: JSON.stringify(command),
		signal: AbortSignal.timeout(8000),
	});
	const data = await res.json().catch(() => ({}));
	if (!res.ok || data.error) throw new Error(`storage: ${data.error || `HTTP ${res.status}`}`);
	return data.result;
}

/* Parcels live in one hash, keyed by carrier + tracking code. */
async function getParcels(env) {
	const flat = (await redis(['HGETALL', 'parcels'], env)) || [];
	const out = [];
	for (let i = 0; i < flat.length; i += 2) {
		try {
			out.push(JSON.parse(flat[i + 1]));
		} catch {
			/* skip a damaged entry */
		}
	}
	return out;
}

async function putParcel(parcel, env) {
	await redis(['HSET', 'parcels', parcel.key, JSON.stringify(parcel)], env);
}

async function deleteParcels(keys, env) {
	if (keys.length) await redis(['HDEL', 'parcels', ...keys], env);
}

/* The last 25 emails that came in and what happened to them, newest first. */
async function logInbound(entry, env) {
	await redis(['LPUSH', 'inbound:log', JSON.stringify(entry)], env);
	await redis(['LTRIM', 'inbound:log', '0', '24'], env);
}

async function readLog(env) {
	const rows = (await redis(['LRANGE', 'inbound:log', '0', '24'], env)) || [];
	return rows.map((r) => {
		try {
			return JSON.parse(r);
		} catch {
			return null;
		}
	}).filter(Boolean);
}

module.exports = {config, redis, getParcels, putParcel, deleteParcels, logInbound, readLog};
