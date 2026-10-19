const test = require('node:test');
const assert = require('node:assert/strict');
const {normalise, htmlToText, forwardingConfirmation} = require('../lib/mail');
const {validate, merge, forToday, stale} = require('../lib/parcels');

const postnlMail = normalise({
	FromFull: {Email: 'noreply@notificatie.postnl.nl', Name: 'PostNL'},
	Subject: 'Je pakket van Coolblue komt vandaag',
	Date: '2026-10-19T07:12:00+02:00',
	HtmlBody:
		'<p>Goed nieuws! Je pakket komt <b>vandaag</b> tussen 14:00 en 16:30.</p><p>Track &amp; Trace: 3SCOOL1234567</p><a href="https://jouw.postnl.nl/track-and-trace/3SCOOL1234567-NL-1067AB">Volg je pakket</a>',
});

const answer = {
	is_shipment: true,
	carrier: 'postnl',
	tracking_code: '3SCOOL1234567',
	postal_code: '1067 AB',
	shop: 'Coolblue',
	status: 'out_for_delivery',
	expected_date: '2026-10-19',
	window_start: '14:00',
	window_end: '16:30',
	confidence: 0.95,
};
const now = new Date('2026-10-19T08:00:00+02:00');

test('html is turned into text with links kept', () => {
	const text = htmlToText('<p>Hi&nbsp;there</p><a href="https://x.nl/t/ABC">Track</a><style>p{}</style>');
	assert.match(text, /Hi there/);
	assert.match(text, /Track \(https:\/\/x\.nl\/t\/ABC\)/);
	assert.doesNotMatch(text, /p\{\}/);
});

test('postmark payload is normalised', () => {
	assert.equal(postnlMail.from, 'noreply@notificatie.postnl.nl');
	assert.match(postnlMail.text, /3SCOOL1234567/);
});

test('a good reading passes and is cleaned up', () => {
	const r = validate(answer, postnlMail, now);
	assert.equal(r.rejected, undefined);
	assert.equal(r.code, '3SCOOL1234567');
	assert.equal(r.postalCode, '1067AB');
	assert.equal(r.windowStart, '14:00');
});

test('a tracking code that is not in the email is rejected', () => {
	const r = validate({...answer, tracking_code: '3SCOOL7654321'}, postnlMail, now);
	assert.match(r.rejected, /isn't in the email/);
});

test('newsletters, low confidence and odd codes are rejected', () => {
	assert.equal(validate({is_shipment: false, status: 'unknown', confidence: 0.9}, postnlMail, now).rejected, 'not a shipment');
	assert.match(validate({...answer, confidence: 0.3}, postnlMail, now).rejected, /low confidence/);
	assert.match(validate({...answer, tracking_code: 'abc'}, postnlMail, now).rejected, /doesn't look like/);
});

test('implausible dates and windows are dropped, not shown', () => {
	const r = validate({...answer, expected_date: '2027-06-01', window_start: '16:30', window_end: '14:00'}, postnlMail, now);
	assert.equal(r.expectedDate, null);
	assert.equal(r.windowStart, null);
});

test('status only moves forward', () => {
	const first = merge(null, validate(answer, postnlMail, now), postnlMail);
	const late = merge(first, {...validate(answer, postnlMail, now), status: 'shipped'}, postnlMail);
	assert.equal(late.status, 'out_for_delivery');
	const done = merge(late, {...validate(answer, postnlMail, now), status: 'delivered'}, {...postnlMail, date: '2026-10-19T15:02:00+02:00'});
	assert.equal(done.status, 'delivered');
	assert.equal(done.deliveredAt, '2026-10-19T15:02:00+02:00');
});

test('only today matters on the TV', () => {
	const parcels = [
		{key: 'a', carrier: 'postnl', status: 'out_for_delivery', expectedDate: '2026-10-19', windowStart: '14:00', windowEnd: '16:30'},
		{key: 'b', carrier: 'dhl', status: 'shipped', expectedDate: '2026-10-21'},
		{key: 'c', carrier: 'dhl', status: 'delivered', deliveredAt: '2026-10-19T07:48:00+02:00'},
		{key: 'd', carrier: 'dpd', status: 'delivered', deliveredAt: '2026-10-18T11:00:00+02:00'},
	];
	const items = forToday(parcels, now);
	assert.equal(items.length, 2);
	assert.deepEqual(items[0], {carrier: 'DHL', shop: null, status: 'delivered 07:48', window: null, step: 3, verified: true});
	assert.equal(items[1].status, 'out for delivery');
	assert.equal(items[1].window, '14:00–16:30');
	assert.deepEqual(stale(parcels.map((p) => ({...p, updatedAt: now.toISOString()})), now), ['d']);
});

test("Proton's forwarding confirmation is recognised and its link kept", () => {
	const mail = normalise({
		from: 'no-reply@proton.me',
		subject: 'borys wants to forward emails to you',
		html: '<p>Accept forwarding</p><a href="https://account.proton.me/forwarding/accept?token=abc">Accept</a>',
	});
	assert.deepEqual(forwardingConfirmation(mail), {link: 'https://account.proton.me/forwarding/accept?token=abc'});
	assert.equal(forwardingConfirmation(postnlMail), null);
});

test('inbound end to end, with Claude and storage faked', async () => {
	const store = {parcels: {}, log: []};
	const realFetch = global.fetch;
	global.fetch = async (url, opts = {}) => {
		const u = String(url);
		if (u.startsWith('https://api.anthropic.com')) {
			const body = JSON.parse(opts.body);
			assert.equal(body.tool_choice.name, 'record_shipment');
			return new Response(JSON.stringify({content: [{type: 'tool_use', name: 'record_shipment', input: answer}]}));
		}
		const cmd = JSON.parse(opts.body);
		let result = null;
		if (cmd[0] === 'HGETALL') result = Object.entries(store.parcels).flat();
		if (cmd[0] === 'HSET') store.parcels[cmd[2]] = cmd[3];
		if (cmd[0] === 'LPUSH') store.log.unshift(cmd[2]);
		return new Response(JSON.stringify({result}));
	};
	try {
		const {handle} = require('../api/inbound');
		const env = {ANTHROPIC_API_KEY: 'k', UPSTASH_REDIS_REST_URL: 'https://redis.test', UPSTASH_REDIS_REST_TOKEN: 't'};
		const out = await handle(postnlMail, env);
		assert.deepEqual(out, {result: 'parcel', key: 'postnl:3SCOOL1234567', status: 'out_for_delivery'});
		assert.equal(JSON.parse(store.parcels['postnl:3SCOOL1234567']).windowEnd, '16:30');
		assert.match(JSON.parse(store.log[0]).result, /postnl 3SCOOL1234567: out_for_delivery/);
	} finally {
		global.fetch = realFetch;
	}
});
