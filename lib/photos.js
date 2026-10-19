/**
 * Screensaver photos from an Unsplash collection: bookmark a photo into the
 * collection on your phone and it shows up on the TV. Unsplash crops and
 * scales each photo to 1920×1080 on its own servers, so the TV only ever
 * loads a ready-to-show JPEG.
 *
 * Env: UNSPLASH_ACCESS_KEY, UNSPLASH_COLLECTION_ID.
 * Unsplash asks for the photographer to be credited, so every photo comes
 * with a name and a link.
 */

const PER_PAGE = 30;
const MAX_PAGES = 4;

function sized(rawUrl) {
	const url = new URL(rawUrl);
	url.searchParams.set('w', '1920');
	url.searchParams.set('h', '1080');
	url.searchParams.set('fit', 'crop');
	url.searchParams.set('crop', 'entropy');
	url.searchParams.set('fm', 'jpg');
	url.searchParams.set('q', '80');
	return url.toString();
}

function toPhoto(p) {
	return {
		id: p.id,
		url: sized(p.urls.raw),
		color: p.color || '#000000',
		alt: p.alt_description || p.description || '',
		credit: {name: p.user?.name || 'Unknown', link: `${p.user?.links?.html || 'https://unsplash.com'}?utm_source=tv-launcher&utm_medium=referral`},
	};
}

async function loadPhotos(env = process.env) {
	const key = env.UNSPLASH_ACCESS_KEY;
	const collection = env.UNSPLASH_COLLECTION_ID;
	if (!key || !collection) return {configured: false, photos: []};
	const photos = [];
	for (let page = 1; page <= MAX_PAGES; page++) {
		const res = await fetch(`https://api.unsplash.com/collections/${encodeURIComponent(collection)}/photos?per_page=${PER_PAGE}&page=${page}&orientation=landscape`, {
			headers: {Authorization: `Client-ID ${key}`, 'Accept-Version': 'v1'},
			signal: AbortSignal.timeout(10000),
		});
		if (!res.ok) throw new Error(`Unsplash answered HTTP ${res.status}`);
		const batch = await res.json();
		photos.push(...batch.map(toPhoto));
		if (batch.length < PER_PAGE) break;
	}
	return {configured: true, photos};
}

module.exports = {loadPhotos, toPhoto, sized};
