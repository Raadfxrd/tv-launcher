const tidal = require('../../lib/tidal');

/* Where TIDAL sends the browser back after login: trades the code for tokens
   and says so, in the same look as the rest. */
function page(title, text, ok) {
	return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>${title}</title><style>
@font-face{font-family:'Iosevka Aile';font-weight:400;src:url('/fonts/iosevka-aile-latin-400-normal.woff2') format('woff2')}
@font-face{font-family:'Iosevka Aile';font-weight:500;src:url('/fonts/iosevka-aile-latin-500-normal.woff2') format('woff2')}
html,body{margin:0;height:100%}body{display:flex;align-items:center;justify-content:center;color:#fff;font:17px/1.5 'Iosevka Aile',system-ui,sans-serif;
background:#1d2a20 url('/docs/forest.jpg') 50% 40%/cover no-repeat}
.card{margin:20px;max-width:460px;padding:30px 32px;border-radius:26px;background:rgba(18,18,18,.3);-webkit-backdrop-filter:blur(16px) saturate(160%);backdrop-filter:blur(16px) saturate(160%);
box-shadow:inset 0 0 0 1px rgba(255,255,255,.16),0 18px 40px -16px rgba(0,0,0,.5)}
h1{margin:0 0 8px;font-size:30px;font-weight:500}p{margin:0;color:rgba(255,255,255,.75)}.dot{display:inline-block;width:12px;height:12px;border-radius:50%;margin-right:10px;background:${ok ? '#9FE3B8' : '#FFC066'}}
</style></head><body><div class="card"><h1><span class="dot"></span>${title}</h1><p>${text}</p></div></body></html>`;
}

module.exports = async function handler(req, res) {
	const q = new URL(req.url, 'http://localhost').searchParams;
	res.setHeader('Content-Type', 'text/html; charset=utf-8');
	res.setHeader('Cache-Control', 'no-store');
	if (q.get('error')) {
		res.statusCode = 400;
		return res.end(page('TIDAL said no', String(q.get('error_description') || q.get('error')).replace(/[<>&]/g, ''), false));
	}
	try {
		await tidal.finishLogin({code: q.get('code'), state: q.get('state')});
		res.statusCode = 200;
		res.end(page('TIDAL connected', 'Your Daily Discovery shows on the Tidal tile within a few minutes. You can close this page.', true));
	} catch (err) {
		res.statusCode = 400;
		res.end(page('Didn’t work', String(err.message).replace(/[<>&]/g, ''), false));
	}
};
