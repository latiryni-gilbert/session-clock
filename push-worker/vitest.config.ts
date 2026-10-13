import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin'
import { defineConfig } from 'vitest/config'

// Runs the tests inside the Workers runtime (workerd, via Miniflare), using wrangler.jsonc for the setup.
export default defineConfig(async () => ({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        bindings: {
          // What a deploy injects, pinned so the tests can check it comes through.
          GIT_COMMIT_SHA: '0123456789abcdef0123456789abcdef01234567',
          // The real migration files, applied to the in-memory test database by test/apply-migrations.ts.
          TEST_MIGRATIONS: await readD1Migrations('./migrations'),
        },
      },
    }),
  ],
  test: {
    include: ['test/**/*.test.ts'],
    setupFiles: ['./test/apply-migrations.ts'],
  },
}))
