// What the service worker does with a push message and with a click on the notification.
// Kept apart from src/sw.ts (which only registers them) so they can be unit tested without a service worker.

export interface PushMessage {
  title: string
  body: string
}

const MAX_TITLE_CHARS = 100
const MAX_BODY_CHARS = 300
const ICON_PATH = 'pwa-192x192.png'

/**
 * Shown when a push arrives without a usable {title, body}. A browser that has been told every push is
 * user-visible (`userVisibleOnly: true`) expects a notification for each one: Chrome shows its own
 * "updated in the background" notice if none is shown, and Safari may revoke the permission for it.
 * So an unusable payload still gets this plain notification, and none of its content is used.
 */
export const FALLBACK_MESSAGE: PushMessage = { title: 'Session Clock', body: 'Open Session Clock to see your alerts.' }

/** The {title, body} the Worker sends, or null for anything else: no data, invalid JSON, wrong types, empty title. Never throws. */
export function parsePushMessage(data: Pick<PushMessageData, 'json'> | null | undefined): PushMessage | null {
  try {
    const parsed: unknown = data?.json()
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
    const { title, body } = parsed as { title?: unknown; body?: unknown }
    if (typeof title !== 'string' || typeof body !== 'string' || title.trim() === '') return null
    return { title: title.slice(0, MAX_TITLE_CHARS), body: body.slice(0, MAX_BODY_CHARS) }
  } catch {
    return null
  }
}

/** Handles a `push` event: shows the notification, with the app icon. */
export function handlePush(event: PushEvent, registration: ServiceWorkerRegistration): void {
  const { title, body } = parsePushMessage(event.data) ?? FALLBACK_MESSAGE
  event.waitUntil(
    (async () => {
      try {
        await registration.showNotification(title, { body, icon: new URL(ICON_PATH, registration.scope).href })
      } catch {
        // If the browser refuses (the permission was just revoked) there is nothing more to do.
      }
    })(),
  )
}

/** Brings an open Session Clock window to the front, or opens one. Never rejects. */
async function focusOrOpenWindow(clients: Clients, scope: string): Promise<void> {
  try {
    const windows = await clients.matchAll({ type: 'window', includeUncontrolled: true })
    const ours = windows.filter((client) => client.url.startsWith(scope))
    const target = ours.find((c) => c.focused) ?? ours.find((c) => c.visibilityState === 'visible') ?? ours[0]
    if (target) {
      try {
        await target.focus()
        return
      } catch {
        // Some browsers refuse to focus; opening a window below is the next best thing.
      }
    }
    await clients.openWindow(scope)
  } catch {
    // Nothing useful to do if even that is refused.
  }
}

/** Handles a `notificationclick` event: closes the notification and shows the app. */
export function handleNotificationClick(event: NotificationEvent, clients: Clients, registration: ServiceWorkerRegistration): void {
  event.notification.close()
  event.waitUntil(focusOrOpenWindow(clients, registration.scope))
}
