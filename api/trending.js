const {loadTrending} = require('../lib/trending');
const {authorised, send, deny} = require('../lib/http');

/**
 * GET /api/trending?token=…  — what's popular per streaming service in NL, for
 * the launcher's top shelf. Popularity moves slowly, so this is cached for six
 * hours: TMDB is asked a few times a day at most.
 */
module.exports = async function handler(req, res) {
	if (!authorised(req)) return deny(res);
	try {
		send(res, 200, await loadTrending(), 6 * 3600);
	} catch (err) {
		send(res, 200, {configured: true, services: {}, error: err.message}, 300);
	}
};
