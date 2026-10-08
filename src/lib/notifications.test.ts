import { describe, expect, it } from 'vitest'
import {
  areNotificationsSupported,
  decideAlertDelivery,
  getNotificationPermission,
  hasNotificationFailed,
  requestNotificationPermission,
  showAlertNotification,
  type DeliveryInput,
  type NotificationCtorLike,
  type NotificationEnv,
  type NotificationLike,
} from './notifications'

function fakeEnv(permission = 'default', opts: { secure?: boolean; requestResult?: string; legacyCallback?: boolean; requestThrows?: boolean; ctorThrows?: boolean } = {}) {
  const shown: { title: string; options?: { body?: string; tag?: string }; instance: NotificationLike & { closed: number } }[] = []
  const calls = { requests: 0, focus: 0, constructed: 0 }
  class N {
    static permission = permission
    static requestPermission(callback?: (p: string) => void) {
      calls.requests++
      if (opts.requestThrows) throw new Error('nope')
      const result = opts.requestResult ?? 'granted'
      N.permission = result
      if (opts.legacyCallback) {
        callback?.(result)
        return undefined
      }
      return Promise.resolve(result)
    }
    onclick: ((e: unknown) => void) | null = null
    closed = 0
    constructor(title: string, options?: { body?: string; tag?: string }) {
      calls.constructed++
      if (opts.ctorThrows) throw new TypeError('Illegal constructor')
      shown.push({ title, options, instance: this })
    }
    close() {
      this.closed++
    }
  }
  const env: NotificationEnv = {
    Notification: N as unknown as NotificationCtorLike,
    isSecureContext: opts.secure ?? true,
    focus: () => void calls.focus++,
  }
  return { env, shown, calls }
}

const input = (patch: Partial<DeliveryInput> = {}): DeliveryInput => ({
  pageVisible: false,
  notificationsEnabled: true,
  supported: true,
  permission: 'granted',
  ...patch,
})

describe('decideAlertDelivery: notification or banner?', () => {
  it('sends a system notification (and keeps the banner) when the page is hidden', () => {
    expect(decideAlertDelivery(input())).toEqual({ banner: true, notification: true })
  })

  it('shows only the banner when the page is visible, never both', () => {
    expect(decideAlertDelivery(input({ pageVisible: true }))).toEqual({ banner: true, notification: false })
  })

  it('shows only the banner when the switch is off', () => {
    expect(decideAlertDelivery(input({ notificationsEnabled: false }))).toEqual({ banner: true, notification: false })
  })

  it('shows only the banner when notifications are not supported', () => {
    expect(decideAlertDelivery(input({ supported: false }))).toEqual({ banner: true, notification: false })
  })

  it('shows only the banner unless permission is granted (denied, or never asked)', () => {
    for (const permission of ['denied', 'default'] as const) {
      expect(decideAlertDelivery(input({ permission }))).toEqual({ banner: true, notification: false })
    }
  })

  it('always includes the banner, for every combination', () => {
    for (const pageVisible of [true, false]) {
      for (const notificationsEnabled of [true, false]) {
        for (const supported of [true, false]) {
          for (const permission of ['default', 'granted', 'denied'] as const) {
            const d = decideAlertDelivery({ pageVisible, notificationsEnabled, supported, permission })
            expect(d.banner).toBe(true)
            // A notification only ever goes out when the page is hidden.
            if (d.notification) expect(pageVisible).toBe(false)
          }
        }
      }
    }
  })
})

describe('areNotificationsSupported / getNotificationPermission', () => {
  it('is supported where the Notification API exists on a secure page', () => {
    expect(areNotificationsSupported(fakeEnv().env)).toBe(true)
  })
  it('is not supported without the API (iPhone Safari outside a Home Screen app) or on an insecure page', () => {
    expect(areNotificationsSupported({})).toBe(false)
    expect(areNotificationsSupported(fakeEnv('default', { secure: false }).env)).toBe(false)
  })
  it('reads the live permission, and treats unsupported as denied', () => {
    expect(getNotificationPermission(fakeEnv('granted').env)).toBe('granted')
    expect(getNotificationPermission(fakeEnv('denied').env)).toBe('denied')
    expect(getNotificationPermission(fakeEnv('default').env)).toBe('default')
    expect(getNotificationPermission({})).toBe('denied')
  })
  it('does not throw if the environment misbehaves', () => {
    const hostile = {
      get Notification(): never {
        throw new Error('boom')
      },
    } as unknown as NotificationEnv
    expect(areNotificationsSupported(hostile)).toBe(false)
    expect(getNotificationPermission(hostile)).toBe('denied')
  })
})

