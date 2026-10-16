import {
  applicationServerKeyBytes,
  getPushSupport,
  type PushEnv,
  type PushSubscriptionLike,
} from './browser'
import { fetchPublicKey, registerSubscription, removeSubscription, sendTestPush, type FailureReason } from './client'
import { clearPushAccount, loadPushAccount, savePushAccount } from './storage'
import { clearUploadState } from './uploadState'

// The steps behind the Background alerts buttons. Each returns a plain result for the screen to turn into words.
// Rules for everything here: never log, and never put the secret or the subscription into a result.

export type OffNote = 'permission-revoked' | 'subscription-lost'

export type PushState =
  | { kind: 'unsupported' }
  | { kind: 'needs-home-screen' }
  /** Notifications are blocked for this site. `hadAccount`: they were on before, so they have been revoked. */
  | { kind: 'blocked'; hadAccount: boolean }
  /** Not on. `note` says why a previously enabled device is no longer working. */
  | { kind: 'off'; note?: OffNote }
  | { kind: 'on' }

/** What the Settings section tells the app when background alerts change, and why. */
export type PushChange = (state: PushState, cause: 'detected' | 'enabled' | 'test' | 'off') => void

const attempt = async <T>(fn: () => Promise<T>): Promise<T | undefined> => {
  try {
    return await fn()
  } catch {
    return undefined
  }
}

/** Works out the state from what the browser and this device's storage say right now. Never throws. */
export async function detectPushState(env: PushEnv): Promise<PushState> {
  const support = getPushSupport(env)
  if (support !== 'supported') return { kind: support }

  const account = loadPushAccount(env.storage)
  const permission = env.Notification!.permission
  if (permission === 'denied') return { kind: 'blocked', hadAccount: account !== null }
  if (!account) return { kind: 'off' }

  // Enabled before. It only counts as on if the browser still has the subscription and permission.
  let subscription: PushSubscriptionLike | null
  try {
    const registration = await env.serviceWorker!.getRegistration()
    subscription = (await registration?.pushManager.getSubscription()) ?? null
  } catch {
    return { kind: 'off' } // can't tell, so don't claim anything was lost
  }
  if (permission === 'granted' && subscription) return { kind: 'on' }
  return { kind: 'off', note: permission === 'granted' ? 'subscription-lost' : 'permission-revoked' }
}

export type EnableFailure =
  | 'unsupported'
  | 'needs-home-screen'
  | 'permission-denied'
  | 'permission-dismissed'
  | 'server-unavailable'
  | 'rate-limited'
  | 'network'
  | 'worker-not-ready'
  | 'subscribe-failed'
  | 'storage-failed'
  | 'error'
export type EnableResult = { ok: true } | { ok: false; reason: EnableFailure }

async function requestPermission(env: PushEnv): Promise<'granted' | 'denied' | 'default'> {
  try {
    const N = env.Notification!
    const result = await new Promise<string>((resolve, reject) => {
      const maybe = N.requestPermission((p) => resolve(p))
      if (maybe && typeof maybe.then === 'function') maybe.then(resolve, reject)
    })
    return result === 'granted' || result === 'denied' ? result : 'default'
  } catch {
    return 'denied'
  }
}

/** The promise's value, or undefined if it fails or has not settled within `ms`. */
async function within<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([promise, new Promise<undefined>((resolve) => (timer = setTimeout(() => resolve(undefined), ms)))])
  } catch {
    return undefined
  } finally {
    clearTimeout(timer)
  }
}

function sameKey(subscription: PushSubscriptionLike, key: Uint8Array): boolean {
  const existing = subscription.options?.applicationServerKey
  if (!existing) return true // unknown: let the browser decide when subscribing
  const bytes = new Uint8Array(existing)
  return bytes.length === key.length && bytes.every((b, i) => b === key[i])
}

const enableFailureFor = (reason: FailureReason): EnableFailure =>
  reason === 'rate-limited' ? 'rate-limited' : reason === 'unavailable' ? 'server-unavailable' : reason === 'network' ? 'network' : 'error'

/**
 * Turns background alerts on: permission, the Worker's public key, the browser's push subscription, the Worker's
 * /subscribe, then saving the id and secret. If any step fails, what was done before it is undone, so a failure
 * never leaves a half-set-up subscription behind. Call it straight from a tap: the permission prompt has to be
 * the first thing it does.
 */
