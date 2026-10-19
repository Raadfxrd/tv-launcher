const test = require('node:test');
const assert = require('node:assert/strict');
const {parseRainText, summariseRain} = require('../lib/weather');
const {parseNsTrip, chooseTrip} = require('../lib/travel');
const {parseRoute} = require('../lib/google');
const {eventsFrom} = require('../lib/calendar');
const {sized} = require('../lib/photos');
const {authorised} = require('../lib/http');

test('rain text: dry, then rain', () => {
	const rows = parseRainText('000|13:00\n000|13:05\n090|13:10\n120|13:15\n');
	assert.deepEqual(summariseRain(rows), {raining: false, text: 'dry until 13:10'});
});

test('rain text: raining now, stopping later', () => {
	const rows = parseRainText('120|13:00\n110|13:05\n000|13:10\n');
	assert.deepEqual(summariseRain(rows), {raining: true, text: 'rain until 13:10'});
});

test('rain text: dry the whole window', () => {
	assert.equal(summariseRain(parseRainText('000|13:00\n000|13:05\n')).text, 'dry for the next 2 hours');
});

test('NS trip: walks merged, ride details, delay and platform kept', () => {
	const trip = {
		status: 'NORMAL',
		plannedDurationInMinutes: 38,
		legs: [
			{travelType: 'WALK', origin: {plannedDateTime: '2026-10-19T08:17:00+0200'}, destination: {plannedDateTime: '2026-10-19T08:21:00+0200'}},
			{travelType: 'WALK', origin: {plannedDateTime: '2026-10-19T08:21:00+0200'}, destination: {plannedDateTime: '2026-10-19T08:23:00+0200'}},
			{
				travelType: 'PUBLIC_TRANSIT',
				name: 'NS Sprinter 4321',
				direction: 'Haarlem',
				product: {type: 'TRAIN', shortCategoryName: 'SPR', displayName: 'Sprinter'},
				origin: {name: 'Amsterdam Lelylaan', plannedDateTime: '2026-10-19T08:23:00+0200', actualDateTime: '2026-10-19T08:25:00+0200', plannedTrack: '3', actualTrack: '4'},
				destination: {name: 'Haarlem', plannedDateTime: '2026-10-19T08:38:00+0200'},
			},
			{travelType: 'WALK', origin: {plannedDateTime: '2026-10-19T08:38:00+0200'}, destination: {plannedDateTime: '2026-10-19T08:47:00+0200'}},
		],
	};
	const legs = parseNsTrip(trip);
	assert.equal(legs.length, 3);
	assert.equal(legs[0].minutes, 6);
	assert.deepEqual(
		{line: legs[1].line, vehicle: legs[1].vehicle, delay: legs[1].delayMinutes, platform: legs[1].platform, from: legs[1].from},
		{line: 'Sprinter', vehicle: 'train', delay: 2, platform: '4', from: 'Amsterdam Lelylaan'}
	);
	assert.equal(legs[2].minutes, 9);
});

test('NS bus and tram legs show their line number', () => {
	const legs = parseNsTrip({legs: [{
		travelType: 'PUBLIC_TRANSIT',
		product: {type: 'BUS', displayName: 'Bus', lineNumber: '15'},
		origin: {name: 'Anna Blamansingel', plannedDateTime: '2026-10-19T08:10:00+0200'},
		destination: {plannedDateTime: '2026-10-19T08:18:00+0200'},
	}]});
	assert.equal(legs[0].line, 'Bus 15');
	assert.equal(legs[0].vehicle, 'bus');
});

test('NS trip choice: the last one that still arrives in time', () => {
	const t = (arr, status = 'NORMAL') => ({status, legs: [{destination: {plannedDateTime: arr}}]});
	const trips = [t('2026-10-19T08:40:00+0200'), t('2026-10-19T08:50:00+0200'), t('2026-10-19T08:54:00+0200', 'CANCELLED'), t('2026-10-19T09:05:00+0200')];
	const chosen = chooseTrip(trips, new Date('2026-10-19T08:55:00+0200'));
	assert.equal(chosen, trips[1]);
});

test('Google route: walks merged, ride details kept', () => {
	const legs = parseRoute({
		legs: [{steps: [
			{travelMode: 'WALK', staticDuration: '120s'},
			{travelMode: 'WALK', staticDuration: '250s'},
			{travelMode: 'TRANSIT', transitDetails: {
				stopDetails: {departureStop: {name: 'Amsterdam Lelylaan'}, arrivalStop: {name: 'Haarlem'}, departureTime: '2026-10-19T06:23:00Z'},
				transitLine: {nameShort: 'SPR', vehicle: {type: 'HEAVY_RAIL'}},
			}},
			{travelMode: 'WALK', staticDuration: '540s'},
		]}],
	});
	assert.equal(legs.length, 3);
	assert.deepEqual(legs[0], {mode: 'walk', minutes: 6});
	assert.equal(legs[1].vehicle, 'train');
	assert.deepEqual(legs[2], {mode: 'walk', minutes: 9});
});

