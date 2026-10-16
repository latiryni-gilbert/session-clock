import { vi } from 'vitest'
import type { PushEnv, PushSubscriptionLike } from '../lib/push/browser'
import type { PushAccount } from '../lib/push/storage'
import { PUSH_STORAGE_KEY } from '../lib/push/storage'

/** A real VAPID public key (65 bytes, base64url), so the code that turns it into bytes runs for real. */
export const PUBLIC_KEY = 'BNwrDo_4rqZSEExYbpQeGAL_ZxSY-eITMuB_LKhMOO5NA3CCVylt5AxQbVbI1bfIXYC8A8gGeJWrmxbGvTjnKwQ'
export const WORKER = 'https://push.example.workers.dev'

type Route = number | { status: number; body?: unknown } | Error | (() => Response | Promise<Response>)

export interface FakeOptions {
  workerUrl?: string | null
  /** What `Notification.permission` is when the page loads. */
  permission?: 'default' | 'granted' | 'denied'
  /** What the permission prompt returns. */
  answer?: string
  isIos?: boolean
  isStandalone?: boolean
  noServiceWorker?: boolean
  noPushManager?: boolean
  noNotification?: boolean
  insecure?: boolean
  /** Already enabled on this device: saved in storage. */
  account?: PushAccount
  /** A push subscription the browser already holds. */
  existing?: { applicationServerKey?: Uint8Array | null } | true
  /** Replace what a Worker endpoint answers: by path, e.g. '/test-push': 429. */
  routes?: Record<string, Route>
  storage?: 'ok' | 'cannot-write' | 'forgets' | 'unavailable' | 'cannot-clear'
  noRegistration?: boolean
  workerNeverReady?: boolean
  workerReadyTimeoutMs?: number
  /** Errors for the first calls to pushManager.subscribe. */
  subscribeErrors?: Error[]
  getSubscriptionThrows?: boolean
}

const keyBytes = (publicKey: string) => {
  const base64 = publicKey.replace(/-/g, '+').replace(/_/g, '/')
  return Uint8Array.from(atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4)), (c) => c.charCodeAt(0))
}

/** A browser, a service worker, a push manager, storage and a Worker to talk to, all fake, all inspectable. */
export function makeEnv(options: FakeOptions = {}) {
  const events: string[] = []
  const stored = new Map<string, string>()
  if (options.account) stored.set(PUSH_STORAGE_KEY, JSON.stringify(options.account))

  let counter = 0
  const makeSubscription = (key?: Uint8Array | null): PushSubscriptionLike & { unsubscribe: ReturnType<typeof vi.fn> } => {
    const n = ++counter
    const sub = {
      options: { applicationServerKey: key ? (key.buffer.slice(key.byteOffset, key.byteOffset + key.byteLength) as ArrayBuffer) : null },
      toJSON: () => ({
        endpoint: `https://fcm.googleapis.com/fcm/send/fake-endpoint-${n}`,
        expirationTime: null,
        keys: { p256dh: `fake-p256dh-${n}`, auth: `fake-auth-${n}` },
      }),
      unsubscribe: vi.fn(async () => {
        events.push('browser-unsubscribe')
        if (held.current === sub) held.current = null
        return true
      }),
    }
    return sub
  }
  const held: { current: (PushSubscriptionLike & { unsubscribe: ReturnType<typeof vi.fn> }) | null } = { current: null }
  if (options.existing) {
    const key = options.existing === true ? keyBytes(PUBLIC_KEY) : options.existing.applicationServerKey
    held.current = makeSubscription(key ?? undefined)
  }

  const subscribeErrors = [...(options.subscribeErrors ?? [])]
  const pushManager = {
    getSubscription: vi.fn(async () => {
      if (options.getSubscriptionThrows) throw new Error('getSubscription failed')
      return held.current
    }),
    subscribe: vi.fn(async (o: { userVisibleOnly: boolean; applicationServerKey: Uint8Array }) => {
      events.push('subscribe')
      const error = subscribeErrors.shift()
      if (error) throw error
      // Like a real PushManager: the same key returns the existing subscription, a different key is refused.
      const current = held.current
      if (current) {
        const existingKey = current.options?.applicationServerKey
        const same = !existingKey || (existingKey.byteLength === o.applicationServerKey.length && new Uint8Array(existingKey).every((b, i) => b === o.applicationServerKey[i]))
        if (!same) throw new DOMException('A subscription with a different applicationServerKey already exists', 'InvalidStateError')
        return current
      }
      held.current = makeSubscription(o.applicationServerKey)
      return held.current
    }),
  }
  const registration = { pushManager }

  const Notification = {
    permission: options.permission ?? 'default',
    requestPermission: vi.fn((callback?: (p: string) => void) => {
      events.push('permission')
      const answer = options.answer ?? 'granted'
      if (answer === 'granted' || answer === 'denied') Notification.permission = answer
      callback?.(answer)
      return Promise.resolve(answer)
    }),
  }

  const defaults: Record<string, Route> = {
    'GET /vapid-public-key': { status: 200, body: { publicKey: PUBLIC_KEY } },
    'POST /subscribe': { status: 200, body: { id: 'sub-id-1', secret: 'the-secret-value-1' } },
    'POST /test-push': { status: 200, body: { ok: true } },
    'POST /unsubscribe': { status: 200, body: { ok: true } },
  }
  const fetchCalls: Array<{ method: string; path: string; body: unknown; url: string; init: RequestInit }> = []
  const fetchMock = vi.fn(async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET'
    const path = new URL(url).pathname
    events.push(`fetch ${method} ${path}`)
    fetchCalls.push({ method, path, url, init, body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined })
    const route = options.routes?.[path] ?? options.routes?.[`${method} ${path}`] ?? defaults[`${method} ${path}`]
    if (route === undefined) return new Response('not found', { status: 404 })
    if (route instanceof Error) throw route
    if (typeof route === 'function') return route()
    const spec = typeof route === 'number' ? { status: route } : route
    return new Response(spec.body === undefined ? null : JSON.stringify(spec.body), { status: spec.status })
  })

  const mode = options.storage ?? 'ok'
  const storage =
    mode === 'unavailable'
      ? null
      : {
          getItem: (k: string) => stored.get(k) ?? null,
          setItem: (k: string, v: string) => {
            if (mode === 'cannot-write') throw new DOMException('quota', 'QuotaExceededError')
            if (mode === 'forgets') return // accepts the write, keeps nothing
            stored.set(k, v)
          },
          removeItem: (k: string) => {
            if (mode === 'cannot-clear') return
            stored.delete(k)
          },
        }

  const env: PushEnv = {
    workerUrl: options.workerUrl === undefined ? WORKER : options.workerUrl,
    fetch: fetchMock as unknown as PushEnv['fetch'],
    storage,
    isSecureContext: !options.insecure,
    Notification: options.noNotification ? undefined : Notification,
    hasPushManager: !options.noPushManager,
    serviceWorker: options.noServiceWorker
      ? undefined
      : {
          getRegistration: async () => (options.noRegistration ? undefined : registration),
          ready: options.workerNeverReady ? new Promise(() => {}) : Promise.resolve(registration),
        },
    isIos: options.isIos ?? false,
    isStandalone: options.isStandalone ?? false,
    workerReadyTimeoutMs: options.workerReadyTimeoutMs ?? 50,
  }

  return {
    env,
    events,
    fetchCalls,
    fetchMock,
    pushManager,
    Notification,
    held,
    /** The text in storage under the push key, or null. */
    saved: () => stored.get(PUSH_STORAGE_KEY) ?? null,
    stored,
  }
}
