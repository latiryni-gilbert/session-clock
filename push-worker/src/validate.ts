import { HttpError } from './http'
import { MAX_ALERTS, MAX_BODY_CHARS, MAX_ENDPOINT_CHARS, MAX_SCHEDULE_DAYS, MAX_TITLE_CHARS } from './constants'

const BASE64URL = /^[A-Za-z0-9_-]+$/
const DAY_MS = 24 * 60 * 60 * 1000
// ISO 8601 with an explicit offset, e.g. 2026-10-14T13:30:00Z or 2026-10-14T09:30:00-04:00
const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/

export interface PushSubscriptionInput {
  endpoint: string
  p256dh: string
  auth: string
}

export interface AlertInput {
  fireAt: number // UTC, milliseconds since the Unix epoch
  title: string
  body: string
}

const bad = (message: string) => new HttpError(400, message)

/** Length in characters as a person counts them (an emoji is one, not two). */
const chars = (text: string) => Array.from(text).length

function validateEndpoint(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_ENDPOINT_CHARS) {
    throw bad(`endpoint must be a URL of at most ${MAX_ENDPOINT_CHARS} characters`)
  }
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw bad('endpoint must be a valid URL')
  }
  // The Worker will later send requests to this URL, so only accept what a real push service looks like:
  // plain https on a public hostname, not an IP address or an internal name.
  const host = url.hostname
  const looksInternal =
    !host.includes('.') ||
    /^\d+(\.\d+){3}$/.test(host) ||
    host.startsWith('[') ||
    /\.(localhost|local|internal|lan|home|corp)$/.test(host)
  if (url.protocol !== 'https:' || url.username || url.password || url.port || looksInternal) {
    throw bad('endpoint must be an https URL on a public hostname')
  }
  return url.href
}

function validateKey(value: unknown, name: string, min: number, max: number): string {
  if (typeof value !== 'string' || value.length < min || value.length > max || !BASE64URL.test(value)) {
    throw bad(`keys.${name} must be a base64url string`)
  }
  return value
}

/** Accepts what the browser's PushSubscription.toJSON() produces. */
export function validateSubscription(body: Record<string, unknown>): PushSubscriptionInput {
  const keys = body.keys
  if (typeof keys !== 'object' || keys === null || Array.isArray(keys)) {
    throw bad('keys must be an object with p256dh and auth')
  }
  const { p256dh, auth } = keys as Record<string, unknown>
  return {
    endpoint: validateEndpoint(body.endpoint),
    p256dh: validateKey(p256dh, 'p256dh', 43, 128),
    auth: validateKey(auth, 'auth', 16, 64),
  }
}

export function validateAlerts(value: unknown, now: number): AlertInput[] {
  if (!Array.isArray(value)) throw bad('alerts must be an array')
  if (value.length > MAX_ALERTS) throw bad(`alerts must have at most ${MAX_ALERTS} entries`)

  const latest = now + MAX_SCHEDULE_DAYS * DAY_MS
  return value.map((item: unknown, i) => {
    const at = `alerts[${i}]`
    if (typeof item !== 'object' || item === null || Array.isArray(item)) throw bad(`${at} must be an object`)
    const { fireAt, title, body } = item as Record<string, unknown>

    if (typeof fireAt !== 'string' || !ISO_WITH_OFFSET.test(fireAt) || Number.isNaN(Date.parse(fireAt))) {
      throw bad(`${at}.fireAt must be an ISO 8601 date-time with a UTC offset, like 2026-10-14T13:30:00Z`)
    }
    const fireMs = Date.parse(fireAt)
    if (fireMs <= now) throw bad(`${at}.fireAt is in the past`)
    if (fireMs > latest) throw bad(`${at}.fireAt is more than ${MAX_SCHEDULE_DAYS} days from now`)

    if (typeof title !== 'string' || chars(title) < 1 || chars(title) > MAX_TITLE_CHARS) {
      throw bad(`${at}.title must be 1 to ${MAX_TITLE_CHARS} characters`)
    }
    if (typeof body !== 'string' || chars(body) > MAX_BODY_CHARS) {
      throw bad(`${at}.body must be at most ${MAX_BODY_CHARS} characters`)
    }
    return { fireAt: fireMs, title, body }
  })
}
