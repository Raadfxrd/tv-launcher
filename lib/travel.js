const google = require('./google');

/**
 * Door-to-door public transport from home to the next event.
 *
 * - Places: Google's Geocoding API turns the event's address into coordinates.
 * - Route: NS station to station (nearest station at each end, with the walks
 *   worked out from the distance; live delays, platforms, cancellations) and
 *   Google's Routes API door to door (metro, tram, bus too), asked together;
 *   the one that lets you leave last while arriving by the start wins.
 *   TRAVEL_BUFFER_MIN (default 0) arrives that many minutes early.
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

/* "Sprinter" for trains; "Bus 15", "Tram 2", "Metro 50" for buses, trams
   and metros, where the line number is what you look for at the stop. */
function lineLabel(leg) {
	const p = leg.product || {};
	const name = p.displayName || leg.name || null;
	if (p.lineNumber && vehicleOf(leg) !== 'train' && name && !name.includes(p.lineNumber)) return `${name} ${p.lineNumber}`;
	return name;
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
			line: lineLabel(leg),
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

/* NS wants RFC 3339 in Dutch time: 2026-10-20T08:25:00+02:00 (no milliseconds). */
function nsDateTime(date, timeZone = 'Europe/Amsterdam') {
	const parts = Object.fromEntries(
		new Intl.DateTimeFormat('en-GB', {timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'})
			.formatToParts(date)
			.map((p) => [p.type, p.value])
	);
	const local = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
	const offset = Math.round((local - Math.floor(date.getTime() / 1000) * 1000) / 60000);
	const sign = offset >= 0 ? '+' : '-';
	const hh = String(Math.floor(Math.abs(offset) / 60)).padStart(2, '0');
	const mm = String(Math.abs(offset) % 60).padStart(2, '0');
	return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${sign}${hh}:${mm}`;
}

async function nsTrip(from, to, arriveBy, env) {
	const url = new URL(`${NS_BASE}/v3/trips`);
	url.searchParams.set('originLat', from.lat);
	url.searchParams.set('originLng', from.lng);
	url.searchParams.set('destinationLat', to.lat);
	url.searchParams.set('destinationLng', to.lng);
	url.searchParams.set('dateTime', nsDateTime(arriveBy, env.HOME_TIMEZONE || 'Europe/Amsterdam'));
	url.searchParams.set('searchForArrival', 'true');
	const res = await fetch(url, {headers: {'Ocp-Apim-Subscription-Key': env.NS_API_KEY}, signal: AbortSignal.timeout(10000)});
	if (!res.ok) {
		// NS says what it didn't like; pass that on instead of just the status.
		const body = await res.text().catch(() => '');
		let reason = '';
		try {
			const j = JSON.parse(body);
			reason = j.message || j.errors?.map((e) => e.message || e.reason || JSON.stringify(e)).join('; ') || '';
		} catch {
			reason = body.slice(0, 200);
		}
		throw new Error(`NS planner answered HTTP ${res.status}${reason ? `: ${reason}` : ''}`);
	}
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

/* ---------- NS station to station, with the walks either side ----------
   NS only plans door to door from coordinates with a special key; a normal
   key answers 400. Station to station works with any key, so: nearest station
   to home, nearest to the destination, the NS trip between them, and the
   walks before and after worked out from the distance. */

const STATIONS_URL = 'https://gateway.apiportal.ns.nl/nsapp-stations/v2/nearest';
const WALK_METRES_PER_MIN = 80;   // an easy walking pace
const WALK_DETOUR = 1.3;          // streets aren't straight lines
const MAX_STATION_WALK_MIN = 30;  // further than this, a station trip makes no sense

function metresBetween(a, b) {
	const rad = (d) => (d * Math.PI) / 180;
	const dLat = rad(b.lat - a.lat);
	const dLng = rad(b.lng - a.lng);
	const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
	return 2 * 6371000 * Math.asin(Math.sqrt(h));
}

function walkMinutes(a, b) {
	return Math.max(1, Math.round((metresBetween(a, b) * WALK_DETOUR) / WALK_METRES_PER_MIN));
}

const stationCache = new Map();
async function nearestStation(point, env) {
	const key = `${point.lat.toFixed(4)},${point.lng.toFixed(4)}`;
	if (stationCache.has(key)) return stationCache.get(key);
	const url = new URL(STATIONS_URL);
	url.searchParams.set('lat', point.lat);
	url.searchParams.set('lng', point.lng);
	url.searchParams.set('limit', '1');
	const res = await fetch(url, {headers: {'Ocp-Apim-Subscription-Key': env.NS_API_KEY}, signal: AbortSignal.timeout(8000)});
	if (!res.ok) throw new Error(`NS stations answered HTTP ${res.status}`);
	const s = (await res.json()).payload?.[0];
	if (!s || s.lat == null) throw new Error('NS found no station nearby');
	const station = {code: s.code || s.UICCode, uic: s.UICCode, name: s.namen?.lang || s.namen?.middel || s.code, lat: s.lat, lng: s.lng};
	stationCache.set(key, station);
	return station;
}

async function nsStationTrip(from, to, arriveBy, env) {
	const [a, b] = await Promise.all([nearestStation(from, env), nearestStation(to, env)]);
	if (a.code === b.code) throw new Error('same station at both ends');
	const walkTo = walkMinutes(from, a);
	const walkFrom = walkMinutes(b, to);
	if (walkTo > MAX_STATION_WALK_MIN || walkFrom > MAX_STATION_WALK_MIN) throw new Error('no station within walking distance');
	const atStationBy = new Date(arriveBy.getTime() - walkFrom * 60000);

	const url = new URL(`${NS_BASE}/v3/trips`);
	url.searchParams.set('fromStation', a.code);
	url.searchParams.set('toStation', b.code);
	url.searchParams.set('dateTime', nsDateTime(atStationBy, env.HOME_TIMEZONE || 'Europe/Amsterdam'));
	url.searchParams.set('searchForArrival', 'true');
	const res = await fetch(url, {headers: {'Ocp-Apim-Subscription-Key': env.NS_API_KEY}, signal: AbortSignal.timeout(10000)});
	if (!res.ok) {
		const body = await res.text().catch(() => '');
		let reason = '';
		try { reason = JSON.parse(body).message || ''; } catch { reason = body.slice(0, 200); }
		throw new Error(`NS planner answered HTTP ${res.status}${reason ? `: ${reason}` : ''}`);
	}
	const trip = chooseTrip((await res.json()).trips || [], atStationBy);
	if (!trip) throw new Error('NS found no route');

	const rides = parseNsTrip(trip);
	const firstDeparture = trip.legs?.[0]?.origin?.actualDateTime || trip.legs?.[0]?.origin?.plannedDateTime;
	const lastLeg = trip.legs?.[trip.legs.length - 1]?.destination || {};
	const trainArrival = lastLeg.actualDateTime || lastLeg.plannedDateTime;
	if (!firstDeparture || !trainArrival) throw new Error('NS trip without times');
	const leaveAt = new Date(Date.parse(firstDeparture) - walkTo * 60000);
	const arrival = new Date(Date.parse(trainArrival) + walkFrom * 60000);
	return {
		leaveAt: leaveAt.toISOString(),
		arriveAt: arrival.toISOString(),
		durationMinutes: Math.round((arrival - leaveAt) / 60000),
		disrupted: trip.status && trip.status !== 'NORMAL' ? true : rides.some((l) => l.cancelled || l.delayMinutes >= 2),
		legs: [{mode: 'walk', minutes: walkTo, to: a.name}, ...rides, {mode: 'walk', minutes: walkFrom, from: b.name}],
	};
}

/* Of the trips that get there in time, the one that lets you leave last;
   if none does, the one that arrives first. */
function bestTrip(candidates, arriveBy) {
	const valid = candidates.filter((c) => c && c.leaveAt);
	const arrives = (c) => Date.parse(c.arriveAt || new Date(Date.parse(c.leaveAt) + c.durationMinutes * 60000).toISOString());
	const inTime = valid.filter((c) => arrives(c) <= arriveBy.getTime() + 60000);
	if (inTime.length) return inTime.sort((x, y) => Date.parse(y.leaveAt) - Date.parse(x.leaveAt))[0];
	return valid.sort((x, y) => arrives(x) - arrives(y))[0] || null;
}

async function googleTrip(from, to, arriveBy, env) {
	const trip = await google.transitRoute(from, to, arriveBy, env);
	const firstRide = trip.legs.findIndex((l) => l.mode === 'transit');
	let leaveAt = new Date(arriveBy.getTime() - trip.durationMinutes * 60000);
	if (firstRide >= 0 && trip.legs[firstRide].departure) {
		const walkBefore = trip.legs.slice(0, firstRide).reduce((m, l) => m + (l.minutes || 0), 0);
		leaveAt = new Date(Date.parse(trip.legs[firstRide].departure) - walkBefore * 60000);
	}
	const arriveAt = new Date(leaveAt.getTime() + trip.durationMinutes * 60000);
	return {leaveAt: leaveAt.toISOString(), arriveAt: arriveAt.toISOString(), durationMinutes: trip.durationMinutes, disrupted: false, legs: trip.legs};
}

async function tripTo({address, eventStart, env = process.env}) {
	// Google is needed either way: it's what finds the event's address.
	if (!google.configured(env)) return {configured: false};
	const from = await home(env);
	if (!from) return {configured: false};
	const to = await google.geocode(address, env);
	const buffer = Number(env.TRAVEL_BUFFER_MIN ?? 0);
	const arriveBy = new Date(Date.parse(eventStart) - buffer * 60000);

	// Ask NS (station to station, live delays) and Google (door to door, also
	// metro/tram/bus) at the same time, and take whichever lets you leave last
	// while still arriving in time. In Amsterdam that's often the metro; to
	// Haarlem the Sprinter.
	const tries = [];
	if (env.NS_API_KEY) tries.push(nsStationTrip(from, to, arriveBy, env).then((t) => ({...t, source: 'ns'})));
	if (env.NS_API_KEY && env.NS_DOOR_TO_DOOR === '1') tries.push(nsTrip(from, to, arriveBy, env).then((t) => ({...t, source: 'ns-door'})));
	tries.push(googleTrip(from, to, arriveBy, env).then((t) => ({...t, source: 'google'})));
	const settled = await Promise.allSettled(tries);
	const found = settled.filter((r) => r.status === 'fulfilled').map((r) => r.value);
	const failed = settled.filter((r) => r.status === 'rejected').map((r) => r.reason?.message || String(r.reason));
	const best = bestTrip(found, arriveBy);
	if (!best) throw new Error(failed.join('; ') || 'no route found');
	return {configured: true, ...best, ...(failed.length ? {otherErrors: failed} : {})};
}

module.exports = {tripTo, parseNsTrip, chooseTrip, vehicleOf, nsDateTime, bestTrip, walkMinutes};
