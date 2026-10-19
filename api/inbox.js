const {readLog, getParcels} = require('../lib/store');
const {authorised, send, deny} = require('../lib/http');

/**
 * GET /api/inbox?token=FEED_TOKEN — what the parcel pipeline has seen: the
 * last 25 emails and what happened to each (parcel, ignored and why, Proton's
 * forwarding confirmation link), plus every parcel it's tracking.
 */
module.exports = async function handler(req, res) {
	if (!authorised(req)) return deny(res);
	try {
		const [log, parcels] = await Promise.all([readLog(), getParcels()]);
		send(res, 200, {emails: log, parcels});
	} catch (err) {
		send(res, 200, {error: err.message, emails: [], parcels: []});
	}
};
