# session-clock-push

A small [Cloudflare Worker](https://developers.cloudflare.com/workers/) for Session Clock's push notifications. Today it **stores** push subscriptions and their scheduled alerts in a [D1](https://developers.cloudflare.com/d1/) database, and it can **send Web Push notifications**: a test notification on request, and, from a cron trigger that runs every minute, the alerts that have come due (see [Scheduler](#scheduler)). The web app does not upload schedules yet, so for now there is nothing for the scheduler to send.

It is separate from the web app: its own `package.json`, TypeScript config and tests, and nothing in the app imports it.

## API

All endpoints take and return JSON. Errors look like `{ "ok": false, "error": "<message>" }`. Responses are never cached.

| Request | Success | Errors |
|---|---|---|
| `GET /health` | `200` `{ "ok": true, "service": "session-clock-push", "version": "<git commit sha>", "pushConfigured": true }` (`HEAD` works too) | `405` for other methods |
| `GET /vapid-public-key` | `200` `{ "publicKey": "..." }` | `503` push is not configured |
| `POST /subscribe` | `200` `{ "id": "...", "secret": "..." }` | `400` invalid subscription, `429` too many requests |
| `PUT /schedule` | `200` `{ "ok": true, "scheduled": <count>, "added": <n>, "removed": <n> }`, or `{ "ok": true, "scheduled": <count>, "unchanged": true }` | `401` wrong id/secret, `400` invalid alerts or an upload too big for one day, `409` overlapping upload, `429` too many requests or the daily change cap |
| `POST /unsubscribe` | `200` `{ "ok": true }` | `401` wrong id/secret |
| `POST /test-push` | `200` `{ "ok": true }` | `401` wrong id/secret, `410` the subscription is gone (and was deleted), `422` unusable keys, `429` too many requests, `502` the push service refused or couldn't be reached, `503` push is not configured |
| anything else | | `404` `Not found` |

Any endpoint that uses the database answers `503` with a `Retry-After` header when D1's daily free-tier limit is used up (see [Write budget](#write-budget)). Wrong method on one of the endpoints above is `405` (with an `Allow` header). Any request body must be a JSON object sent as `Content-Type: application/json`: otherwise `415`; malformed JSON or invalid UTF-8 is `400`; over 64 KB is `413`.

### `POST /subscribe`

Send the browser's push subscription as-is (`JSON.stringify(subscription)`):

```json
{ "endpoint": "https://fcm.googleapis.com/fcm/send/...", "expirationTime": null, "keys": { "p256dh": "...", "auth": "..." } }
```

The endpoint must be `https` on a public hostname (no IP address, port, credentials or internal name), at most 2048 characters. The keys are base64url strings.

Returns `{ "id", "secret" }`. **The secret is shown only this once**: the Worker keeps just a hash of it, so keep it in the app's storage next to the id. Subscribing again with the same endpoint (new keys, or the secret was lost) keeps the same `id`, refreshes the keys, keeps the schedule and issues a **new secret; the old one stops working**.

### `PUT /schedule`

```json
{
  "id": "...", "secret": "...",
  "alerts": [{ "fireAt": "2026-10-14T13:20:00Z", "title": "NYSE opens", "body": "in 10 minutes" }]
}
```

Makes the subscription's future alerts match this list. `[]` clears them. Alerts already sent, and unsent alerts that are already due, are left alone.

- At most **500** alerts.
- `fireAt`: ISO 8601 with an explicit offset (`Z` or `-04:00`); stored as UTC. Must be in the future and **within 15 days**. One bad alert rejects the whole request and the message names it (`alerts[3].fireAt is in the past`).
- `title`: 1 to **80** characters. `body`: 0 to **200** characters.
- The whole request body is capped at 64 KB, so 500 alerts fit only if they are short (about 130 bytes each).
- Two alerts with the same `fireAt`, `title` and `body` are the same alert: repeats are collapsed, and `scheduled` counts each once.

To keep D1 writes low (see [Write budget](#write-budget)), the Worker stores a hash of the last schedule it accepted:

- **Same schedule again** (in any order): nothing is written. The response has `"unchanged": true`.
- **Changed schedule**: only the difference is written. Alerts that are no longer in the list are deleted and new ones are inserted (alerts are matched on `fireAt` + `title` + `body`); the rest are not touched. The response says how many were `added` and `removed`.
- So **send the whole schedule every time, and re-sending is free**. Don't send only what changed: anything missing from the list is removed.
- A subscription may have at most **400 alerts added + removed per UTC day** (the [daily cap](#daily-cap-on-alert-changes)). Re-sending an unchanged schedule never counts.
- A changing upload is applied all or nothing. If another upload for the same subscription lands in the middle of it, one of them gets `409`; re-send it.

### `POST /unsubscribe`

```json
{ "id": "...", "secret": "..." }
```

Deletes the subscription and all its alerts.

### Authentication errors

A missing, malformed or wrong `id`/`secret` always returns the same `401` (`Invalid id or secret`), checked before the rest of the request is looked at, so the response never reveals whether an id exists.

### CORS

Browsers may call the API only from `https://sessionclock.vercel.app`, this project's Vercel previews (`https://session-clock-*-latiryni-gilberts-projects.vercel.app`) and `localhost` (any port, http or https). A request carrying any other `Origin` gets `403` and is not processed. Requests with no `Origin` header (curl, servers) are allowed: the secret is what protects a subscription, not CORS. `/health` is unaffected.

### Rate limits

Using [Workers Rate Limiting](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/). A request over the limit gets `429` with `Retry-After: 60` and is not processed. Counters are kept per Cloudflare location, so the limits are approximate, which is fine for guarding against accidents and casual abuse.

| Limit | Per | Why this number |
|---|---|---|
| `POST /subscribe`: **3 a minute** | client IP | A person subscribes once per install. 3 leaves room for a retry or two, or a few devices on one home network, and caps what one address can create at about 4,300 subscriptions a day (about 13,000 rows written, 13% of the daily budget). |
| `PUT /schedule`: **10 a minute** | client IP | The app uploads when it opens and when settings change, and unchanged uploads write nothing. This only bounds reads and CPU (including guessing-style requests with wrong credentials) and leaves room for several devices behind one address. |
| `PUT /schedule` that **changes** something: **2 a minute** | subscription id | This is the one that guards the write budget. A real user changes their alerts a few times a day at most (the app should wait a moment after the last edit before uploading), so a buggy client stuck in a loop of changing uploads is held to about 2,900 a day instead of thousands a minute. The [daily cap](#daily-cap-on-alert-changes) then limits how much those uploads can actually change. Re-sending a schedule that is already stored is not limited by this one. |

| `POST /test-push`: **1 a minute** | subscription id | It is a test button, not a feature the app should call repeatedly. Counted only after the secret checks out. |
| `POST /test-push`: **10 a minute** | client IP | Bounds the database reads that checking credentials costs. |

`POST /unsubscribe` is not limited: it only frees rows. Requests with no client address (only possible outside Cloudflare, such as local development) are not limited, and if a limiter is unavailable the request goes ahead rather than failing.

**Not available on the free plan?** I couldn't open Cloudflare's docs from the build environment, so whether the Free plan includes this binding is unconfirmed. If it doesn't, Cloudflare should reject the deploy and the previous Worker keeps running (the migration that runs first is additive, so the old code still works against it). The alternative would be a Cloudflare WAF rate-limiting rule, which needs a domain on Cloudflare rather than `workers.dev`. Counting in D1 instead would spend the very writes we are trying to save.

### Daily cap on alert changes

Each subscription may have at most **400 alerts added + removed per UTC day**. A first upload is about 150 alerts and a normal day a few dozen, so only a client stuck in a loop gets near it.

- **Over the cap:** the upload is refused with `429`, `Retry-After` set to the seconds until 00:00 UTC, and an error like `Daily limit of 400 alert changes reached for this subscription (399 used today, this upload needs 2); try again after 00:00 UTC`. Nothing is written, not even a counter: the check happens before any write.
- **Exactly at the cap is fine**: 399 used plus 1 more is allowed; the next change is refused.
- **Unchanged uploads never count** and still cost 0 rows, even when the cap is used up.
- **Resets at 00:00 UTC** by itself: the subscription stores the UTC day of its count, and a count from an earlier day is ignored.
- **It adds no writes.** The day and the count are two columns on the subscription row, set in the same `UPDATE` that already records the new schedule hash.
- **One upload can't change more than 400 alerts on its own.** The schedule itself can hold up to 500, but building a 401 to 500 alert schedule from nothing needs 401 or more changes, so it would never fit in a day. That case is answered with `400` (not `429`, because waiting until tomorrow would not help). Normal clients are nowhere near it. If you ever need schedules that long, raise the cap or lower the 500 limit.
- A refused upload still uses one of the 2-a-minute changing-upload allowance above, because that check comes first.

### Web Push

`GET /vapid-public-key` gives the app the key it passes to `pushManager.subscribe({ userVisibleOnly: true, applicationServerKey })`. It answers `503` instead of handing out a key that can't be used (see [Configuration](#web-push-configuration)). The answer may be cached for an hour.

`POST /test-push` takes `{ "id": "...", "secret": "..." }` and sends that subscription one notification, to prove background alerts work. The push message is JSON, `{ "title": "Session Clock", "body": "Background alerts are working." }`. (The app's service worker has no `push` handler yet, so for now nothing is shown even when delivery works; that comes with the app's side of this.) It is limited to **1 a minute per subscription** and 10 a minute per client IP, with the usual `429` and `Retry-After: 60`.

What the push service answers decides what you get back:

| Push service says | Result | Subscription |
|---|---|---|
| any `2xx` | `200` `{ "ok": true }` | kept |
| `404` or `410` (the browser has dropped the subscription) | `410`, "subscribe again" | **deleted, with its alerts** |
| any other status (`400`, `401`, `403`, `413`, `429`, `5xx`, a redirect) | `502` `The push service refused the message (status N)` | kept |
| no answer within 8 seconds, or a network error | `502` `Could not reach the push service` | kept |

The Worker only sends to the real push services behind the browsers' Push APIs (`fcm.googleapis.com`, `*.push.services.mozilla.com`, `*.push.apple.com`, `*.notify.windows.com`), over plain `https`, and never follows a redirect. `POST /subscribe` accepts any public `https` URL, and without this check anyone could use the Worker to send requests to arbitrary servers. A subscription on any other host gets a `502` and nothing is sent. If a browser ever uses another push service, add its host to `PUSH_HOSTS` or `PUSH_HOST_SUFFIXES` in `src/webpush.ts`.

The message is encrypted as RFC 8291 (`aes128gcm`) and signed as RFC 8292 (VAPID), using only Web Crypto, with no library. A payload can be at most 3,993 bytes. Each VAPID token lasts 12 hours and is reused for a push service until it has under an hour left.

**The Worker never logs push endpoints, keys, secrets or notification contents**, and none of them appear in error responses.

### Web Push configuration

| Setting | Kind | Where |
|---|---|---|
| `VAPID_PUBLIC_KEY` | plain variable | `wrangler.jsonc` |
| `VAPID_SUBJECT` | plain variable (`https://sessionclock.vercel.app`; must be an `https:` URL or `mailto:` address) | `wrangler.jsonc` |
| `VAPID_PRIVATE_KEY` | **secret**, never in a file | Cloudflare: `npx wrangler secret put VAPID_PRIVATE_KEY` |

Deploys keep the secret, so it only has to be set once. It is either the raw 32-byte private key as base64url (what `web-push generate-vapid-keys` prints) or a PKCS#8 key. It must be the other half of `VAPID_PUBLIC_KEY`: the Worker checks this by signing something with the private key and verifying it with the public one, and treats a mismatch as not configured. A deploy succeeds even when the secret is missing, so **`/health` reports `pushConfigured`: `true` only when all three settings are present, valid, and the keys match.** It is only ever `true` or `false`. The deploy's [smoke test](#deploy) fails the run if it isn't `true`.

For `wrangler dev`, put a throwaway pair in `.dev.vars` (git ignores it; the local public key must go there too, because the one in `wrangler.jsonc` belongs to the real private key):

```bash
node -e "const c=require('node:crypto');const k=c.generateKeyPairSync('ec',{namedCurve:'prime256v1'}).privateKey.export({format:'jwk'});
console.log('VAPID_PUBLIC_KEY='+Buffer.concat([Buffer.from([4]),Buffer.from(k.x,'base64url'),Buffer.from(k.y,'base64url')]).toString('base64url')+'\nVAPID_PRIVATE_KEY='+k.d)" > .dev.vars
```

The tests make their own throwaway pair on every run, so they need no key.

**Trying it with a real browser** (the app has no push UI yet): on the live site's tab, in the browser console, with `W` set to this Worker's URL:

```js
const reg = await navigator.serviceWorker.ready
const { publicKey } = await (await fetch(W + '/vapid-public-key')).json()
const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: publicKey })
const account = await (await fetch(W + '/subscribe', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(sub) })).json()
await fetch(W + '/test-push', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(account) })
```

`200` means the push service accepted the message. Nothing will be displayed until the service worker handles `push` events.

### Cost of sending

Each push costs about 1 ms of CPU for the encryption (a new key pair and key agreement every time, plus the AES step), about 0.1 ms to sign a VAPID token when one is needed and almost nothing when it's reused. Waiting for the push service doesn't count as CPU. A scheduler run also pays a fixed cost to set up the keys, so how many pushes a run sends is worked out under [Batch size](#batch-size-why-3).

### Logging

The scheduler writes one line per run, with counts only (see [Scheduler](#scheduler)).

The Worker logs nothing about requests. An unexpected failure returns a generic `500` and logs only the error's type, never push endpoints, keys or secrets.

## Scheduler

Two cron triggers in `wrangler.jsonc` start it: **every minute** (send what is due) and **03:17 UTC daily** (clean up). The entry point is the Worker's `scheduled` handler in `src/index.ts`; the work is in `src/scheduler.ts`. They deploy with the Worker.

### Every minute

1. **One query** fetches the unsent alerts whose `fire_at` is now or earlier, with their subscription's endpoint and keys: up to 3 × the batch size that are still on time, ranked as described under [Fair retries](#fair-retries), plus up to 20 that are already too late. A run with nothing due **costs exactly that one read query and writes nothing**.
2. Alerts **more than 10 minutes late are deleted without a push** (one query for all of them). A late session alert is misleading, so it is dropped rather than sent. Because they come out of the same query and have their own allowance of 20 a run, a backlog of late alerts (after an outage, say) can never crowd out the ones still on time.
3. On-time alerts are pushed as `{ "title", "body", "tag" }`, a few at a time (different subscriptions in parallel, one subscription's alerts one after another), and what the push service says decides what happens:

| Push service says | What happens | Counted as |
|---|---|---|
| any `2xx` | the alert is **deleted at once** (cheaper than marking it sent and deleting later) | `sent` |
| `404` or `410` | the subscription is deleted **with all its alerts**, as `/test-push` does | `gone` |
| anything else: another error status, a redirect, no answer, a host the Worker won't send to, unusable keys | the alert **stays** with its `attempts` raised by one, to be tried again in a later run; **the third failure deletes it** | `failed` (and `dropped` for the third) |
| (the alert was more than 10 minutes late) | deleted without a push | `expired` |

   Each alert is deleted (or its `attempts` raised) straight after its own push, not all together at the end. The rows written are the same, but a run that is cut off (CPU limit) keeps what it got done instead of sending the same alerts again every minute. If the push keys are missing or don't match, nothing is pushed and **no alert is counted against**: that isn't the alerts' fault (they are logged as `skipped`, and the daily smoke test is what catches it).
4. If more are due than the batch allows, the rest **carry over** to the next run. An alert is tried at most 3 times, and sooner than that only if it gets 10 minutes late first.

**Never twice.** Every alert has a tag, `alert-<id>` (ids are never reused), sent in the payload as `tag` and as the push's `Topic` header. The push service replaces a still-queued message with the same topic, so a retry of a push that did get through can't leave two waiting, and the tag lets the service worker show each alert once on the device. The web app's service worker doesn't use `tag` yet; it will need to pass it to `showNotification`. The push also tells the push service to drop the message when it would be more than 10 minutes late (`TTL` is what's left of that time) and marks it urgent.

Delivery is **at least once**, not exactly once: if a run is cut off between a push and its delete, the alert goes out again the next minute. That is what the tag and topic are for.

### Fair retries

One subscription whose pushes fail must not hold up everyone else's alerts. Four rules together do that (`test/fair-retries.test.ts` covers each):

1. **Order: first attempts before retries, then oldest first.** An alert that has never been tried (`attempts = 0`) always goes before one that has failed already, whatever their ages, so **a failing subscription's retries can never take a slot from another subscription's first attempt**.
2. **One failure ends a subscription's turn.** A subscription's alerts are pushed one after another; if a push to it fails, its other alerts are skipped for the rest of the run (they keep their `attempts` and are counted as `skipped`). One broken subscription costs one push per run, not the whole batch, and the slot it would have used goes to the next alerts in line.
3. **A subscription is capped at 3 alerts in the list a run looks at.** Skipping alone isn't enough: the query only returns so many alerts, so a failing subscription with hundreds of due alerts, all older than a healthy subscription's one alert, would fill the list and the healthy alert would never be seen. The query ranks each subscription's alerts (a window function) and keeps the best 3 of each. The list is 3 × the batch size, which is always enough to fill every slot when enough alerts are usable: each failing subscription wastes at most one push and two list entries, and there can be at most one failing subscription per push.
4. **Three strikes.** Each failed push (other than 404/410) raises the alert's `attempts` by one (one row written); the third deletes it. A failing alert is gone after at most three pushes, not retried until it is late. If the alert is also more than 10 minutes late, that rule applies first.

The cost is that the query reads every unsent alert due in the last 10 minutes to rank them. That is a small, bounded set (a burst of 300 alerts due together means about 300 rows read per run for up to 10 minutes), well inside the 5 million daily reads. A quiet run still reads nothing. Runs push in up to 3 passes (a subscription can have 3 alerts in a run), each held to the 8-second push timeout, so a run takes at most about 24 seconds of waiting, none of it CPU.

### The log line

One line per run, **counts only**, never an endpoint, key, secret or notification text:

```
scheduler run: due=3 sent=1 failed=1 expired=0 gone=1 dropped=0 skipped=2
```

`due` is the alerts the run dealt with, and it always equals `sent + failed + expired + gone`. `failed` pushes raised an alert's attempts, and `dropped` of them were the third failure, so the alert was deleted. `gone` counts alerts dropped because their subscription is gone, not subscriptions (including that subscription's other due alerts that the run saw, which were not pushed). `skipped` is **not** part of `due`: alerts the run saw but left alone, because an earlier push to the same subscription failed in the run (or the push keys aren't configured). A run that fails unexpectedly logs `scheduler failed: <kind of error>` and is recorded by Cloudflare as failed. See the lines in the dashboard (Workers Logs is switched on for this Worker; invocation logs are off, so requests and client addresses aren't recorded) or live with `npx wrangler tail`.

### The daily clean-up

At 03:17 UTC it deletes **subscriptions not seen for 30 days** with their alerts (at most 200 a day, so a backlog can't spend a day's writes at once; any upload refreshes `last_seen_at` at least daily), and runs the existing [clean-up of old sent alerts](#cleanup-of-sent-alerts). One line: `daily clean-up: old_sent_alerts_deleted=0 stale_subscriptions_deleted=0`.

### Batch size: why 3

A run sends at most **3 pushes** (`MAX_PUSHES_PER_RUN` in `wrangler.jsonc`; any value from 1 to 20 is accepted, anything else means 3). The free plan allows about 10 ms of CPU and 50 subrequests per run, counting D1 queries.

- **Subrequests are not the limit.** A run makes at most 1 read, 1 delete for late alerts, and for each push 1 request plus 1 follow-up query (the delete, the `attempts` update, or the subscription's delete): `2 + 2 × N`. That is 8 for N = 3, and it would still fit at N = 20 (42), which is why 20 is the ceiling.
- **CPU is.** Measured with the real scheduler code in Node, with a fake database and an instant fake push service (so it excludes the real D1 and network handling, which adds something), CPU per run was:

| | Pushes in the run | median | 90th percentile |
|---|---|---|---|
| New isolate (the pessimistic case for a once-a-minute cron) | 1 | 3.9 ms | 6.1 ms |
| | 2 | 4.6 ms | 6.5 ms |
| | **3** | **5.1 ms** | **7.5 ms** |
| | 4 | 6.0 ms | 8.6 ms |
| | 5 | 6.9 ms | 9.9 ms |
| Warm isolate | 1 / 3 / 5 | 1.4 / 2.6 / 3.5 ms | 1.8 / 3.4 / 5.0 ms |

  A cold run costs about **3.2 ms before any push** (setting up the keys, first use of the code) plus about **0.75 ms per push**. At 5 pushes the 90th percentile already touches the limit before the unmeasured real I/O is added, and 4 leaves about 1.4 ms. At 3 there is about 2.5 ms of room at the 90th percentile. Going from 2 to 3 costs only about 0.7 ms and adds half again as much throughput, so 3 is where the curve bends.
- **This was measured in Node, not on Cloudflare.** Treat the margin as thinner than it looks. After deploying, watch the Worker's CPU time and any `Exceeded CPU Limit` errors in the dashboard; if they appear, set `MAX_PUSHES_PER_RUN` to 2 (it is a plain variable, no code change). A cut-off run is survivable: pushes already done were already deleted.

### Limits to know about

- **Throughput is the ceiling on the free plan, well before the write budget.** 3 a minute is at most **180 an hour**, and since an alert more than 10 minutes late is dropped, only about **30 alerts that fall due in the same minute** are delivered in time. Alerts due in different minutes don't compete. That is plenty for a handful of testers and not for hundreds of users who all want the London-open alert at once. On the paid plan (30 s of CPU, 1,000 subrequests) raise `MAX_PUSHES_PER_RUN` (and its cap in `src/constants.ts` accordingly) and the ceiling goes up by the same factor.
- **Failing subscriptions can still use up the slots, for a while.** One failing subscription no longer holds anyone up (see [Fair retries](#fair-retries)), but a failing subscription still gets one push per run for each of its never-tried alerts, ahead of other subscriptions' alerts that are newer. So if as many subscriptions are failing as the batch has slots (3 by default, or 1 if you set it to 1), they can fill every slot of a run until each of their alerts has been tried once, which takes a few runs. The realistic cause is one push service going down (say all Google FCM subscriptions failing while Apple and Mozilla ones are fine). The fix would be to remember that a subscription is failing and rank its never-tried alerts after healthy subscriptions' (a column on the subscription, or the `attempts` of its other alerts); it isn't done because the rule you asked for ranks only by first attempt versus retry.
- **A push service outage longer than about 3 minutes drops alerts.** Every failed push counts against an alert, whoever's fault it was, so an alert that gets three failures in a row during an outage is deleted. That is the same alert that would have been up to 3 minutes late and, a few minutes after, 10 minutes late anyway.
- **No scheduling while D1 is out of its daily budget:** every run fails until 00:00 UTC (see [If the limit is hit](#if-the-limit-is-hit)).
- **Not yet verified on Cloudflare:** the CPU numbers above, and a real push delivered by the scheduler to a real device.

### Trying it locally

```bash
npx wrangler dev --test-scheduled      # with a local .dev.vars, as above
curl "http://localhost:8787/__scheduled?cron=*+*+*+*+*"        # an every-minute run
curl "http://localhost:8787/__scheduled?cron=17+3+*+*+*"       # the daily clean-up
```

The tests (`test/scheduler.test.ts`) cover batching and carry-over, the 10-minute rule, dead subscriptions, retries, the daily clean-up, what a quiet run costs, and the log lines.

## Database

D1 database `session-clock-push`, bound to the Worker as `DB` (see `wrangler.jsonc`; the database ID identifies it and is not a credential). The schema is the numbered files in `migrations/`:

- `subscriptions`: `id`, `endpoint` (unique), `p256dh`, `auth`, `secret_hash` (SHA-256 of the secret; the secret itself is never stored), `schedule_hash` (fingerprint of the last accepted schedule; `NULL` before the first), `changes_day` and `changes_count` (the UTC day number and how many alerts were added + removed on it, for the daily cap), `created_at`, `last_seen_at`.
- `alerts`: `id`, `subscription_id` (deleted with its subscription), `fire_at`, `title`, `body`, `attempts` (failed pushes so far, 0 to 2; the third deletes the alert), `sent_at` (`NULL` until sent; the scheduler deletes sent alerts instead, so this only matters for old rows).
- `idx_alerts_due`: a partial index on `alerts(fire_at) WHERE sent_at IS NULL`, so "unsent alerts due before time X" never scans sent alerts.

All timestamps are UTC integer milliseconds since the Unix epoch.

### Cleanup of sent alerts

`deleteOldSentAlerts(db, now, limit = 1000)` in `src/cleanup.ts` deletes alerts sent more than 24 hours ago and returns how many it deleted. The [daily clean-up](#the-daily-clean-up) calls it. The scheduler deletes the alerts it sends, so the only rows it finds are ones marked sent before the scheduler existed. It deletes at most `limit` rows per call so a single run can only spend a bounded part of the write budget (call again while it returns `limit`).

Sent alerts are deliberately not in any index, because every index entry costs an extra written row. The price is that this query scans the alerts table, which costs rows *read* (5 million a day on the free tier, 50 times the write allowance), so once a day is fine and once a minute is not.  That is why the scheduler deletes each alert as soon as it sends it, instead of marking it `sent_at` and cleaning up later: one fewer written row per alert (see the budget below).

To change the schema, add the next numbered file (`0003_....sql`); never edit one that has been deployed.

## Write budget

D1's free tier allows **100,000 rows written a day** (and 5 million read), for the whole account. Inserts, updates and deletes all count, and **every index entry is an extra written row**. [Cloudflare's pricing page](https://developers.cloudflare.com/d1/platform/pricing/) has the rules.

### What things cost

Measured with D1's `meta.rows_written` in the tests, then extended to the parts that can't be measured locally. Local D1 does not charge for index entries on deletes and updates, so the costs below assume it does, as the real service does. Treat the totals as rough.

| Action | Rows written |
|---|---|
| New subscription (`POST /subscribe`) | 3 (the row, plus its two unique indexes) |
| Subscribing again with the same endpoint | 1 |
| An alert, added (`PUT /schedule`) | 3 (the row, `idx_alerts_due`, `idx_alerts_subscription`), plus 1 per insert statement |
| An alert, removed (`PUT /schedule`) | up to 3 |
| An alert, deleted after its push is sent (the scheduler) | up to 3 |
| An alert found more than 10 minutes late, deleted unsent | up to 3 |
| **One alert from creation to deletion** | **about 6** (it used to be about 7, when it was marked sent and deleted later) |
| A failed push (the scheduler raises the alert's `attempts`) | **1** (an update to a column no index uses) |
| The third failed push (the alert is deleted) | up to 3 |
| **An alert that always fails, from creation to deletion** | **about 8** (3 to add, 1 + 1 for the first two failures, 3 to delete), against about 6 for one that is sent |
| A subscription the push service says is gone (the scheduler or `/test-push`) | 3, plus up to 3 for each of its alerts |
| A subscription not seen for 30 days (the daily clean-up) | 3, plus up to 3 for each alert it still has |
| An old row marked sent before the scheduler existed (the daily clean-up) | about 2 |
| **A scheduler run with nothing due** | **0** (one read query) |
| Upload that changes the schedule | the alerts above, plus 1 (the hash and `last_seen_at`) |
| Upload that doesn't change it | **0** (1 row, at most once a day, to refresh `last_seen_at`) |
| Upload refused by the daily cap | **0** |
| `POST /test-push`, delivered or failed | **0** (it only reads) |
| The daily cap's counter | **0** extra (it rides in the subscription row that is already updated) |

### How many users

Assumptions, all adjustable: a user ends up with about **10 alerts a day** (a few windows with a lead time and an open alert each, on trading days), the schedule covers 15 days, the app uploads about 3 times a day (mostly unchanged), and 1 in 3 uploads changes something.

- **Steady state, per active user per day:** each day one day of alerts enters the window and one is sent and deleted: 10 alerts × 6 rows = 60, plus about 5 for the changing uploads. Call it **65 rows**.
- **A new user, once:** subscribing plus the first upload of 15 days of alerts: 3 + 150 × 3 + 2 = **about 455 rows**.

So the day's total is roughly `65 × daily active users + 455 × new users that day`. Against 100,000:

| Daily active users | New users that day | Rows written | Share of the free tier |
|---|---|---|---|
| 300 | 20 | ~29,000 | 29% |
| 800 | 40 | ~70,000 | 70% |
| 1,200 | 60 | ~105,000 | over |

**Plan for about 800 daily active users, and expect trouble at around 1,100.** Keeping some of the budget free is deliberate: retries, bursts of sign-ups, dead subscriptions and late alerts being deleted, and the daily clean-up all draw on the same allowance. **But the scheduler's throughput on the free plan runs out long before this** (about 30 alerts in the same minute; see [Limits to know about](#limits-to-know-about)), so the write budget is not what limits you first. Alerts per user is the number that matters most: at 20 alerts a day the same budget supports about half as many users, and at 5 about twice as many.

**Before these changes** every upload deleted and re-inserted the whole schedule, about 150 alerts × 6 = 900 rows, and the app uploads on every launch. At 3 uploads a day that is about 2,700 rows per user per day, so the free tier covered roughly **35 users**. The hash check and the diff are what take it from dozens to hundreds.

### Worst cases

The [daily cap](#daily-cap-on-alert-changes) puts a ceiling on what one subscription can cost: 400 changes a day.

**One misbehaving subscription, per day:**

| How it spends its 400 changes | Rows written |
|---|---|
| One upload adding 400 alerts | about 1,200 (400 x 3, plus 1 for the insert statement and 1 for the subscription row) |
| One upload removing 400 alerts | up to 1,201 |
| 400 uploads of one alert each, the most expensive way (needs 200 minutes at the 2-a-minute limit) | about **2,000** (5 each: 3 for the alert, 1 for the insert statement, 1 for the subscription row) |

So **one bad subscription costs at most about 2,000 rows a day, 2% of the free tier**, against about 65 for a normal one (30 times). Before the cap, nothing but the 2-a-minute limit stopped it, and each upload could rewrite 500 alerts: millions of rows a day. Refused uploads cost no writes, only reads.

**The whole service:**

| Scenario | Rows written a day | Free tier used |
|---|---|---|
| Normal: 600 daily active users, 40 new | ~57,000 | 57% |
| One misbehaving subscription on top | up to +2,000 | +2% |
| A bug in the app that sends every client into the loop | 600 x about 1,200+ = over 700,000 | **7 times over** |
| The same bug in 30 of those 600 users (5%) | ~57,000 + 30 x 1,135 = ~91,000 | **close to the limit** |
| A deliberate attacker with 85 subscriptions | 85 x about 1,200 = ~100,000 | **at the limit** |

What this means:

- The cap makes **one bad client a rounding error**. It does not make **many bad clients** safe. A bug in the app released to everyone, or one that hits more than about 6% of users at once, can still use up the free tier in a day. Releasing client changes to the schedule upload carefully (and watching D1's row count after) is the real defence for that.
- It does **not stop a deliberate attacker**. Subscribing needs no account: one address can create about 85 subscriptions in half an hour (3 a minute), and each can make one 400-alert upload, which is the whole day's budget. The cap and rate limits only make this take 30 minutes and some effort instead of a few requests. To really close it, the options are: put a challenge such as Cloudflare Turnstile in front of `POST /subscribe`; cap the number of new subscriptions a day for the whole service; or move to the paid Workers plan. None of those is done here.
- When any of this happens the result is the same as below: the service returns `503` until 00:00 UTC.

### If the limit is hit

From 1 September 2026 [D1 on the Free plan fails every query once either daily limit is used up, reads included, until 00:00 UTC](https://developers.cloudflare.com/changelog/post/2026-09-01-d1-free-tier-limit-enforcement/). Stored data is safe, and Cloudflare emails the account when the limit is reached. Here that means:

- `POST /subscribe`, `PUT /schedule` and `POST /unsubscribe` answer **`503`** with a `Retry-After` giving the seconds until 00:00 UTC, and the Worker logs `D1 daily free-tier limit reached` (nothing else) so it shows up in the logs. The app should keep working without push: its in-page alerts need no server, so it should retry after the `Retry-After` time and not treat this as a failure.
- `GET /health` keeps working, because it uses no database. It does not tell you the database is out of budget.
- **The scheduler stops too:** it can't read due alerts either, so every minute's run fails (logged as `scheduler failed: Error`) until 00:00 UTC. Alerts that fall due during the outage are not lost at once, but once the counters reset only those no more than 10 minutes late are sent; older ones are deleted unsent, which is the rule working as intended, not a flood of stale notifications.
- The fix is to wait, or to move to the paid Workers plan, which has far larger limits.

## Develop

```bash
cd push-worker
npm ci
npm run db:migrate:local  # create the local database tables (once, and after adding a migration)
npm run dev        # local server (http://localhost:8787/health)
npm run typecheck  # tsc --noEmit
npm test           # tests run inside the Workers runtime (Cloudflare's Vitest integration)
```

> Use npm 11 when you **add or change** dependencies (`npx npm@11 install ...`). npm 10, the version that ships with Node 22, fails to resolve this project's Vitest peer dependencies. Installing from the committed `package-lock.json` (`npm ci`) works with either.

## Deploy

The cron triggers deploy with the Worker, so the every-minute run starts as soon as a deploy goes live. With no alerts yet that is one cheap read query a minute (about 1,440 a day, well inside the 5 million reads).

CI (`.github/workflows/ci.yml`) installs, type-checks and tests this folder on every pull request.

Deploys are automatic: when a push to `main` changes anything in `push-worker/`, the **Deploy push worker** workflow runs the tests, **applies any new D1 migrations to the remote database**, and then deploys with [`cloudflare/wrangler-action`](https://github.com/cloudflare/wrangler-action). You can also run it by hand from the Actions tab (**Run workflow**); it only deploys `main`.

The workflow needs two repository secrets (Settings > Secrets and variables > Actions):

- `CLOUDFLARE_API_TOKEN`: an API token that can edit Workers (the "Edit Cloudflare Workers" template).
- `CLOUDFLARE_ACCOUNT_ID`: your Cloudflare account ID.

The token also needs **Account > D1 > Edit** to apply migrations: check that your token has it, and add it if the template you used does not. Neither secret is stored in any file. The deploy passes the commit being deployed as the `GIT_COMMIT_SHA` variable (`wrangler deploy --var GIT_COMMIT_SHA:<sha>`), which is what `/health` reports as `version`. The default in `wrangler.jsonc` (`"dev"`) is only used locally.

After the first deploy the Worker is at `https://session-clock-push.<your-account-subdomain>.workers.dev/health`. The subdomain is shown in the deploy log and under Workers & Pages in the Cloudflare dashboard.

The workflow ends with a smoke test: it calls `<PUSH_WORKER_URL>/health` and fails unless the response is 200, `ok` is `true`, `version` equals the commit just deployed, **and `pushConfigured` is `true`**. A deploy succeeds even if the `VAPID_PRIVATE_KEY` secret was never set, so this is what catches it. If the new version is live but `pushConfigured` isn't `true`, it fails straight away with instructions instead of retrying, because waiting won't help. It retries for about 30 seconds because a new deploy can take a moment to go live. Set the repository **variable** (not a secret) `PUSH_WORKER_URL` to the Worker's base URL, without `/health`.
