# Testing background alerts by hand

Steps for trying [background alerts](../README.md) in a real browser and on a real phone. The automated tests cover the logic; these check the parts only a real browser and push service can: permission prompts, delivery while the app is closed, and operating-system behaviour.

## On a computer

Use Chrome, Edge or Firefox, **not a private/incognito window** (Chrome has no push there).

1. A service worker doesn't run in `npm run dev`, so use a build: put `VITE_PUSH_WORKER_URL=<the Worker's address>` in `.env.local`, then `npm run build && npm run preview` and open the address it prints (a local `wrangler dev` Worker at `http://localhost:8787` works too).
2. Open **Settings > Background alerts (beta)** and press **Enable background alerts**. Choose **Allow** when the browser asks. The section changes to "on".
3. Set an alert on a window (Settings > Alerts), reopen Settings and check it says **Scheduled through …**. Then press **Send test notification**. A "Session Clock" notification should appear within a few seconds, with the app icon. To see that it works without the page: press the button and straight away switch to another tab or app, or close the Session Clock tab. The notification should still arrive. Click it and it brings Session Clock to the front, or opens it.
4. Press the button again straight away: it asks you to wait a minute.
5. Check the edge cases: in the browser's site settings set Notifications to **Block**, reopen Settings and it says alerts stopped. Then **Allow** it again and enable again. **Turn off** returns it to the start.
6. Your operating system can hide notifications (Focus or Do Not Disturb on macOS, Focus assist on Windows): check that if nothing appears.

## On an iPhone or iPad

Use a real device on iOS or iPadOS 16.4 or later. Push does not work in Safari tabs, and the simulator is not a reliable test.

1. Open the live site in **Safari**. In Settings the section says to add Session Clock to your Home Screen first, and there is no Enable button yet. That is the expected behavior outside the Home Screen app.
2. Tap Share, **Add to Home Screen**, **Add**. Then **open it from the new Home Screen icon**.
3. Open **Settings > Background alerts (beta)** and tap **Enable background alerts**. iOS asks to allow notifications: tap **Allow**. (iOS only asks from a tap, which is why it isn't automatic.)
4. Tap **Send test notification**. The notification appears at the top of the screen and in Notification Center. To check it works while the app isn't open, tap the button and then straight away lock the phone, go to the Home Screen, or swipe the app away: the notification should still arrive a few seconds later. Tap it and Session Clock opens.
5. If nothing appears, check *iPhone Settings > Notifications > Sessions* (the app's Home Screen name) and any Focus mode.