test('ics: repeating event expanded, cancelled and online handled', () => {
	const ics = [
		'BEGIN:VCALENDAR',
		'BEGIN:VEVENT',
		'UID:work',
		'SUMMARY:Work',
		'LOCATION:Reshift',
		'DTSTART:20261019T070000Z',
		'DTEND:20261019T150000Z',
		'RRULE:FREQ=DAILY;COUNT=3',
		'END:VEVENT',
		'BEGIN:VEVENT',
		'UID:call',
		'SUMMARY:Call',
		'LOCATION:https://meet.google.com/abc',
		'DTSTART:20261019T120000Z',
		'DTEND:20261019T123000Z',
		'END:VEVENT',
		'BEGIN:VEVENT',
		'UID:gone',
		'SUMMARY:Gone',
		'STATUS:CANCELLED',
		'DTSTART:20261019T130000Z',
		'DTEND:20261019T140000Z',
		'END:VEVENT',
		'END:VCALENDAR',
	].join('\r\n');
	const range = {start: new Date('2026-10-18T00:00:00Z'), end: new Date('2026-10-21T00:00:00Z')};
	const events = eventsFrom(ics, 'Test', range);
	assert.equal(events.filter((e) => e.title === 'Work').length, 2);
	assert.equal(events.find((e) => e.title === 'Call').online, true);
	assert.equal(events.some((e) => e.title === 'Gone'), false);
});

test('photo urls are sized for the TV', () => {
	const url = new URL(sized('https://images.unsplash.com/photo-123?ixid=abc'));
	assert.equal(url.searchParams.get('w'), '1920');
	assert.equal(url.searchParams.get('h'), '1080');
	assert.equal(url.searchParams.get('ixid'), 'abc');
});

test('token is required and compared exactly', () => {
	const env = {FEED_TOKEN: 'secret-token'};
	assert.equal(authorised({url: '/api/feed?token=secret-token'}, env), true);
	assert.equal(authorised({url: '/api/feed?token=secret'}, env), false);
	assert.equal(authorised({url: '/api/feed'}, env), false);
	assert.equal(authorised({url: '/api/feed?token='}, {}), false);
});

test('trending: streaming services are found by name, ad tiers skipped', () => {
	const {matchProviders} = require('../lib/trending');
	const ids = matchProviders([
		{provider_id: 1796, provider_name: 'Netflix basic with Ads'},
		{provider_id: 8, provider_name: 'Netflix'},
		{provider_id: 337, provider_name: 'Disney Plus'},
		{provider_id: 2100, provider_name: 'Amazon Prime Video with Ads'},
		{provider_id: 119, provider_name: 'Amazon Prime Video'},
		{provider_id: 350, provider_name: 'Apple TV+'},
		{provider_id: 283, provider_name: 'Crunchyroll'},
	]);
	assert.deepEqual(ids, {apple: 350, netflix: 8, disney: 337, prime: 119, crunchyroll: 283});
});

test('trending: series and films merged by popularity, backdrops required', () => {
	const {mergeTitles} = require('../lib/trending');
	const out = mergeTitles(
		[{id: 1, name: 'Show A', popularity: 50, backdrop_path: '/a.jpg', first_air_date: '2025-03-01'}, {id: 2, name: 'No art', popularity: 99, backdrop_path: null}],
		[{id: 3, title: 'Film B', popularity: 80, backdrop_path: '/b.jpg', release_date: '2026-01-10'}]
	);
	assert.deepEqual(out.map((t) => t.title), ['Film B', 'Show A']);
	assert.equal(out[0].backdrop, 'https://image.tmdb.org/t/p/w1280/b.jpg');
	assert.equal(out[1].year, '2025');
});

test('trending: this week\'s trending titles, kept only where they are in the subscription', () => {
	const {pickTrending} = require('../lib/trending');
	const trending = [
		{id: 10, kind: 'series', name: 'Hot on Netflix', backdrop_path: '/n.jpg', first_air_date: '2026-09-01'},
		{id: 11, kind: 'film', title: 'Rent only', backdrop_path: '/r.jpg', release_date: '2026-08-01'},
		{id: 12, kind: 'series', name: 'Hot on HBO', backdrop_path: '/h.jpg'},
	];
	const available = new Map([['series:10', [8, 337]], ['film:11', []], ['series:12', [1899]]]);
	assert.deepEqual(pickTrending(trending, available, 8).map((t) => t.title), ['Hot on Netflix']);
	assert.deepEqual(pickTrending(trending, available, 1899).map((t) => t.title), ['Hot on HBO']);
});

test('trending: a service with few trending titles is topped up with recent releases, no repeats', () => {
	const {fillUp} = require('../lib/trending');
	const hot = [{title: 'A', kind: 'series'}];
	const recent = [{title: 'A', kind: 'series'}, {title: 'B', kind: 'film'}, {title: 'C', kind: 'series'}];
	assert.deepEqual(fillUp(hot, recent).map((t) => t.title), ['A', 'B', 'C']);
	const plenty = ['1', '2', '3', '4', '5'].map((title) => ({title, kind: 'film'}));
	assert.equal(fillUp(plenty, recent), plenty);
});

test('trending: a title listed twice shows once', () => {
	const {pickTrending} = require('../lib/trending');
	const t = {id: 5, kind: 'series', name: 'Re:ZERO', backdrop_path: '/z.jpg'};
	const out = pickTrending([t, {...t}], new Map([['series:5', [283]]]), 283);
	assert.deepEqual(out.map((x) => x.title), ['Re:ZERO']);
});

test('travel: NS gets Dutch time with its offset, no milliseconds', () => {
	const {nsDateTime} = require('../lib/travel');
	assert.equal(nsDateTime(new Date('2026-10-20T06:25:00.000Z')), '2026-10-20T08:25:00+02:00');   // summer time
	assert.equal(nsDateTime(new Date('2026-12-01T07:00:30.500Z')), '2026-12-01T08:00:30+01:00');   // winter time
});
