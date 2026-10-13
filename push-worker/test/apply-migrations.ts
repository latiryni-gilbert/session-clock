import { env } from 'cloudflare:workers'
import { applyD1Migrations } from 'cloudflare:test'

// Build the schema from the real migration files before the tests run.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS)
