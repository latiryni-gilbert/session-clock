export type NotificationPermissionState = 'default' | 'granted' | 'denied'

/** The few bits of the browser Notification API used here, so they can be faked in tests. */
export interface NotificationLike {
  onclick: ((event: unknown) => void) | null
  close(): void
}
export interface NotificationCtorLike {
  new (title: string, options?: { body?: string; tag?: string }): NotificationLike
  permission: string
  requestPermission(callback?: (permission: string) => void): Promise<string> | undefined
}
export interface NotificationEnv {
  Notification?: NotificationCtorLike
  isSecureContext?: boolean
  focus?: () => void
}

/**
 * Environments in which creating a notification has thrown (Chrome on Android exposes the API but
 * only allows notifications from a service worker). Keyed by the environment object, so for the real
 * browser (always `window`) it lasts for the rest of the session, and a fake environment in a test
 * starts clean.
 */
const failedEnvs = new WeakSet<object>()

/** True once showing a notification has failed here; notifications are then treated as unavailable. */
export function hasNotificationFailed(env: NotificationEnv = browser()): boolean {
  return failedEnvs.has(env)
}

const browser = (): NotificationEnv => (typeof window === 'undefined' ? {} : (window as unknown as NotificationEnv))

const asPermission = (value: unknown): NotificationPermissionState =>
  value === 'granted' || value === 'denied' ? value : 'default'

/**
 * Whether this browser can show system notifications at all. iPhone Safari outside a Home Screen
 * app has no Notification API, notifications need a secure (https or localhost) page, and in a
 * browser where showing one has already failed (Chrome on Android) they count as unavailable.
 */
export function areNotificationsSupported(env: NotificationEnv = browser()): boolean {
  try {
    return typeof env.Notification === 'function' && env.isSecureContext !== false && !failedEnvs.has(env)
  } catch {
    return false
  }
}

/** The current permission, read fresh (the user can change it in browser settings at any time). */
export function getNotificationPermission(env: NotificationEnv = browser()): NotificationPermissionState {
  try {
    return areNotificationsSupported(env) ? asPermission(env.Notification!.permission) : 'denied'
  } catch {
    return 'denied'
  }
}

/**
 * Asks the browser for permission. Call it only from a click or tap (browsers require that), and
 * only when the user turns notifications on, never on page load. Never throws: if the request
 * fails, the answer is "denied".
 */
export async function requestNotificationPermission(env: NotificationEnv = browser()): Promise<NotificationPermissionState> {
  try {
    if (!areNotificationsSupported(env)) return 'denied'
    const N = env.Notification!
    // Older Safari takes a callback instead of returning a promise; handle both.
    const result = await new Promise<string>((resolve, reject) => {
      const maybe = N.requestPermission((p) => resolve(p))
      if (maybe && typeof maybe.then === 'function') maybe.then(resolve, reject)
    })
    return asPermission(result)
  } catch {
    return 'denied'
  }
}

/**
 * Shows a system notification. Clicking it brings this tab to the front. `tag` makes a repeat of
 * the same alert replace the earlier notification instead of stacking. Returns false (never throws)
 * if it couldn't be shown. If creating it throws, e.g. Chrome on Android, which only allows
 * notifications from a service worker, notifications are marked unavailable for the rest of the
 * session; the caller falls back to the in-page banner.
 */
export function showAlertNotification(text: string, tag: string, env: NotificationEnv = browser()): boolean {
  try {
    if (!areNotificationsSupported(env) || getNotificationPermission(env) !== 'granted') return false
    const n = new env.Notification!(text, { body: 'Session Clock', tag })
    n.onclick = () => {
      try {
        env.focus?.()
      } catch {
        // Focusing can be refused; still dismiss the notification.
      }
      try {
        n.close()
      } catch {
        // Already closed.
      }
    }
    return true
  } catch {
    failedEnvs.add(env)
    return false
  }
}

export interface DeliveryInput {
  /** Is this tab on screen right now? */
  pageVisible: boolean
  /** The user's "Desktop notifications" switch. */
  notificationsEnabled: boolean
  supported: boolean
  permission: NotificationPermissionState
}

export interface Delivery {
  /** Add the in-page banner. Always, so it is waiting (with the live countdown) when you come back. */
  banner: boolean
  /** Also send a system notification. Only when the page is hidden, so you never get both at once. */
  notification: boolean
}

/** Decides how an alert reaches the user: a banner always, plus a system notification only if the page is hidden and notifications are on and allowed. */
export function decideAlertDelivery({ pageVisible, notificationsEnabled, supported, permission }: DeliveryInput): Delivery {
  return {
    banner: true,
    notification: !pageVisible && notificationsEnabled && supported && permission === 'granted',
  }
}
