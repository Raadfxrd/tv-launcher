/**
 * Door-to-door public transport from home to the next event.
 *
 * Route: Google Routes API (travelMode TRANSIT), asking for a trip that
 * arrives TRAVEL_BUFFER_MIN (default 5) minutes before the event starts.
 * Trains are then checked against the NS departures board, which knows about
 * delays and cancellations that the planned route doesn't.
 *
 * Env: GOOGLE_MAPS_API_KEY (Routes API enabled), HOME_ADDRESS,
 *      NS_API_KEY (optional, NS API portal "Ns-App" subscription).
 */

const ROUTES_URL = 'https://routes.googleapis.com/directions/v2:computeRoutes';
const FIELDS = [
	'routes.duration',
	'routes.legs.steps.travelMode',
	'routes.legs.steps.staticDuration',
	'routes.legs.steps.transitDetails',
].join(',');
const NS_BASE = 'https://gateway.apiportal.ns.nl/reisinformatie-api/api';

function seconds(duration) {
	return Number(String(duration || '0s').replace(/s$/, '')) || 0;
}

/* Turns a Routes API response into the legs the card shows: walks merged,
   rides with line, stop and planned times. */
function parseRoute(route) {
	const steps = route?.legs?.flatMap((l) => l.steps || []) || [];
	const legs = [];
	for (const step of steps) {
		if (step.travelMode === 'WALK') {
			const min = seconds(step.staticDuration) / 60;
			const last = legs[legs.length - 1];
			if (last && last.mode === 'walk') last.minutes += min;
			else legs.push({mode: 'walk', minutes: min});
			continue;
		}
		const t = step.transitDetails;
		if (!t) continue;
		legs.push({
			mode: 'transit',
			vehicle: String(t.transitLine?.vehicle?.type || 'TRANSIT').toLowerCase(),
			line: t.transitLine?.nameShort || t.transitLine?.name || null,
			headsign: t.headsign || null,
			from: t.stopDetails?.departureStop?.name || null,
			to: t.stopDetails?.arrivalStop?.name || null,
			departure: t.stopDetails?.departureTime || null,
			arrival: t.stopDetails?.arrivalTime || null,
			delayMinutes: 0,
			cancelled: false,
			platform: null,
		});
	}
	for (const leg of legs) if (leg.mode === 'walk') leg.minutes = Math.max(1, Math.round(leg.minutes));
	return legs;
}

async function planRoute({origin, destination, arriveBy, apiKey}) {
	const res = await fetch(ROUTES_URL, {
		method: 'POST',
		headers: {'Content-Type': 'application/json', 'X-Goog-Api-Key': apiKey, 'X-Goog-FieldMask': FIELDS},
		body: JSON.stringify({
			origin: {address: origin},
			destination: {address: destination},
			travelMode: 'TRANSIT',
			arrivalTime: arriveBy.toISOString(),
			languageCode: 'nl',
			regionCode: 'nl',
		}),
		signal: AbortSignal.timeout(10000),
	});
	if (!res.ok) throw new Error(`Routes API answered HTTP ${res.status}`);
	const data = await res.json();
	const route = data.routes?.[0];
	if (!route) throw new Error('no public transport route found');
	return {durationMinutes: Math.round(seconds(route.duration) / 60), legs: parseRoute(route)};
}

/* NS: station code by name, then the departures board for that station. */
const stationCache = new Map();

async function nsStationCode(name, apiKey) {
	const key = name.toLowerCase();
	if (stationCache.has(key)) return stationCache.get(key);
	const query = name.replace(/^station\s+/i, '');
	const res = await fetch(`${NS_BASE}/v2/stations?q=${encodeURIComponent(query)}&limit=1`, {
		headers: {'Ocp-Apim-Subscription-Key': apiKey},
		signal: AbortSignal.timeout(8000),
	});
	if (!res.ok) throw new Error(`NS stations answered HTTP ${res.status}`);
	const data = await res.json();
	const code = data.payload?.[0]?.code || null;
	stationCache.set(key, code);
	return code;
}

/* Finds the planned train on the board and copies delay, platform and
   cancellation onto the leg. Leaves the leg alone when it can't match. */
async function enrichTrain(leg, apiKey) {
	if (leg.mode !== 'transit' || !/rail|train/.test(leg.vehicle) || !leg.from || !leg.departure) return;
	const code = await nsStationCode(leg.from, apiKey);
	if (!code) return;
	const res = await fetch(`${NS_BASE}/v2/departures?station=${code}&maxJourneys=40`, {
		headers: {'Ocp-Apim-Subscription-Key': apiKey},
		signal: AbortSignal.timeout(8000),
	});
	if (!res.ok) return;
	const data = await res.json();
	const planned = Date.parse(leg.departure);
	const match = (data.payload?.departures || []).find((d) => Math.abs(Date.parse(d.plannedDateTime) - planned) < 60000);
	if (!match) return;
	leg.platform = match.actualTrack || match.plannedTrack || null;
	leg.cancelled = Boolean(match.cancelled);
	if (match.actualDateTime) leg.delayMinutes = Math.max(0, Math.round((Date.parse(match.actualDateTime) - planned) / 60000));
	if (match.product?.shortCategoryName) leg.line = match.product.longCategoryName || match.product.shortCategoryName;
}

/* The whole trip for a destination, with "leave at" worked out from the first
   ride's planned departure minus the walk to it. A delay doesn't move "leave
   at" (trains catch up, and missing it is worse); it flags the trip instead. */
async function tripTo({address, eventStart, env = process.env}) {
	if (!env.GOOGLE_MAPS_API_KEY || !env.HOME_ADDRESS) return {configured: false};
	const buffer = Number(env.TRAVEL_BUFFER_MIN || 5);
	const arriveBy = new Date(Date.parse(eventStart) - buffer * 60000);
	const trip = await planRoute({origin: env.HOME_ADDRESS, destination: address, arriveBy, apiKey: env.GOOGLE_MAPS_API_KEY});
	if (env.NS_API_KEY) {
		await Promise.all(trip.legs.map((leg) => enrichTrain(leg, env.NS_API_KEY).catch(() => null)));
	}
	const firstRide = trip.legs.findIndex((l) => l.mode === 'transit');
	let leaveAt = new Date(arriveBy.getTime() - trip.durationMinutes * 60000);
	if (firstRide >= 0 && trip.legs[firstRide].departure) {
		const walkBefore = trip.legs.slice(0, firstRide).reduce((m, l) => m + (l.minutes || 0), 0);
		leaveAt = new Date(Date.parse(trip.legs[firstRide].departure) - walkBefore * 60000);
	}
	const disrupted = trip.legs.some((l) => l.cancelled || l.delayMinutes >= 2);
	return {configured: true, leaveAt: leaveAt.toISOString(), durationMinutes: trip.durationMinutes, disrupted, legs: trip.legs};
}

module.exports = {tripTo, parseRoute, seconds};
