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

Keys you need: a **Google Maps** key with the Geocoding API enabled to find
event addresses, an **NS API** key for the door-to-door route with live
delays, and an **Unsplash** access key plus collection id for photos.

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
- Addresses are found with Google; the route comes from the NS journey
  planner (trains, buses, trams, metros, walks) with live delays, platform
  changes and cancellations; the card turns amber when that happens. Without
  an NS key, Google's Routes API plans the trip instead, without live delays.

## Parcels

Give shops **shipping@borysbabas.dev** when you order. That Proton address
forwards everything to a Postmark inbound address, and Postmark posts each
email to `/api/inbound?token=INBOUND_TOKEN`.

1. Claude reads the email into a fixed form: shipment or not, carrier,
   tracking code, postcode, shop, status, expected day and window.
2. The reading is checked before it's believed: the tracking code must appear
   in the email itself, look like a tracking code, and dates and windows must
   make sense. Low-confidence readings are logged, not shown.
3. DHL parcels are confirmed with DHL's tracking API, and re-checked every
   15 minutes while the TV is on. PostNL follows PostNL's own emails.
4. The TV only shows parcels that matter today: out for delivery, expected
   today, or delivered today.

Many emails about the same parcels (the shop, bol.com, PostNL, all three) are
expected and handled:

- **One parcel per tracking code.** Every email that mentions a code updates
  that one parcel, whoever sent it. Codes that say who their carrier is
  (PostNL's 3S…, DHL's JVGL…/JJD…, UPS's 1Z…) set the carrier themselves.
- **Split orders**: an email with several tracking codes gives several parcels.
- **The same email twice** (a retry, or forwarded from two addresses) is
  recognised by its Message-ID and processed once.
- **Order doesn't matter**: status only moves forward (except a newer "delivery
  failed"; "delivered" is final), and dates and windows come from the newest
  email, so a late "shipped" email can't undo "out for delivery today".
- **A rescheduled day** replaces the old one and clears the old window.
- **Emails at the same moment** about the same parcel wait for each other
  (a short lock per parcel), so neither overwrites the other.
- **Newsletters** to shipping@ are filtered out by keywords before any Claude
  call, so they cost nothing.

Proton first sends a "do you accept forwarding?" email to the Postmark
address. The pipeline keeps its link: open `/api/inbox?token=FEED_TOKEN`,
which also shows the last 25 emails and what happened to each.

For shops that still have info@ or Gmail, add a filtered forward on that
address straight to the Postmark address (one hop; Proton doesn't forward a
forwarded email again). Later, a Proton Mail Bridge poller can post the same
`{from, subject, html, date}` shape to `/api/inbound` instead.

## Not built yet

- **The launcher home screen** (replacing Projectivy).
- **Lite mode**: if the frosted cards stutter on the A1, add `&lite=1` to the
  page URL to drop the blur.

## Tests

```bash
npm install
npm test
```
