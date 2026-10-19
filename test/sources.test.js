const test = require('node:test');
const assert = require('node:assert/strict');
const {parseRainText, summariseRain} = require('../lib/weather');
const {parseRoute} = require('../lib/travel');
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

test('route: walks merged, ride details kept', () => {
	const legs = parseRoute({
		legs: [
			{
				steps: [
					{travelMode: 'WALK', staticDuration: '120s'},
					{travelMode: 'WALK', staticDuration: '250s'},
					{
						travelMode: 'TRANSIT',
						staticDuration: '1500s',
						transitDetails: {
							stopDetails: {
								departureStop: {name: 'Amsterdam Lelylaan'},
								arrivalStop: {name: 'Haarlem'},
								departureTime: '2026-10-19T06:23:00Z',
								arrivalTime: '2026-10-19T06:38:00Z',
							},
							headsign: 'Haarlem',
							transitLine: {nameShort: 'SPR', vehicle: {type: 'HEAVY_RAIL'}},
						},
					},
					{travelMode: 'WALK', staticDuration: '540s'},
				],
			},
		],
	});
	assert.equal(legs.length, 3);
	assert.deepEqual(legs[0], {mode: 'walk', minutes: 6});
	assert.equal(legs[1].vehicle, 'heavy_rail');
	assert.equal(legs[1].from, 'Amsterdam Lelylaan');
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
