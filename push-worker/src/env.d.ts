// The bindings this Worker receives (see wrangler.jsonc).
declare namespace Cloudflare {
  interface Env {
    // Set at deploy time.
    GIT_COMMIT_SHA: string
    // The D1 database.
    DB: D1Database
    // Rate limiters (see wrangler.jsonc).
    SUBSCRIBE_LIMITER: RateLimit
    SCHEDULE_LIMITER: RateLimit
    SCHEDULE_CHANGE_LIMITER: RateLimit
    TEST_PUSH_LIMITER: RateLimit
    TEST_PUSH_IP_LIMITER: RateLimit
    // Web Push (VAPID). The public key and subject are plain vars in wrangler.jsonc. The private key is a
    // Cloudflare secret (`wrangler secret put VAPID_PRIVATE_KEY`), so it can be missing, and the code checks.
    VAPID_PUBLIC_KEY: string
    VAPID_SUBJECT: string
    VAPID_PRIVATE_KEY?: string
    // How many pushes the scheduler sends per run (a plain variable in wrangler.jsonc; see constants.ts).
    MAX_PUSHES_PER_RUN?: string
    // Tests only: the migrations to apply to the test database (see vitest.config.ts).
    TEST_MIGRATIONS: import('@cloudflare/vitest-plugin').D1Migration[]
  }
  // Lets `exports.default` (the Worker's own entry point) be typed in tests.
  interface GlobalProps {
    mainModule: typeof import('./index')
  }
}
