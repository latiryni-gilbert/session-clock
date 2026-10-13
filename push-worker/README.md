# session-clock-push

A small [Cloudflare Worker](https://developers.cloudflare.com/workers/) for Session Clock's push notifications. Today it **stores** push subscriptions and their scheduled alerts in a [D1](https://developers.cloudflare.com/d1/) database. It does not send anything yet and has no scheduler.

It is separate from the web app: its own `package.json`, TypeScript config and tests, and nothing in the app imports it.

## API

All endpoints take and return JSON. Errors look like `{ "ok": false, "error": "<message>" }`. Responses are never cached.

| Request | Success | Errors |
|---|---|---|
| `GET /health` | `200` `{ "ok": true, "service": "session-clock-push", "version": "<git commit sha>" }` (`HEAD` works too) | `405` for other methods |
| `POST /subscribe` | `200` `{ "id": "...", "secret": "..." }` | `400` invalid subscription, `429` too many requests |
| `PUT /schedule` | `200` `{ "ok": true, "scheduled": <count>, "added": <n>, "removed": <n> }`, or `{ "ok": true, "scheduled": <count>, "unchanged": true }` | `401` wrong id/secret, `400` invalid alerts, `409` overlapping upload, `429` too many requests |
| `POST /unsubscribe` | `200` `{ "ok": true }` | `401` wrong id/secret |
| anything else | | `404` `Not found` |

Any endpoint that uses the database answers `503` with a `Retry-After` header when D1's daily free-tier limit is used up (see [Write budget](#write-budget)). Wrong method on one of the three endpoints is `405` (with an `Allow` header). Any request body must be a JSON object sent as `Content-Type: application/json`: otherwise `415`; malformed JSON or invalid UTF-8 is `400`; over 64 KB is `413`.

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
| `PUT /schedule` that **changes** something: **2 a minute** | subscription id | This is the one that guards the write budget. A real user changes their alerts a few times a day at most (the app should wait a moment after the last edit before uploading), so a buggy client stuck in a loop of changing uploads is held to about 2,900 a day instead of thousands a minute. Re-sending a schedule that is already stored is not limited by this one. |

`POST /unsubscribe` is not limited: it only frees rows. Requests with no client address (only possible outside Cloudflare, such as local development) are not limited, and if a limiter is unavailable the request goes ahead rather than failing.

**Not available on the free plan?** I couldn't open Cloudflare's docs from the build environment, so whether the Free plan includes this binding is unconfirmed. If it doesn't, Cloudflare should reject the deploy and the previous Worker keeps running (the migration that runs first is additive, so the old code still works against it). The alternative would be a Cloudflare WAF rate-limiting rule, which needs a domain on Cloudflare rather than `workers.dev`. Counting in D1 instead would spend the very writes we are trying to save.

### Logging

The Worker logs nothing about requests. An unexpected failure returns a generic `500` and logs only the error's type, never push endpoints, keys or secrets.

## Database

D1 database `session-clock-push`, bound to the Worker as `DB` (see `wrangler.jsonc`; the database ID identifies it and is not a credential). The schema is the numbered files in `migrations/`:

- `subscriptions`: `id`, `endpoint` (unique), `p256dh`, `auth`, `secret_hash` (SHA-256 of the secret; the secret itself is never stored), `schedule_hash` (fingerprint of the last accepted schedule; `NULL` before the first), `created_at`, `last_seen_at`.
- `alerts`: `id`, `subscription_id` (deleted with its subscription), `fire_at`, `title`, `body`, `sent_at` (`NULL` until sent).
- `idx_alerts_due`: a partial index on `alerts(fire_at) WHERE sent_at IS NULL`, so "unsent alerts due before time X" never scans sent alerts.

All timestamps are UTC integer milliseconds since the Unix epoch.

### Cleanup of sent alerts

`deleteOldSentAlerts(db, now, limit = 1000)` in `src/cleanup.ts` deletes alerts sent more than 24 hours ago and returns how many it deleted. Nothing calls it yet: the scheduler will, about once a day. It deletes at most `limit` rows per call so a single run can only spend a bounded part of the write budget (call again while it returns `limit`).

Sent alerts are deliberately not in any index, because every index entry costs an extra written row. The price is that this query scans the alerts table, which costs rows *read* (5 million a day on the free tier, 50 times the write allowance), so once a day is fine and once a minute is not. If the scheduler deletes an alert as soon as it sends it, instead of marking it `sent_at` and cleaning up later, that is one fewer written row per alert (see the budget below).

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
| An alert, marked sent (scheduler, later) | about 2 |
| An alert, deleted by cleanup | about 2 |
| **One alert from creation to cleanup** | **about 7** |
| Upload that changes the schedule | the alerts above, plus 1 (the hash and `last_seen_at`) |
| Upload that doesn't change it | **0** (1 row, at most once a day, to refresh `last_seen_at`) |

### How many users

Assumptions, all adjustable: a user ends up with about **10 alerts a day** (a few windows with a lead time and an open alert each, on trading days), the schedule covers 15 days, the app uploads about 3 times a day (mostly unchanged), and 1 in 3 uploads changes something.

- **Steady state, per active user per day:** each day one day of alerts enters the window and one is sent and cleaned up: 10 alerts × 7 rows = 70, plus about 5 for the changing uploads. Call it **80 rows**.
- **A new user, once:** subscribing plus the first upload of 15 days of alerts: 3 + 150 × 3 + 2 = **about 455 rows**.

So the day's total is roughly `80 × daily active users + 455 × new users that day`. Against 100,000:

| Daily active users | New users that day | Rows written | Share of the free tier |
|---|---|---|---|
| 300 | 20 | ~33,000 | 33% |
| 600 | 40 | ~66,000 | 66% |
| 1,000 | 50 | ~103,000 | over |

**Plan for about 600 daily active users, and expect trouble at around 1,000.** Keeping a third of the budget free is deliberate: retries, bursts of sign-ups, and the scheduler's own writes (which this estimate includes for sent/cleanup, but not for anything else it adds) all draw on the same allowance. Alerts per user is the number that matters most: at 20 alerts a day the same budget supports about half as many users, and at 5 about twice as many.

**Before these changes** every upload deleted and re-inserted the whole schedule, about 150 alerts × 6 = 900 rows, and the app uploads on every launch. At 3 uploads a day that is about 2,700 rows per user per day, so the free tier covered roughly **35 users**. The hash check and the diff are what take it from dozens to hundreds.

What the budget does not cover is a determined attacker: they can create subscriptions from many addresses, and each makes the Worker write. The rate limits above stop accidents and casual abuse, not that. If it ever happens, the next step is a per-subscription daily cap on changed alerts (two columns on the row that is already written, so no extra cost), or moving to the paid plan.

### If the limit is hit

From 1 September 2026 [D1 on the Free plan fails every query once either daily limit is used up, reads included, until 00:00 UTC](https://developers.cloudflare.com/changelog/post/2026-09-01-d1-free-tier-limit-enforcement/). Stored data is safe, and Cloudflare emails the account when the limit is reached. Here that means:

- `POST /subscribe`, `PUT /schedule` and `POST /unsubscribe` answer **`503`** with a `Retry-After` giving the seconds until 00:00 UTC, and the Worker logs `D1 daily free-tier limit reached` (nothing else) so it shows up in the logs. The app should keep working without push: its in-page alerts need no server, so it should retry after the `Retry-After` time and not treat this as a failure.
- `GET /health` keeps working, because it uses no database. It does not tell you the database is out of budget.
- Nothing is lost on the server's side except time: when the scheduler exists it won't be able to read due alerts either, so alerts that fall due during the outage are late. Once the counters reset, the scheduler should skip alerts that are long overdue instead of sending them all at once.
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

CI (`.github/workflows/ci.yml`) installs, type-checks and tests this folder on every pull request.

Deploys are automatic: when a push to `main` changes anything in `push-worker/`, the **Deploy push worker** workflow runs the tests, **applies any new D1 migrations to the remote database**, and then deploys with [`cloudflare/wrangler-action`](https://github.com/cloudflare/wrangler-action). You can also run it by hand from the Actions tab (**Run workflow**); it only deploys `main`.

The workflow needs two repository secrets (Settings > Secrets and variables > Actions):

- `CLOUDFLARE_API_TOKEN`: an API token that can edit Workers (the "Edit Cloudflare Workers" template).
- `CLOUDFLARE_ACCOUNT_ID`: your Cloudflare account ID.

The token also needs **Account > D1 > Edit** to apply migrations: check that your token has it, and add it if the template you used does not. Neither secret is stored in any file. The deploy passes the commit being deployed as the `GIT_COMMIT_SHA` variable (`wrangler deploy --var GIT_COMMIT_SHA:<sha>`), which is what `/health` reports as `version`. The default in `wrangler.jsonc` (`"dev"`) is only used locally.

After the first deploy the Worker is at `https://session-clock-push.<your-account-subdomain>.workers.dev/health`. The subdomain is shown in the deploy log and under Workers & Pages in the Cloudflare dashboard.

The workflow ends with a smoke test: it calls `<PUSH_WORKER_URL>/health` and fails unless the response is 200, `ok` is `true` and `version` equals the commit just deployed. It retries for about 30 seconds because a new deploy can take a moment to go live. Set the repository **variable** (not a secret) `PUSH_WORKER_URL` to the Worker's base URL, without `/health`.
