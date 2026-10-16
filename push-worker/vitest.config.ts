import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin'
import { defineConfig } from 'vitest/config'

// A throwaway VAPID key pair, new on every run, so no real key is ever needed (or present) in tests.
async function throwawayVapidKeys() {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair
  const jwk = (await crypto.subtle.exportKey('jwk', pair.privateKey)) as JsonWebKey
  const publicKey = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x!, 'base64url'), Buffer.from(jwk.y!, 'base64url')])
  return { VAPID_PUBLIC_KEY: publicKey.toString('base64url'), VAPID_PRIVATE_KEY: jwk.d! }
}

// Runs the tests inside the Workers runtime (workerd, via Miniflare), using wrangler.jsonc for the setup.
export default defineConfig(async () => ({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        bindings: {
          // What a deploy injects, pinned so the tests can check it comes through.
          GIT_COMMIT_SHA: '0123456789abcdef0123456789abcdef01234567',
          ...(await throwawayVapidKeys()),
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
