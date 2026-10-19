const test = require('node:test');
const assert = require('node:assert/strict');
const {pickNextUp, parsePlaces} = require('../lib/nextup');

// Times are CEST (UTC+2) in October.
const at = (iso) => new Date(iso);
const places = parsePlaces('Reshift=Nijverheidsweg 18, Haarlem;HvA=Wibautstraat, Amsterdam;Home|Thuis|WFH=home');

const week = [
	{id: 'mon', title: 'Work', start: '2026-10-19T07:00:00Z', end: '2026-10-19T15:00:00Z', location: 'Reshift', allDay: false, calendar: 'Work'},
	{id: 'tue-school', title: 'College', start: '2026-10-20T07:00:00Z', end: '2026-10-20T10:00:00Z', location: 'HvA', allDay: false, calendar: 'School'},
	{id: 'tue-wfh', title: 'Work', start: '2026-10-20T11:00:00Z', end: '2026-10-20T15:00:00Z', location: 'Home', allDay: false, calendar: 'Work'},
	{id: 'tue-allday', title: 'Deadline', start: '2026-10-19T22:00:00Z', end: '2026-10-20T22:00:00Z', location: null, allDay: true, calendar: 'Work'},
];

test('Sunday afternoon: nothing today, too early for a preview', () => {
	const r = pickNextUp(week, {now: at('2026-10-18T13:00:00Z'), places});
	assert.equal(r.mode, 'none');
});

test('Sunday 19:00: preview of Monday at Reshift, resolved to the full address', () => {
	const r = pickNextUp(week, {now: at('2026-10-18T17:00:00Z'), places});
	assert.equal(r.mode, 'preview');
	assert.equal(r.event.title, 'Work');
	assert.deepEqual(r.destination, {travel: true, reason: null, address: 'Nijverheidsweg 18, Haarlem', label: 'Reshift'});
});

test('Monday 08:00: live card for Reshift', () => {
	const r = pickNextUp(week, {now: at('2026-10-19T06:00:00Z'), places});
	assert.equal(r.mode, 'live');
	assert.equal(r.destination.address, 'Nijverheidsweg 18, Haarlem');
});

test('Monday 10:00: work has started, preview hour not reached', () => {
	const r = pickNextUp(week, {now: at('2026-10-19T08:00:00Z'), places});
	assert.equal(r.mode, 'none');
});

test('Monday 20:00: preview of HvA, all-day deadline ignored', () => {
	const r = pickNextUp(week, {now: at('2026-10-19T18:00:00Z'), places});
	assert.equal(r.mode, 'preview');
	assert.equal(r.event.calendar, 'School');
	assert.equal(r.destination.address, 'Wibautstraat, Amsterdam');
});

test('Tuesday 12:30: work from home shows without a trip', () => {
	const r = pickNextUp(week, {now: at('2026-10-20T10:30:00Z'), places});
	assert.equal(r.mode, 'live');
	assert.deepEqual(r.destination, {travel: false, reason: 'home', address: null});
});

test('NO_TRAVEL_CARD=hide skips the work-from-home event', () => {
	const r = pickNextUp(week, {now: at('2026-10-20T10:30:00Z'), places, noTravelCard: 'hide'});
	assert.equal(r.mode, 'none');
});

test('online meetings and events without a location never plan a trip', () => {
	const events = [
		{id: 'a', title: 'Standup', start: '2026-10-19T08:00:00Z', end: '2026-10-19T08:15:00Z', location: 'Microsoft Teams Meeting https://teams.microsoft.com/x', allDay: false},
		{id: 'b', title: 'Focus', start: '2026-10-19T09:00:00Z', end: '2026-10-19T10:00:00Z', location: null, allDay: false},
	];
	const now = at('2026-10-19T06:00:00Z');
	assert.equal(pickNextUp(events, {now, places}).destination.reason, 'online');
	assert.equal(pickNextUp(events.slice(1), {now, places}).destination.reason, 'no-location');
});

test('an address that is not a known place is routed as written', () => {
	const events = [{id: 'c', title: 'Dentist', start: '2026-10-19T12:00:00Z', end: '2026-10-19T12:30:00Z', location: 'Grote Markt 1, Haarlem', allDay: false}];
	const r = pickNextUp(events, {now: at('2026-10-19T06:00:00Z'), places});
	assert.equal(r.destination.address, 'Grote Markt 1, Haarlem');
});
