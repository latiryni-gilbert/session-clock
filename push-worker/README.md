# session-clock-push

A small [Cloudflare Worker](https://developers.cloudflare.com/workers/) for Session Clock's push notifications. Today it **stores** push subscriptions and their scheduled alerts in a [D1](https://developers.cloudflare.com/d1/) database. It does not send anything yet and has no scheduler.

It is separate from the web app: its own `package.json`, TypeScript config and tests, and nothing in the app imports it.

## API

All endpoints take and return JSON. Errors look like `{ "ok": false, "error": "<message>" }`. Responses are never cached.

| Request | Success | Errors |
|---|---|---|
| `GET /health` | `200` `{ "ok": true, "service": "session-clock-push", "version": "<git commit sha>" }` (`HEAD` works too) | `405` for other methods |
| `POST /subscribe` | `200` `{ "id": "...", "secret": "..." }` | `400` invalid subscription |
| `PUT /schedule` | `200` `{ "ok": true, "scheduled": <count> }` | `401` wrong id/secret, `400` invalid alerts |
| `POST /unsubscribe` | `200` `{ "ok": true }` | `401` wrong id/secret |
| anything else | | `404` `Not found` |

Wrong method on one of the three endpoints is `405` (with an `Allow` header). Any request body must be a JSON object sent as `Content-Type: application/json`: otherwise `415`; malformed JSON or invalid UTF-8 is `400`; over 64 KB is `413`.

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

Replaces the subscription's future, unsent alerts with this list, all or nothing. `[]` clears them. Alerts already sent, and unsent alerts that are already due, are left alone.

- At most **500** alerts.
- `fireAt`: ISO 8601 with an explicit offset (`Z` or `-04:00`); stored as UTC. Must be in the future and **within 15 days**. One bad alert rejects the whole request and the message names it (`alerts[3].fireAt is in the past`).
- `title`: 1 to **80** characters. `body`: 0 to **200** characters.
- The whole request body is capped at 64 KB, so 500 alerts fit only if they are short (about 130 bytes each).

### `POST /unsubscribe`

```json
{ "id": "...", "secret": "..." }
```

Deletes the subscription and all its alerts.

### Authentication errors

A missing, malformed or wrong `id`/`secret` always returns the same `401` (`Invalid id or secret`), checked before the rest of the request is looked at, so the response never reveals whether an id exists.

### CORS

Browsers may call the API only from `https://sessionclock.vercel.app`, this project's Vercel previews (`https://session-clock-*-latiryni-gilberts-projects.vercel.app`) and `localhost` (any port, http or https). A request carrying any other `Origin` gets `403` and is not processed. Requests with no `Origin` header (curl, servers) are allowed: the secret is what protects a subscription, not CORS. `/health` is unaffected.

### Logging

The Worker logs nothing about requests. An unexpected failure returns a generic `500` and logs only the error's type, never push endpoints, keys or secrets.

## Database

D1 database `session-clock-push`, bound to the Worker as `DB` (see `wrangler.jsonc`; the database ID identifies it and is not a credential). The schema is the numbered files in `migrations/`:

- `subscriptions`: `id`, `endpoint` (unique), `p256dh`, `auth`, `secret_hash` (SHA-256 of the secret; the secret itself is never stored), `created_at`, `last_seen_at`.
- `alerts`: `id`, `subscription_id` (deleted with its subscription), `fire_at`, `title`, `body`, `sent_at` (`NULL` until sent).
- `idx_alerts_due`: a partial index on `alerts(fire_at) WHERE sent_at IS NULL`, so "unsent alerts due before time X" never scans sent alerts.

All timestamps are UTC integer milliseconds since the Unix epoch.

To change the schema, add the next numbered file (`0003_....sql`); never edit one that has been deployed.

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