describe('requestNotificationPermission', () => {
  it('asks the browser exactly once and returns the answer', async () => {
    const { env, calls } = fakeEnv('default', { requestResult: 'granted' })
    expect(calls.requests).toBe(0) // nothing is requested just by having the environment
    await expect(requestNotificationPermission(env)).resolves.toBe('granted')
    expect(calls.requests).toBe(1)
  })
  it('returns denied when the user blocks it', async () => {
    await expect(requestNotificationPermission(fakeEnv('default', { requestResult: 'denied' }).env)).resolves.toBe('denied')
  })
  it('returns default when the prompt is dismissed', async () => {
    await expect(requestNotificationPermission(fakeEnv('default', { requestResult: 'default' }).env)).resolves.toBe('default')
  })
  it('works with the older callback form of requestPermission', async () => {
    await expect(requestNotificationPermission(fakeEnv('default', { legacyCallback: true }).env)).resolves.toBe('granted')
  })
  it('answers denied, without throwing, if unsupported or the request fails', async () => {
    await expect(requestNotificationPermission({})).resolves.toBe('denied')
    await expect(requestNotificationPermission(fakeEnv('default', { requestThrows: true }).env)).resolves.toBe('denied')
  })
})

describe('showAlertNotification', () => {
  it('shows a notification with the banner text and a tag, only when permission is granted', () => {
    const { env, shown } = fakeEnv('granted')
    expect(showAlertNotification('London opens in 15 minutes', 'forex-london@1', env)).toBe(true)
    expect(shown).toHaveLength(1)
    expect(shown[0].title).toBe('London opens in 15 minutes')
    expect(shown[0].options?.tag).toBe('forex-london@1')
  })
  it('shows nothing when permission is denied, not yet asked, or unsupported', () => {
    for (const p of ['denied', 'default']) {
      const { env, shown } = fakeEnv(p)
      expect(showAlertNotification('x', 'k', env)).toBe(false)
      expect(shown).toHaveLength(0)
    }
    expect(showAlertNotification('x', 'k', {})).toBe(false)
  })
  it('clicking it focuses the tab and closes the notification', () => {
    const { env, shown, calls } = fakeEnv('granted')
    showAlertNotification('x', 'k', env)
    shown[0].instance.onclick?.({})
    expect(calls.focus).toBe(1)
    expect(shown[0].instance.closed).toBe(1)
  })
  it('still closes the notification, without throwing, if focusing is refused', () => {
    const { env, shown } = fakeEnv('granted')
    env.focus = () => {
      throw new Error('blocked')
    }
    showAlertNotification('x', 'k', env)
    expect(() => shown[0].instance.onclick?.({})).not.toThrow()
    expect(shown[0].instance.closed).toBe(1)
  })
  it('returns false instead of throwing when the browser refuses (e.g. Chrome on Android)', () => {
    expect(showAlertNotification('x', 'k', fakeEnv('granted', { ctorThrows: true }).env)).toBe(false)
  })
})

describe('fallback when the browser refuses to create a notification (Chrome on Android)', () => {
  it('does not throw, reports failure, and marks notifications unavailable for the session', () => {
    const { env } = fakeEnv('granted', { ctorThrows: true })
    expect(areNotificationsSupported(env)).toBe(true) // the API exists, so it looks usable at first
    expect(hasNotificationFailed(env)).toBe(false)

    expect(() => showAlertNotification('London opens in 15 minutes', 'k', env)).not.toThrow()
    expect(showAlertNotification('London opens in 15 minutes', 'k2', env)).toBe(false)

    expect(hasNotificationFailed(env)).toBe(true)
    expect(areNotificationsSupported(env)).toBe(false) // so the settings switch is hidden, with the "not available" note
    expect(getNotificationPermission(env)).toBe('denied')
  })

  it('tries only once: after the first failure it does not construct another notification', () => {
    const { env, calls } = fakeEnv('granted', { ctorThrows: true })
    showAlertNotification('a', 'k1', env)
    showAlertNotification('b', 'k2', env)
    showAlertNotification('c', 'k3', env)
    expect(calls.constructed).toBe(1)
  })

  it('leaves the in-page banner as the delivery once notifications are unavailable', () => {
    const { env } = fakeEnv('granted', { ctorThrows: true })
    const before = decideAlertDelivery({
      pageVisible: false,
      notificationsEnabled: true,
      supported: areNotificationsSupported(env),
      permission: getNotificationPermission(env),
    })
    expect(before).toEqual({ banner: true, notification: true }) // the first attempt is made...
    showAlertNotification('x', 'k', env) // ...and fails
    const after = decideAlertDelivery({
      pageVisible: false,
      notificationsEnabled: true,
      supported: areNotificationsSupported(env),
      permission: getNotificationPermission(env),
    })
    expect(after).toEqual({ banner: true, notification: false })
  })

  it('only affects the environment where it failed', () => {
    const broken = fakeEnv('granted', { ctorThrows: true }).env
    const fine = fakeEnv('granted')
    showAlertNotification('x', 'k', broken)
    expect(areNotificationsSupported(fine.env)).toBe(true)
    expect(showAlertNotification('y', 'k', fine.env)).toBe(true)
    expect(fine.shown).toHaveLength(1)
  })

  it('a missing permission is not a failure, so the switch stays available', () => {
    for (const p of ['default', 'denied']) {
      const { env } = fakeEnv(p)
      expect(showAlertNotification('x', 'k', env)).toBe(false)
      expect(hasNotificationFailed(env)).toBe(false)
      expect(areNotificationsSupported(env)).toBe(true)
    }
  })
})
