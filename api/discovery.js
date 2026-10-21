const {loadDiscovery} = require('../lib/tidal');
const {authorised, send, deny} = require('../lib/http');

/**
 * GET /api/discovery?token=…  — your TIDAL My Daily Discovery: the mix and its
 * tracks with album covers, for the launcher's Tidal tile. The mix changes
 * once a day, so this is cached for three hours.
 */
module.exports = async function handler(req, res) {
	if (!authorised(req)) return deny(res);
	try {
		const d = await loadDiscovery();
		send(res, 200, d, d.connected ? 3 * 3600 : 0);
	} catch (err) {
		send(res, 200, {configured: true, connected: true, tracks: [], error: err.message}, 300);
	}
};
