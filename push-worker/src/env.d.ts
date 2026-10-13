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
    // Tests only: the migrations to apply to the test database (see vitest.config.ts).
    TEST_MIGRATIONS: import('@cloudflare/vitest-plugin').D1Migration[]
  }
  // Lets `exports.default` (the Worker's own entry point) be typed in tests.
  interface GlobalProps {
    mainModule: typeof import('./index')
  }
}
