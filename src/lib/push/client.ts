import type { PushAccount } from './storage'

// Talks to the push Worker (push-worker/ in this repository). Nothing here logs, and no response body is ever
// passed on: the only things that leave this file are the typed results below.

export type FailureReason =
  | 'rate-limited' // 429: too many requests
  | 'gone' // 410 or 422: the Worker has dropped this subscription, or its keys are unusable
  | 'unauthorized' // 401: the id and secret are not (or no longer) known
  | 'unavailable' // 503: not configured, or out of storage for today
  | 'bad-gateway' // 502: the browser's push service did not accept the message
  | 'network' // no answer at all
  | 'error' // anything else

export interface Failure {
  ok: false
  reason: FailureReason
  /** From a Retry-After header (429, 503): how long the Worker asks to wait. */
  retryAfterSeconds?: number
}
export type Result<T> = ({ ok: true } & T) | Failure

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>

const REQUEST_TIMEOUT_MS = 15_000

function reasonFor(status: number): FailureReason {
  if (status === 429) return 'rate-limited'
  if (status === 410 || status === 422) return 'gone'
  if (status === 401) return 'unauthorized'
  if (status === 503) return 'unavailable'
  if (status === 502) return 'bad-gateway'
  return 'error'
}

async function call(fetchFn: Fetch, url: string, init: RequestInit): Promise<{ response: Response } | Failure> {
  try {
    const response = await fetchFn(url, {
      ...init,
      credentials: 'omit',
      cache: 'no-store',
      signal: typeof AbortSignal !== 'undefined' && 'timeout' in AbortSignal ? AbortSignal.timeout(REQUEST_TIMEOUT_MS) : undefined,
    })
    return { response }
  } catch {
    return { ok: false, reason: 'network' }
  }
}

const post = (body: unknown, method = 'POST'): RequestInit => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

async function json(response: Response): Promise<unknown> {
  try {
    return await response.json()
  } catch {
    return null
  }
}

/** GET /vapid-public-key: the key to pass to the browser's push manager. */
export async function fetchPublicKey(baseUrl: string, fetchFn: Fetch): Promise<Result<{ publicKey: string }>> {
  const sent = await call(fetchFn, `${baseUrl}/vapid-public-key`, { method: 'GET' })
  if (!('response' in sent)) return sent
  if (!sent.response.ok) return { ok: false, reason: reasonFor(sent.response.status) }
  const body = (await json(sent.response)) as { publicKey?: unknown } | null
  return typeof body?.publicKey === 'string' && body.publicKey !== '' ? { ok: true, publicKey: body.publicKey } : { ok: false, reason: 'error' }
}

/** POST /subscribe: register the browser's push subscription; returns the id and secret to keep. */
export async function registerSubscription(baseUrl: string, subscription: unknown, fetchFn: Fetch): Promise<Result<PushAccount>> {
  const sent = await call(fetchFn, `${baseUrl}/subscribe`, post(subscription))
  if (!('response' in sent)) return sent
  if (!sent.response.ok) return { ok: false, reason: reasonFor(sent.response.status) }
  const body = (await json(sent.response)) as { id?: unknown; secret?: unknown } | null
  return typeof body?.id === 'string' && typeof body.secret === 'string' && body.id !== '' && body.secret !== ''
    ? { ok: true, id: body.id, secret: body.secret }
    : { ok: false, reason: 'error' }
}

/** POST /test-push: have the Worker send this device one notification. */
export async function sendTestPush(baseUrl: string, account: PushAccount, fetchFn: Fetch): Promise<Result<object>> {
  const sent = await call(fetchFn, `${baseUrl}/test-push`, post({ id: account.id, secret: account.secret }))
  if (!('response' in sent)) return sent
  // Cancel rather than read the body: only the status matters.
  void sent.response.body?.cancel().catch(() => {})
  return sent.response.ok ? { ok: true } : { ok: false, reason: reasonFor(sent.response.status) }
}

/** POST /unsubscribe: have the Worker forget this device and its alerts. */
export async function removeSubscription(baseUrl: string, account: PushAccount, fetchFn: Fetch): Promise<Result<object>> {
  const sent = await call(fetchFn, `${baseUrl}/unsubscribe`, post({ id: account.id, secret: account.secret }))
  if (!('response' in sent)) return sent
  void sent.response.body?.cancel().catch(() => {})
  return sent.response.ok ? { ok: true } : { ok: false, reason: reasonFor(sent.response.status) }
}

const MAX_RETRY_AFTER_SECONDS = 24 * 60 * 60

/** The seconds in a Retry-After header, or undefined if it is missing or not a plain number (dates are not used). */
export function parseRetryAfter(value: string | null | undefined): number | undefined {
  if (!value || !/^\d{1,9}$/.test(value.trim())) return undefined
  return Math.min(Number(value.trim()), MAX_RETRY_AFTER_SECONDS)
}

/** PUT /schedule: make the Worker's future alerts for this device match `alerts`. */
export async function uploadSchedule(
  baseUrl: string,
  account: PushAccount,
  alerts: readonly { fireAt: string; title: string; body: string }[],
  fetchFn: Fetch,
): Promise<Result<object>> {
  const sent = await call(fetchFn, `${baseUrl}/schedule`, post({ id: account.id, secret: account.secret, alerts }, 'PUT'))
  if (!('response' in sent)) return sent
  void sent.response.body?.cancel().catch(() => {})
  if (sent.response.ok) return { ok: true }
  const retryAfterSeconds = parseRetryAfter(sent.response.headers.get('retry-after'))
  return { ok: false, reason: reasonFor(sent.response.status), ...(retryAfterSeconds !== undefined && { retryAfterSeconds }) }
}
