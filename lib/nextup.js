/**
 * Picks the one event the "Next up" card is about. Pure: no network, no
 * clock of its own, so it can be tested with fixed dates.
 *
 * Rules
 * - All-day events and events that have already started are ignored.
 * - The first remaining event today is shown "live".
 * - With nothing left today, from PREVIEW_HOUR (default 18) the first event
 *   tomorrow is shown as a "preview" (plan your alarm).
 * - Travel is only planned when the event has a location that is a real
 *   place. Online meetings, events without a location, and locations that
 *   mean home ("Home", "Thuis", "WFH") get the card without the trip.
 *   NO_TRAVEL_CARD=hide skips those and looks at the next event instead.
 * - KNOWN_PLACES maps short calendar locations to full addresses, so
 *   "Reshift" never gets geocoded to the wrong Nijverheidsweg:
 *   KNOWN_PLACES="Reshift=Nijverheidsweg 18, Haarlem;HvA=Wibautstraat, Amsterdam;Home|Thuis|WFH=home"
 */

const ONLINE = /zoom|teams\.microsoft|meet\.google|webex|facetime|whereby|discord|https?:\/\/|\bonline\b|\bremote\b/i;
const DEFAULT_HOME_WORDS = ['home', 'thuis', 'wfh', 'work from home', 'thuiswerken'];

function parsePlaces(raw = '') {
	return String(raw)
		.split(';')
		.map((entry) => entry.trim())
		.filter(Boolean)
		.map((entry) => {
			const eq = entry.indexOf('=');
			if (eq < 1) return null;
			const aliases = entry
				.slice(0, eq)
				.split('|')
				.map((a) => a.trim().toLowerCase())
				.filter(Boolean);
			const value = entry.slice(eq + 1).trim();
			return {aliases, home: /^home$/i.test(value), address: /^home$/i.test(value) ? null : value};
		})
		.filter(Boolean);
}

/* Calendar day ("2026-10-19") and hour of a moment, in the home time zone. */
function localDay(date, timeZone) {
	return new Intl.DateTimeFormat('en-CA', {timeZone, year: 'numeric', month: '2-digit', day: '2-digit'}).format(date);
}

function localHour(date, timeZone) {
	return Number(new Intl.DateTimeFormat('en-GB', {timeZone, hour: '2-digit', hourCycle: 'h23'}).format(date));
}

function addDays(dayKey, n) {
	const d = new Date(`${dayKey}T12:00:00Z`);
	d.setUTCDate(d.getUTCDate() + n);
	return d.toISOString().slice(0, 10);
}

/* Where an event takes you: a place to plan a trip to, or no trip and why. */
function destinationOf(event, places) {
	const location = (event.location || '').trim();
	if (!location) return {travel: false, reason: 'no-location', address: null};
	if (ONLINE.test(location)) return {travel: false, reason: 'online', address: null};
	const lower = location.toLowerCase();
	const known = places.find((p) => p.aliases.some((a) => lower === a || lower.startsWith(`${a},`) || lower.startsWith(`${a} `)));
	if (known?.home) return {travel: false, reason: 'home', address: null};
	if (!known && DEFAULT_HOME_WORDS.includes(lower)) return {travel: false, reason: 'home', address: null};
	return {travel: true, reason: null, address: known ? known.address : location, label: known ? location : null};
}

function pickNextUp(events, {now = new Date(), timeZone = 'Europe/Amsterdam', previewHour = 18, places = [], noTravelCard = 'show'} = {}) {
	const today = localDay(now, timeZone);
	const tomorrow = addDays(today, 1);
	const upcoming = events
		.filter((e) => !e.allDay && Date.parse(e.start) > now.getTime())
		.sort((a, b) => Date.parse(a.start) - Date.parse(b.start))
		.map((e) => ({event: e, day: localDay(new Date(e.start), timeZone), destination: destinationOf(e, places)}))
		.filter((c) => noTravelCard !== 'hide' || c.destination.travel);

	const live = upcoming.find((c) => c.day === today);
	if (live) return {mode: 'live', ...shape(live)};
	if (localHour(now, timeZone) >= previewHour) {
		const preview = upcoming.find((c) => c.day === tomorrow);
		if (preview) return {mode: 'preview', ...shape(preview)};
	}
	return {mode: 'none', event: null, destination: null};
}

function shape({event, destination}) {
	return {
		event: {title: event.title, start: event.start, end: event.end, location: event.location, calendar: event.calendar},
		destination,
	};
}

module.exports = {pickNextUp, parsePlaces, destinationOf, localDay, localHour};