export async function enableBackgroundAlerts(env: PushEnv): Promise<EnableResult> {
  const support = getPushSupport(env)
  if (support !== 'supported' || !env.workerUrl) {
    return { ok: false, reason: support === 'needs-home-screen' ? 'needs-home-screen' : 'unsupported' }
  }
  const workerUrl = env.workerUrl

  // 1. Permission. Nothing is awaited before this, so browsers still count it as coming from the tap.
  const permission = await requestPermission(env)
  if (permission === 'denied') return { ok: false, reason: 'permission-denied' }
  if (permission !== 'granted') return { ok: false, reason: 'permission-dismissed' }

  // 2. The Worker's public key.
  const key = await fetchPublicKey(workerUrl, env.fetch)
  if (!key.ok) return { ok: false, reason: enableFailureFor(key.reason) }
  const keyBytes = applicationServerKeyBytes(key.publicKey)
  if (!keyBytes) return { ok: false, reason: 'error' }

  // 3. The browser's push subscription. The service worker must be active first.
  const registration = await within(env.serviceWorker!.ready, env.workerReadyTimeoutMs)
  if (!registration) return { ok: false, reason: 'worker-not-ready' }
  const manager = registration.pushManager

  let existing = (await attempt(() => manager.getSubscription())) ?? null
  if (existing && !sameKey(existing, keyBytes)) {
    // Made for a different key (the Worker's key was replaced): it can't be reused.
    await attempt(() => existing!.unsubscribe())
    existing = null
  }
  let created = existing === null
  const subscribe = () => manager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes })
  let subscription: PushSubscriptionLike
  try {
    subscription = await subscribe()
  } catch (error) {
    // InvalidStateError: a subscription with another key exists and its key wasn't readable above.
    if ((error as { name?: string } | null)?.name !== 'InvalidStateError') return { ok: false, reason: 'subscribe-failed' }
    const stale = await attempt(() => manager.getSubscription())
    if (stale) await attempt(() => stale.unsubscribe())
    created = true
    try {
      subscription = await subscribe()
    } catch {
      return { ok: false, reason: 'subscribe-failed' }
    }
  }

  const undoSubscription = async () => {
    await attempt(() => subscription.unsubscribe())
  }

  // 4. Tell the Worker.
  const registered = await registerSubscription(workerUrl, subscription.toJSON(), env.fetch)
  if (!registered.ok) {
    if (created) await undoSubscription()
    return { ok: false, reason: enableFailureFor(registered.reason) }
  }

  // 5. Keep the id and secret. Without them the device can neither test nor turn this off, so if they can't
  // be saved, undo everything.
  const account = { id: registered.id, secret: registered.secret }
  const previous = loadPushAccount(env.storage)
  if (!savePushAccount(account, env.storage)) {
    await removeSubscription(workerUrl, account, env.fetch)
    await undoSubscription()
    return { ok: false, reason: 'storage-failed' }
  }

  clearUploadState(env.storage) // a new subscription has no schedule yet

  // A device that was enabled before and lost its subscription leaves a dead one on the Worker: remove it
  // (it is a different id; the same endpoint would have kept its id). Failing to is harmless.
  if (previous && previous.id !== account.id) await removeSubscription(workerUrl, previous, env.fetch)
  return { ok: true }
}

async function unsubscribeBrowser(env: PushEnv): Promise<void> {
  await attempt(async () => {
    const registration = await env.serviceWorker?.getRegistration()
    const subscription = await registration?.pushManager.getSubscription()
    await subscription?.unsubscribe()
  })
}

export type TestResult =
  | { ok: true }
  /** `reset`: the saved id and secret and the browser subscription were cleared, so it must be enabled again. */
  | { ok: false; reason: FailureReason | 'not-enabled'; reset: boolean }

/** The Worker no longer knows this device: drop the browser's subscription and the saved id, secret and upload record. */
export async function resetDevice(env: PushEnv): Promise<void> {
  await unsubscribeBrowser(env)
  clearPushAccount(env.storage)
  clearUploadState(env.storage)
}

/** Has the Worker send this device a test notification. A subscription the Worker has dropped is reset. */
export async function sendTestNotification(env: PushEnv): Promise<TestResult> {
  const account = loadPushAccount(env.storage)
  if (!account || !env.workerUrl) return { ok: false, reason: 'not-enabled', reset: false }

  const result = await sendTestPush(env.workerUrl, account, env.fetch)
  if (result.ok) return { ok: true }
  if (result.reason === 'gone' || result.reason === 'unauthorized') {
    await resetDevice(env)
    return { ok: false, reason: result.reason, reset: true }
  }
  return { ok: false, reason: result.reason, reset: false }
}

export interface TurnOffResult {
  /** The Worker confirmed it forgot this device (or never knew it). If not, it will clean up on its own later. */
  serverRemoved: boolean
  /** The saved id and secret are gone from this device. */
  cleared: boolean
}

/**
 * Turns background alerts off: the Worker forgets this device, the browser drops its subscription, and the saved id
 * and secret are cleared. All three are attempted even if one fails, because the person asked to stop.
 */
export async function turnOffBackgroundAlerts(env: PushEnv): Promise<TurnOffResult> {
  const account = loadPushAccount(env.storage)
  let serverRemoved = true
  if (account && env.workerUrl) {
    const result = await removeSubscription(env.workerUrl, account, env.fetch)
    // 401/410: the Worker doesn't have it any more, which is the goal.
    serverRemoved = result.ok || result.reason === 'unauthorized' || result.reason === 'gone'
  }
  await unsubscribeBrowser(env)
  clearUploadState(env.storage)
  return { serverRemoved, cleared: clearPushAccount(env.storage) }
}
