# Session Clock

[![CI](https://github.com/latiryni-gilbert/session-clock/actions/workflows/ci.yml/badge.svg)](https://github.com/latiryni-gilbert/session-clock/actions/workflows/ci.yml)

A web app that shows which trading sessions are open right now, and when the next ones open, in your local time.

**Live: [sessionclock.vercel.app](https://sessionclock.vercel.app/)**

![Session Clock showing a live clock, a 24-hour timeline and the session list](docs/screenshot.png)

## Features

- **Clock** with your detected time zone.
- **24-hour timeline** for your local day, with a moving "now" line. Overnight sessions are split at midnight, and active sessions are brighter.
- **Session list with live status:** "Active - ends in 1h 12m", "Opens in 3h 05m", or "Opens Sun 18:00" when the next open is more than a day away. Active sessions come first.
- **NYSE holidays and early closes:** on a closed day the NYSE row says why ("Closed - Thanksgiving Day") and still shows the next open. Early closes (13:00 ET) get a tag and a marker on the timeline, and a note warns when tomorrow is a holiday or an early close.
- **Presets:** Forex (Sydney, Tokyo, London, New York), NYSE regular hours, CME equity futures, and ICT killzones (Asian, London, New York AM, New York PM).
- **Custom windows:** add, edit and delete your own, each with its own time zone, days and color. Show or hide any window or group.
- **In-page alerts:** get a banner (and a quiet chime) 5, 15 or 30 minutes before a window opens. If the page was asleep, it catches up when you come back.
- **US news events:** CPI, jobs report (NFP), PPI and FOMC rate decisions are marked on the timeline, and a "Next event" line under the clock counts down to the next one, with a link to the full calendar on ForexFactory. FOMC meetings that publish projections are noted. Switch it off, or get an alert 5, 15 or 30 minutes before, in the settings.
- **Installable and offline:** install it like an app on your phone or computer. After the first visit it opens without a connection, and it asks before switching to a new version.
- **Desktop notifications:** optional, and only asked for when you turn them on. They are sent when the tab is in the background.

## News event data

News events come from the official BLS (CPI, Employment Situation, PPI) and Federal Reserve (FOMC) schedules, USD events only, entered through 2027 in `src/config/newsEvents.ts`. Times are New York time and are converted to yours. Nothing is fetched from ForexFactory; the link just opens its calendar in a new tab. A test fails when the data gets within 60 days of running out, as a reminder to add the next year.

## Install it

Open **[sessionclock.vercel.app](https://sessionclock.vercel.app/)** first, then:

- **iPhone or iPad (Safari):** tap the Share button, choose **Add to Home Screen**, then **Add**. Use Safari for the most reliable result; other iPhone browsers may not offer it.
- **Android (Chrome):** open the menu (⋮) and choose **Install app** (or **Add to Home screen**).
- **Desktop (Chrome or Edge):** click the install icon at the right end of the address bar, or open the menu and choose **Install Session Clock**. Safari 17 or later on a Mac: **File > Add to Dock**.

Once installed it opens in its own window without browser controls, and it keeps working offline. When a new version is released, a small "Update available" bar appears at the bottom; choose **Reload** to switch to it now, or dismiss it and the new version is used the next time you reopen the app.

## Time zones and daylight saving

Every window is defined in its own home time zone (the London session is 08:00 to 17:00 London time) and converted to your browser's zone for the specific date, using Luxon. Daylight-saving changes in either place are therefore handled automatically, and a start time that falls in a spring-forward gap moves to the next valid time. A window that ends before it starts runs past midnight and belongs to the day it starts on.

## Tech stack

React, TypeScript, Vite, Tailwind CSS, Luxon, Vitest and Testing Library, a service worker via vite-plugin-pwa (Workbox), GitHub Actions (CI), and Vercel (hosting).

## Run it locally

You need Node 22 (see `.nvmrc`).

```bash
git clone https://github.com/latiryni-gilbert/session-clock.git
cd session-clock
npm ci
npm run dev
```

Then open the address Vite prints (usually http://localhost:5173).

Other commands:

```bash
npm test         # run the tests once
npm run lint     # lint
npx tsc -b       # type check
npm run build    # production build into dist/
```

## Limitations

- **Alerts only work while the page is open.** There is no background service, so a closed tab means no alert.
- **Preset times are common conventions** and may differ from your source. Check them against your broker or exchange.
- **NYSE holidays and early closes are included through 2027; CME holiday hours are not modeled yet.**
- **Desktop notifications aren't available everywhere:** not on Android Chrome, and not on iPhone Safari outside a Home Screen app. In-page alerts still work there.
- Settings and custom windows are saved in your browser only, so they don't sync between devices.

## Built with AI-assisted development

This project was built with AI-assisted development using [Claude Code](https://claude.com/claude-code).
