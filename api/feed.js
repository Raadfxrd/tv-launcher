const {loadEvents} = require('../lib/calendar');
const {pickNextUp, parsePlaces} = require('../lib/nextup');
const {tripTo} = require('../lib/travel');
const {loadWeather} = require('../lib/weather');
const {authorised, send, deny} = require('../lib/http');
const {config: storeConfig, getParcels, putParcel} = require('../lib/store');
const {forToday, verifyDhl} = require('../lib/parcels');

/**
 * GET /api/feed?token=…  — everything the screensaver shows, in one answer.
 *
 * Nothing runs on a schedule (Vercel Hobby only allows daily cron jobs):
 * the TV asks every minute or two and the edge cache answers for up to two
 * minutes, so calendar, routes and weather are fetched at most that often,
 * and only while the TV is on. Every part fails on its own: a broken
 * calendar never takes the weather down with it.
 */

const CACHE_SECONDS = 120;

async function nextUp(env, now) {
	const calendar = await loadEvents({env, now});
	if (!calendar.configured) return {configured: false};
	const pick = pickNextUp(calendar.events, {
		now,
		timeZone: env.HOME_TIMEZONE || 'Europe/Amsterdam',
		previewHour: Number(env.PREVIEW_HOUR || 18),
		places: parsePlaces(env.KNOWN_PLACES),
		noTravelCard: env.NO_TRAVEL_CARD || 'show',
	});
	let trip = null;
	if (pick.destination?.travel) {
		trip = await tripTo({address: pick.destination.address, eventStart: pick.event.start, env}).catch((err) => ({
			configured: true,
			error: err.message,
		}));
	}
	return {configured: true, ...pick, trip, errors: calendar.errors};
}

/* Today's parcels. Active DHL parcels are re-checked with DHL at most every
   15 minutes, so "out for delivery" and the window stay current between emails. */
async function packages(env, now) {
	if (!storeConfig(env)) return {configured: false, items: []};
	const parcels = await getParcels(env);
	const due = parcels.filter(
		(p) => p.carrier === 'dhl' && p.status !== 'delivered' && (!p.checkedAt || now - Date.parse(p.checkedAt) > 15 * 60000)
	);
	await Promise.all(
		due.map(async (p) => {
			const fresh = await verifyDhl(p, env).catch(() => p);
			Object.assign(p, fresh);
			await putParcel(p, env).catch(() => null);
		})
	);
	return {
		configured: true,
		items: forToday(parcels, now, env.HOME_TIMEZONE || 'Europe/Amsterdam', {otherDeliveries: env.OTHER_DELIVERIES || 'show'}),
	};
}

module.exports = async function handler(req, res) {
	if (!authorised(req)) return deny(res);
	const env = process.env;
	const now = new Date();
	const [next, weather, parcels] = await Promise.allSettled([nextUp(env, now), loadWeather(env), packages(env, now)]);
	send(
		res,
		200,
		{
			generatedAt: now.toISOString(),
			nextUp: next.status === 'fulfilled' ? next.value : {configured: true, error: next.reason?.message || String(next.reason)},
			weather: weather.status === 'fulfilled' ? weather.value : {configured: true, error: weather.reason?.message || String(weather.reason)},
			packages: parcels.status === 'fulfilled' ? parcels.value : {configured: true, items: [], error: parcels.reason?.message || String(parcels.reason)},
		},
		CACHE_SECONDS
	);
};
