import { RETRY_AFTER_SECONDS } from './constants'
import { HttpError } from './http'

/**
 * Throws a 429 when `key` has used up its allowance in `limiter`.
 *
 * Fails open: if the limiter is missing or errors, the request goes ahead, because an outage in the
 * limiter should not take the API down with it. A missing `key` (no client address, which only happens
 * outside Cloudflare, e.g. local development) is not limited either, rather than lumping everyone together.
 */
export async function enforceRateLimit(limiter: RateLimit | undefined, key: string | null): Promise<void> {
  if (!limiter || !key) return
  let allowed = true
  try {
    allowed = (await limiter.limit({ key })).success
  } catch {
    return
  }
  if (!allowed) {
    throw new HttpError(429, 'Too many requests; try again shortly', { 'retry-after': String(RETRY_AFTER_SECONDS) })
  }
}
