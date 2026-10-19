/**
 * Google Maps Platform: finds event addresses (Geocoding API), and plans a
 * public transport route (Routes API) when the NS planner isn't available.
 *
 * Env: GOOGLE_MAPS_API_KEY with the Geocoding API enabled (and the Routes API
 * for the fallback).
 */

const ROUTES_URL = 'https://routes.googleapis.com/directions/v2:computeRoutes';
const FIELDS = ['routes.duration', 'routes.legs.steps.travelMode', 'routes.legs.steps.staticDuration', 'routes.legs.steps.transitDetails'].join(',');

function configured(env = process.env) {
	return Boolean(env.GOOGLE_MAPS_API_KEY);
}

/* Addresses don't move, so each is looked up once per server instance. */
const geocodeCache = new Map();

async function geocode(address, env = process.env) {
	const key = address.trim().toLowerCase();
	if (geocodeCache.has(key)) return geocodeCache.get(key);
	const url = new URL('https://maps.googleapis.com/maps/api/geocode/json');
	url.searchParams.set('address', address);
	url.searchParams.set('region', 'nl');
	url.searchParams.set('key', env.GOOGLE_MAPS_API_KEY);
	const res = await fetch(url, {signal: AbortSignal.timeout(8000)});
	if (!res.ok) throw new Error(`Google geocoding: HTTP ${res.status}`);
	const data = await res.json();
	// A refused key isn't a missing address: pass on Google's own reason.
	if (data.status === 'REQUEST_DENIED' || data.status === 'OVER_QUERY_LIMIT') throw new Error(`Google refused the key: ${data.error_message || data.status}`);
	if (data.status !== 'OK' || !data.results?.length) throw new Error(`Google couldn't find "${address}" (${data.status})`);
	const loc = data.results[0].geometry.location;
	const point = {lat: loc.lat, lng: loc.lng};
	geocodeCache.set(key, point);
	return point;
}

function seconds(duration) {
	return Number(String(duration || '0s').replace(/s$/, '')) || 0;
}

/* A Routes API answer into the legs the card shows: walks merged, rides with
   line, stop and planned times. */
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
			vehicle: String(t.transitLine?.vehicle?.type || 'TRANSIT').toLowerCase().replace('heavy_rail', 'train'),
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

async function transitRoute(from, to, arriveBy, env = process.env) {
	const point = (p) => ({location: {latLng: {latitude: p.lat, longitude: p.lng}}});
	const res = await fetch(ROUTES_URL, {
		method: 'POST',
		headers: {'Content-Type': 'application/json', 'X-Goog-Api-Key': env.GOOGLE_MAPS_API_KEY, 'X-Goog-FieldMask': FIELDS},
		body: JSON.stringify({origin: point(from), destination: point(to), travelMode: 'TRANSIT', arrivalTime: arriveBy.toISOString(), languageCode: 'nl', regionCode: 'nl'}),
		signal: AbortSignal.timeout(10000),
	});
	if (!res.ok) throw new Error(`Google Routes: HTTP ${res.status}`);
	const route = (await res.json()).routes?.[0];
	if (!route) throw new Error('Google found no public transport route');
	return {durationMinutes: Math.round(seconds(route.duration) / 60), legs: parseRoute(route)};
}

module.exports = {configured, geocode, transitRoute, parseRoute};
