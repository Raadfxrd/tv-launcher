const {createDAVClient} = require('tsdav');
const ical = require('node-ical');

/**
 * Upcoming events, read-only. Ported from home-dashboard's calendar route so
 * both projects read the same calendars with the same settings:
 *
 * - iCloud Calendar over CalDAV, signed in with an app-specific password
 *   (appleid.apple.com → Sign-In and Security → App-Specific Passwords).
 * - Optional .ics feeds for calendars iCloud doesn't serve over CalDAV:
 *   CALENDAR_ICS_URLS="School|webcal://…,Work|https://…"
 *
 * The TV only needs today and tomorrow, so the window is two days.
 */

const SKIP = /holidays|feestdagen|siri suggestions|birthdays|verjaardagen/i;
// Locations that are links or calls rather than places.
const ONLINE = /zoom|teams\.microsoft|meet\.google|webex|facetime|whereby|discord|https?:\/\/|\bonline\b|\bremote\b/i;

function settings(env = process.env) {
	return {
		username: env.ICLOUD_USERNAME || '',
		password: env.ICLOUD_APP_PASSWORD || '',
		server: env.ICLOUD_CALDAV_URL || 'https://caldav.icloud.com',
		only: String(env.CALENDAR_NAMES || '')
			.split(',')
			.map((n) => n.trim().toLowerCase())
			.filter(Boolean),
		feeds: String(env.CALENDAR_ICS_URLS || '')
			.split(',')
			.map((entry) => entry.trim())
			.filter(Boolean)
			.map((entry, i) => {
				const bar = entry.indexOf('|');
				const name = bar > 0 ? entry.slice(0, bar).trim() : `Feed ${i + 1}`;
				const url = (bar > 0 ? entry.slice(bar + 1) : entry).trim().replace(/^webcals?:\/\//i, 'https://');
				return {name, url};
			}),
	};
}

/* Vercel runs in UTC, so rather than "midnight today" this takes a generous
   window around now; nextup.js decides what is today in the home time zone. */
function windowRange(now = new Date()) {
	return {start: new Date(now.getTime() - 86400000), end: new Date(now.getTime() + 3 * 86400000)};
}

function clean(text) {
	return String(text?.val ?? text ?? '').replace(/\s+/g, ' ').trim();
}

/* Events from one calendar's iCalendar data within the range. Repeats are
   expanded here (iCloud often ignores the request to expand them), with
   skipped dates left out and moved or edited occurrences applied. */
function eventsFrom(data, calendarName, {start, end}) {
	const parsed = ical.sync.parseICS(data);
	const out = [];
	for (const ev of Object.values(parsed)) {
		if (ev.type !== 'VEVENT' || !ev.start) continue;
		if (String(ev.status || '').toUpperCase() === 'CANCELLED') continue;
		let instances;
		if (ev.rrule) {
			instances = ical.expandRecurringEvent(ev, {from: start, to: end, expandOngoing: true});
		} else {
			const s = ev.start;
			const e = ev.end || new Date(s.getTime() + (ev.datetype === 'date' ? 86400000 : 3600000));
			instances = [{start: s, end: e, summary: ev.summary, isFullDay: ev.datetype === 'date' || s.dateOnly === true, event: ev}];
		}
		for (const inst of instances) {
			const s = new Date(inst.start);
			const e = new Date(inst.end || s.getTime() + 3600000);
			if (e <= start || s >= end) continue;
			const source = inst.event || ev;
			if (String(source.status || '').toUpperCase() === 'CANCELLED') continue;
			const allDay = Boolean(inst.isFullDay);
			const location = clean(source.location);
			out.push({
				id: `${ev.uid || clean(ev.summary)}-${s.getTime()}`,
				title: clean(inst.summary ?? source.summary) || 'Busy',
				start: s.toISOString(),
				end: e.toISOString(),
				location: location || null,
				allDay,
				online: Boolean(location) && ONLINE.test(location),
				calendar: calendarName,
			});
		}
	}
	return out;
}

async function loadICloud(cfg, range) {
	const client = await createDAVClient({
		serverUrl: cfg.server,
		credentials: {username: cfg.username, password: cfg.password},
		authMethod: 'Basic',
		defaultAccountType: 'caldav',
	});
	const calendars = await client.fetchCalendars();
	const lists = await Promise.all(
		calendars.map(async (cal) => {
			const name = clean(cal.displayName) || 'Untitled';
			if (cal.components && !cal.components.includes('VEVENT')) return [];
			if (cfg.only.length ? !cfg.only.includes(name.toLowerCase()) : SKIP.test(name)) return [];
			const objects = await client.fetchCalendarObjects({
				calendar: cal,
				timeRange: {start: range.start.toISOString(), end: range.end.toISOString()},
				expand: true,
			});
			return objects.flatMap((o) => (o.data ? eventsFrom(o.data, name, range) : []));
		})
	);
	return lists.flat();
}

async function loadFeed(feed, range) {
	const res = await fetch(feed.url, {signal: AbortSignal.timeout(15000)});
	if (!res.ok) throw new Error(`${feed.name}: the link answered HTTP ${res.status}`);
	return eventsFrom(await res.text(), feed.name, range);
}

/* Today's and tomorrow's events, sorted, de-duplicated. Each source fails on
   its own; errors are returned next to whatever did load. */
async function loadEvents({env = process.env, now = new Date()} = {}) {
	const cfg = settings(env);
	const configured = Boolean(cfg.username && cfg.password) || cfg.feeds.length > 0;
	if (!configured) return {configured: false, events: [], errors: []};
	const range = windowRange(now);
	const jobs = [];
	if (cfg.username && cfg.password) jobs.push(loadICloud(cfg, range).catch((err) => ({error: `iCloud: ${explain(err)}`})));
	for (const feed of cfg.feeds) jobs.push(loadFeed(feed, range).catch((err) => ({error: err.message})));
	const results = await Promise.all(jobs);
	const errors = results.filter((r) => r && r.error).map((r) => r.error);
	const seen = new Set();
	const events = results
		.filter(Array.isArray)
		.flat()
		.filter((e) => (seen.has(e.id) ? false : seen.add(e.id)))
		.sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
	return {configured: true, events, errors};
}

function explain(err) {
	const status = err.response?.status || (/\b401\b/.test(err.message) ? 401 : null);
	if (status === 401 || /unauthori[sz]ed|invalid credentials/i.test(err.message)) {
		return 'Apple ID or app-specific password was rejected';
	}
	return err.message;
}

module.exports = {loadEvents, eventsFrom, settings, windowRange, ONLINE};
