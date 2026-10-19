const google = require('./google');

/**
 * Door-to-door public transport from home to the next event.
 *
 * - Places: Google's Geocoding API turns the event's address into coordinates.
 * - Route: the NS journey planner, from home's coordinates to the event's,
 *   arriving TRAVEL_BUFFER_MIN (default 5) minutes early. It covers trains,
 *   buses, trams, metros and the walks between them, with live delays,
 *   platform changes and cancellations already in the answer.
 * - Without an NS key, Google's Routes API plans the trip instead (same legs,
 *   but without live delays or platforms).
 *
 * Env: HOME_LAT + HOME_LON (or HOME_ADDRESS, geocoded), GOOGLE_MAPS_API_KEY,
 *      NS_API_KEY.
 */

const NS_BASE = 'https://gateway.apiportal.ns.nl/reisinformatie-api/api';

function minutesBetween(a, b) {
	return Math.max(1, Math.round((Date.parse(b) - Date.parse(a)) / 60000));
}

function vehicleOf(leg) {
	const type = String(leg.product?.type || '').toLowerCase();
	if (type) return type; // train, bus, tram, metro, ferry
	const cat = String(leg.product?.shortCategoryName || '').toUpperCase();
	if (/^(SPR|IC|ICD|ICE|EC|THA|ST)$/.test(cat)) return 'train';
	if (cat === 'M') return 'metro';
	return cat ? cat.toLowerCase() : 'transit';
}

/* One NS trip into the legs the card shows. */
function parseNsTrip(trip) {
	const legs = [];
	for (const leg of trip.legs || []) {
		const from = leg.origin || {};
		const to = leg.destination || {};
		if (leg.travelType === 'WALK' || leg.travelType === 'BIKE') {
			const minutes = minutesBetween(from.plannedDateTime, to.plannedDateTime);
			const last = legs[legs.length - 1];
			if (last && last.mode === 'walk') last.minutes += minutes;
			else legs.push({mode: 'walk', minutes, departure: from.plannedDateTime || null});
			continue;
		}
		const planned = from.plannedDateTime || null;
		const actual = from.actualDateTime || null;
		legs.push({
			mode: 'transit',
			vehicle: vehicleOf(leg),
			line: leg.product?.displayName || leg.name || null,
			headsign: leg.direction || null,
			from: from.name || null,
			to: to.name || null,
			departure: planned,
			arrival: to.plannedDateTime || null,
			delayMinutes: planned && actual ? Math.max(0, Math.round((Date.parse(actual) - Date.parse(planned)) / 60000)) : 0,
			cancelled: Boolean(leg.cancelled),
			platform: from.actualTrack || from.plannedTrack || null,
		});
	}
	return legs;
}

/* Of the trips NS offers around the arrival time, take the last one that
   still gets you there in time; if none does, the earliest. */
function chooseTrip(trips, arriveBy) {
	const arrival = (t) => {
		const last = t.legs?.[t.legs.length - 1]?.destination || {};
		return Date.parse(last.actualDateTime || last.plannedDateTime);
	};
	const usable = trips.filter((t) => t.status !== 'CANCELLED' && arrival(t) <= arriveBy.getTime());
	if (usable.length) return usable.sort((a, b) => arrival(b) - arrival(a))[0];
	return [...trips].sort((a, b) => arrival(a) - arrival(b))[0] || null;
}

async function nsTrip(from, to, arriveBy, env) {
	const url = new URL(`${NS_BASE}/v3/trips`);
	url.searchParams.set('originLat', from.lat);
	url.searchParams.set('originLng', from.lng);
	url.searchParams.set('destinationLat', to.lat);
	url.searchParams.set('destinationLng', to.lng);
	url.searchParams.set('dateTime', arriveBy.toISOString());
	url.searchParams.set('searchForArrival', 'true');
	const res = await fetch(url, {headers: {'Ocp-Apim-Subscription-Key': env.NS_API_KEY}, signal: AbortSignal.timeout(10000)});
	if (!res.ok) throw new Error(`NS planner answered HTTP ${res.status}`);
	const trip = chooseTrip((await res.json()).trips || [], arriveBy);
	if (!trip) throw new Error('NS found no route');
	const legs = parseNsTrip(trip);
	const first = trip.legs?.[0]?.origin?.plannedDateTime;
	return {
		leaveAt: first ? new Date(first).toISOString() : null,
		durationMinutes: trip.actualDurationInMinutes || trip.plannedDurationInMinutes,
		disrupted: trip.status && trip.status !== 'NORMAL' ? true : legs.some((l) => l.cancelled || l.delayMinutes >= 2),
		legs,
	};
}

async function home(env) {
	const lat = Number(env.HOME_LAT);
	const lng = Number(env.HOME_LON);
	if (Number.isFinite(lat) && Number.isFinite(lng) && env.HOME_LAT && env.HOME_LON) return {lat, lng};
	if (env.HOME_ADDRESS && google.configured(env)) return google.geocode(env.HOME_ADDRESS, env);
	return null;
}

async function tripTo({address, eventStart, env = process.env}) {
	// Google is needed either way: it's what finds the event's address.
	if (!google.configured(env)) return {configured: false};
	const from = await home(env);
	if (!from) return {configured: false};
	const to = await google.geocode(address, env);
	const buffer = Number(env.TRAVEL_BUFFER_MIN || 5);
	const arriveBy = new Date(Date.parse(eventStart) - buffer * 60000);

	if (env.NS_API_KEY) return {configured: true, ...(await nsTrip(from, to, arriveBy, env))};

	const trip = await google.transitRoute(from, to, arriveBy, env);
	const firstRide = trip.legs.findIndex((l) => l.mode === 'transit');
	let leaveAt = new Date(arriveBy.getTime() - trip.durationMinutes * 60000);
	if (firstRide >= 0 && trip.legs[firstRide].departure) {
		const walkBefore = trip.legs.slice(0, firstRide).reduce((m, l) => m + (l.minutes || 0), 0);
		leaveAt = new Date(Date.parse(trip.legs[firstRide].departure) - walkBefore * 60000);
	}
	return {configured: true, leaveAt: leaveAt.toISOString(), durationMinutes: trip.durationMinutes, disrupted: false, legs: trip.legs};
}

module.exports = {tripTo, parseNsTrip, chooseTrip, vehicleOf};
