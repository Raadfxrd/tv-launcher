const {loadPhotos} = require('../lib/photos');
const {authorised, send, deny} = require('../lib/http');

/**
 * GET /api/photos?token=…  — the screensaver's photo list. Collections change
 * rarely, so this is cached for an hour.
 */
module.exports = async function handler(req, res) {
	if (!authorised(req)) return deny(res);
	try {
		send(res, 200, await loadPhotos(), 3600);
	} catch (err) {
		send(res, 200, {configured: true, photos: [], error: err.message}, 60);
	}
};
