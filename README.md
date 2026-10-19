# tv-launcher

A clean, fast, bloat-free setup for a Sony Bravia A1 (Android TV): an ambient
screensaver with rotating photos, a clock, a **Next up** card that plans your
trip to the next calendar event, and a now-playing card. A custom launcher
comes later; until then Projectivy does the home screen.

```
api/            Vercel functions: /api/feed (calendar, route, weather), /api/photos
lib/            the logic behind them, tested in test/
public/         the screensaver page itself (served by Vercel, shown by the TV app)
tv/             Android TV app: screensaver service + preview app, a thin WebView shell
.github/        CI: API tests, and the APK build
```

## How it fits together

The TV app is a WebView that opens `https://<your-vercel-domain>/screensaver/?token=…`.
That page asks `/api/feed` for fresh data every 90 seconds and `/api/photos`
hourly. Nothing runs on a schedule (Vercel Hobby only allows daily cron jobs):
responses are cached at Vercel's edge for two minutes, so the upstream APIs
are hit at most that often, and only while the TV is on. Music comes from the
TV itself through `window.TVBridge`, never through the API.

## Setup

### 1. Vercel

1. Import this repo in Vercel (framework: Other). Every push to `main` deploys.
2. Add the environment variables from `.env.example`. The calendar ones are
   the same names and values as home-dashboard's, so copy `ICLOUD_USERNAME`,
   `ICLOUD_APP_PASSWORD`, `CALENDAR_NAMES` and `CALENDAR_ICS_URLS` across.
3. Generate `FEED_TOKEN` with `openssl rand -hex 24`.
4. Check it: `https://<domain>/api/feed?token=<FEED_TOKEN>`.

Keys you need: a Google Cloud key with the **Routes API** enabled
(`GOOGLE_MAPS_API_KEY`), an **NS API** key for live delays (`NS_API_KEY`,
optional), and an **Unsplash** access key plus collection id for photos.

### 2. GitHub secrets (for the APK)

`FEED_BASE` = `https://<your-vercel-domain>` and `FEED_TOKEN` = the same token.
Push anything under `tv/` and the **TV app** workflow builds
`ambient-<n>.apk`; push a tag (`git tag v0.1.0 && git push --tags`) to attach
it to a release.

### 3. The TV

Developer options on (Settings → Device Preferences → About → tap Build 7×),
USB debugging on, then from a computer on the same network:

```bash
adb connect <tv-ip>:5555
adb shell pm list packages > packages-before.txt     # backup, so everything can be undone

adb install -r ambient-<n>.apk
# let it read what's playing (needed for the music card)
adb shell cmd notification allow_listener com.raadfxrd.tvlauncher/com.raadfxrd.tvlauncher.MediaListener
# make it the screensaver
adb shell settings put secure screensaver_components com.raadfxrd.tvlauncher/.ScreensaverService
adb shell settings put secure screensaver_enabled 1
```

"Ambient" also appears as an app on the TV: it shows the screensaver page
right away (OK reloads it), handy while tweaking the design.

## Next up: the rules

- All-day events and events that have started are ignored.
- The first remaining event today shows **live** with a leave time.
- With nothing left today, from `PREVIEW_HOUR` (18:00) tomorrow's first event
  shows as a **preview**.
- A trip is only planned when the event has a location that's a real place.
  Short names map to addresses through `KNOWN_PLACES`
  (`Reshift=Nijverheidsweg 18, Haarlem;…`), and `Home|Thuis|WFH=home` means no trip.
  So: put `Reshift` in the location on office days, `Home` (or nothing) on
  work-from-home days.
- Online meetings show the event without travel; `NO_TRAVEL_CARD=hide` skips
  them instead.
- Trains on the route are checked against the NS departures board for delays,
  platform changes and cancellations; the card turns amber when that happens.

## Not built yet

- **Packages**: reading shipping emails and tracking PostNL/DHL. The page
  already has the card; `/api/feed` returns `packages.configured: false`.
- **The launcher home screen** (replacing Projectivy).
- **Lite mode**: if the frosted cards stutter on the A1, add `&lite=1` to the
  page URL to drop the blur.

## Tests

```bash
npm install
npm test
```
