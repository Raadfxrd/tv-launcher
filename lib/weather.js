/**
 * Temperature now (Open-Meteo, no key) and rain for the next two hours
 * (Buienradar's rain text, no key), for HOME_LAT / HOME_LON.
 *
 * Buienradar answers lines like "077|14:05": a value from 0 to 255 per five
 * minutes, where rain in mm/h = 10^((value - 109) / 32).
 */

const RAIN_THRESHOLD = 0.1; // mm/h; below this it's dry enough to not care

function parseRainText(text) {
	return String(text)
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean)
		.map((line) => {
			const [value, time] = line.split('|');
			const v = Number(value);
			return {time: (time || '').trim(), mm: v > 0 ? Math.pow(10, (v - 109) / 32) : 0};
		})
		.filter((r) => /^\d{2}:\d{2}$/.test(r.time));
}

/* "dry until 15:00", "rain from 14:20", "rain until 14:45", "dry for 2 hours" */
function summariseRain(rows) {
	if (!rows.length) return null;
	const wet = (r) => r.mm >= RAIN_THRESHOLD;
	if (wet(rows[0])) {
		const stop = rows.find((r) => !wet(r));
		return stop ? {raining: true, text: `rain until ${stop.time}`} : {raining: true, text: 'rain for the next 2 hours'};
	}
	const start = rows.find(wet);
	return start ? {raining: false, text: `dry until ${start.time}`} : {raining: false, text: 'dry for the next 2 hours'};
}

async function loadWeather(env = process.env) {
	const lat = Number(env.HOME_LAT);
	const lon = Number(env.HOME_LON);
	if (!Number.isFinite(lat) || !Number.isFinite(lon)) return {configured: false};
	const [temp, rain] = await Promise.allSettled([
		fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,weather_code&timezone=Europe%2FAmsterdam`, {
			signal: AbortSignal.timeout(8000),
		}).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`Open-Meteo HTTP ${r.status}`)))),
		fetch(`https://gpsgadget.buienradar.nl/data/raintext?lat=${lat.toFixed(2)}&lon=${lon.toFixed(2)}`, {
			signal: AbortSignal.timeout(8000),
		}).then((r) => (r.ok ? r.text() : Promise.reject(new Error(`Buienradar HTTP ${r.status}`)))),
	]);
	return {
		configured: true,
		temperature: temp.status === 'fulfilled' ? Math.round(temp.value.current?.temperature_2m) : null,
		weatherCode: temp.status === 'fulfilled' ? temp.value.current?.weather_code ?? null : null,
		rain: rain.status === 'fulfilled' ? summariseRain(parseRainText(rain.value)) : null,
	};
}

module.exports = {loadWeather, parseRainText, summariseRain};
