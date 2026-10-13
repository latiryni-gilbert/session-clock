# session-clock-push

A small [Cloudflare Worker](https://developers.cloudflare.com/workers/) that will send push notifications for Session Clock. For now it has one endpoint:

| Request | Response |
|---|---|
| `GET /health` | `200` with `{ "ok": true, "service": "session-clock-push", "version": "<git commit sha>" }` |
| anything else | `404` with `{ "ok": false, "error": "Not found" }` |

(`HEAD /health` works too; other methods on `/health` get `405`.) It is separate from the web app: its own `package.json`, TypeScript config and tests, and nothing in the app imports it.

## Develop

```bash
cd push-worker
npm ci
npm run dev        # local server (http://localhost:8787/health)
npm run typecheck  # tsc --noEmit
npm test           # tests run inside the Workers runtime (Cloudflare's Vitest integration)
```

> Use npm 11 when you **add or change** dependencies (`npx npm@11 install ...`). npm 10, the version that ships with Node 22, fails to resolve this project's Vitest peer dependencies. Installing from the committed `package-lock.json` (`npm ci`) works with either.

## Deploy

CI (`.github/workflows/ci.yml`) installs, type-checks and tests this folder on every pull request.

Deploys are automatic: when a push to `main` changes anything in `push-worker/`, the **Deploy push worker** workflow runs the tests and then deploys with [`cloudflare/wrangler-action`](https://github.com/cloudflare/wrangler-action). You can also run it by hand from the Actions tab (**Run workflow**); it only deploys `main`.

The workflow needs two repository secrets (Settings > Secrets and variables > Actions):

- `CLOUDFLARE_API_TOKEN`: an API token that can edit Workers (the "Edit Cloudflare Workers" template).
- `CLOUDFLARE_ACCOUNT_ID`: your Cloudflare account ID.

Neither is stored in any file. The deploy passes the commit being deployed as the `GIT_COMMIT_SHA` variable (`wrangler deploy --var GIT_COMMIT_SHA:<sha>`), which is what `/health` reports as `version`. The default in `wrangler.jsonc` (`"dev"`) is only used locally.

After the first deploy the Worker is at `https://session-clock-push.<your-account-subdomain>.workers.dev/health`. The subdomain is shown in the deploy log and under Workers & Pages in the Cloudflare dashboard.
