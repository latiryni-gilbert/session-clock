import { cloudflareTest } from '@cloudflare/vitest-plugin'
import { defineConfig } from 'vitest/config'

// Runs the tests inside the Workers runtime (workerd, via Miniflare), using wrangler.jsonc for the setup.
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      // What a deploy injects, pinned so the tests can check it comes through.
      miniflare: { bindings: { GIT_COMMIT_SHA: '0123456789abcdef0123456789abcdef01234567' } },
    }),
  ],
  test: {
    include: ['test/**/*.test.ts'],
  },
})
