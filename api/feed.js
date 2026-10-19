const {loadEvents} = require('../lib/calendar');
const {pickNextUp, parsePlaces} = require('../lib/nextup');
const {tripTo} = require('../lib/travel');
const {loadWeather} = require('../lib/weather');
const {authorised, send, deny} = require('../lib/http');

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

module.exports = async function handler(req, res) {
	if (!authorised(req)) return deny(res);
	const env = process.env;
	const now = new Date();
	const [next, weather] = await Promise.allSettled([nextUp(env, now), loadWeather(env)]);
	send(
		res,
		200,
		{
			generatedAt: now.toISOString(),
			nextUp: next.status === 'fulfilled' ? next.value : {configured: true, error: next.reason?.message || String(next.reason)},
			weather: weather.status === 'fulfilled' ? weather.value : {configured: true, error: weather.reason?.message || String(weather.reason)},
			// Package tracking reads shipping emails; not built yet.
			packages: {configured: false, items: []},
		},
		CACHE_SECONDS
	);
};
