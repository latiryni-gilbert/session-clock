import { getPushWorkerUrl } from './config'
import type { Fetch } from './client'
import { getStorage } from '../windowSettings'
import type { PushStorage } from './storage'

// The bits of the browser used for push, gathered in one object so tests can swap in fakes (the same approach as
// lib/notifications.ts). Nothing here ever logs.

export interface PushSubscriptionLike {
  options?: { applicationServerKey?: ArrayBuffer | null }
  toJSON(): unknown
  unsubscribe(): Promise<boolean>
}
export interface PushManagerLike {
  getSubscription(): Promise<PushSubscriptionLike | null>
  subscribe(options: { userVisibleOnly: boolean; applicationServerKey: Uint8Array }): Promise<PushSubscriptionLike>
}
export interface RegistrationLike {
  pushManager: PushManagerLike
}
export interface PushEnv {
  /** The Worker's address; null hides the feature. */
  workerUrl: string | null
  fetch: Fetch
  storage: PushStorage | null
  isSecureContext: boolean
  /** The page's Notification API, if it has one. */
  Notification?: {
    permission: string
    // Older Safari takes a callback instead of returning a promise; both are handled.
    requestPermission(callback?: (permission: string) => void): Promise<string> | undefined
  }
  hasPushManager: boolean
  serviceWorker?: {
    getRegistration(): Promise<RegistrationLike | undefined>
    ready: Promise<RegistrationLike>
  }
  isIos: boolean
  /** Running as an installed app (on iPhone: opened from the Home Screen) rather than in a browser tab. */
  isStandalone: boolean
  /** How long to wait for the service worker to become active before giving up. */
  workerReadyTimeoutMs: number
}

export type PushSupport = 'supported' | 'needs-home-screen' | 'unsupported'

/** iPhone and iPad (iPadOS reports itself as a Mac, but has a touch screen). */
export function detectIos(userAgent: string, platform: string, maxTouchPoints: number): boolean {
  return /iPhone|iPad|iPod/.test(userAgent) || (platform === 'MacIntel' && maxTouchPoints > 1)
}

/**
 * Whether this browser can do background alerts. On iPhone, push only works in an app added to the Home Screen
 * (iOS 16.4 or newer), not in a Safari tab, so that case is told apart to give the right instructions.
 */
export function getPushSupport(env: PushEnv): PushSupport {
  if (env.isIos && !env.isStandalone) return 'needs-home-screen'
  if (!env.isSecureContext || !env.serviceWorker || !env.hasPushManager || !env.Notification) return 'unsupported'
  return 'supported'
}

/** The real browser's environment, read now. */
export function browserPushEnv(): PushEnv {
  const nav = typeof navigator === 'undefined' ? undefined : navigator
  const win = typeof window === 'undefined' ? undefined : window
  const standalone =
    (nav as (Navigator & { standalone?: boolean }) | undefined)?.standalone === true ||
    (typeof win?.matchMedia === 'function' && win.matchMedia('(display-mode: standalone)').matches)
  return {
    workerUrl: getPushWorkerUrl(),
    fetch: (input, init) => fetch(input, init),
    storage: getStorage(),
    isSecureContext: win?.isSecureContext !== false,
    Notification: win && 'Notification' in win ? (win.Notification as unknown as PushEnv['Notification']) : undefined,
    hasPushManager: win !== undefined && 'PushManager' in win,
    serviceWorker: nav && 'serviceWorker' in nav ? (nav.serviceWorker as unknown as PushEnv['serviceWorker']) : undefined,
    isIos: nav ? detectIos(nav.userAgent, nav.platform, nav.maxTouchPoints ?? 0) : false,
    isStandalone: standalone,
    workerReadyTimeoutMs: 10_000,
  }
}

/** The VAPID public key (base64url, as the Worker serves it) as the bytes the push manager wants. */
export function applicationServerKeyBytes(publicKey: string): Uint8Array | null {
  try {
    const base64 = publicKey.replace(/-/g, '+').replace(/_/g, '/')
    const binary = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4))
    return Uint8Array.from(binary, (c) => c.charCodeAt(0))
  } catch {
    return null
  }
}
