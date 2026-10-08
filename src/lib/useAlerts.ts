import { useEffect, useRef, useState } from 'react'
import {
  ALERT_LOOKBACK_MS,
  bannerMessage,
  getDueAlerts,
  isBannerExpired,
  isFreshAlert,
  loadFired,
  pruneFired,
  saveFired,
  stampOpenSeen,
  type DueAlert,
  type FiredAlerts,
} from './alerts'
import { alertSound } from './alertSound'
import {
  areNotificationsSupported,
  decideAlertDelivery,
  getNotificationPermission,
  showAlertNotification,
} from './notifications'
import type { AlertSettings } from './alertSettings'
import type { PresetGroup } from './tradingWindow'

/**
 * Raises an alert banner (and a quiet sound) when a window's alert time arrives.
 * Pass only the windows that are switched on. Each occurrence alerts once: shown alerts are
 * remembered in localStorage, so a refresh during the alert minute doesn't repeat it.
 */
export function useAlerts(groups: PresetGroup[], settings: AlertSettings, now: Date) {
  const [banners, setBanners] = useState<DueAlert[]>([])
  const firedRef = useRef<FiredAlerts | null>(null)
  if (firedRef.current === null) firedRef.current = loadFired()

  // Browsers only allow sound after a click, tap or key press, so unlock audio on the first one.
  useEffect(() => {
    const unlock = () => {
      alertSound.unlock()
      if (alertSound.isUnlocked()) stop()
    }
    const events = ['pointerdown', 'keydown'] as const
    const stop = () => events.forEach((e) => window.removeEventListener(e, unlock))
    events.forEach((e) => window.addEventListener(e, unlock))
    return stop
  }, [])

  // When alerts were last checked. After a pause (locked phone, background tab) `now` jumps forward
  // and everything that came due in between is caught up, once.
  const lastCheckRef = useRef<number | null>(null)

  useEffect(() => {
    const nowMs = now.getTime()
    const since = new Date(lastCheckRef.current ?? nowMs - ALERT_LOOKBACK_MS)
    lastCheckRef.current = nowMs

    const visible = typeof document === 'undefined' || document.visibilityState === 'visible'
    const fired = firedRef.current!
    const due = getDueAlerts(groups, settings.lead, now, fired, since)
    if (due.length > 0) {
      for (const alert of due) fired.set(alert.key, alert.openAtMs)
      firedRef.current = pruneFired(fired, nowMs)
      saveFired(firedRef.current)
      // A catch-up alert older than a minute is shown quietly.
      if (settings.soundOn && due.some((d) => isFreshAlert(d, now))) void alertSound.play()
      // Hidden page: a system notification with the banner's text. Visible page: the banner alone.
      const delivery = decideAlertDelivery({
        pageVisible: visible,
        notificationsEnabled: settings.notificationsOn,
        supported: areNotificationsSupported(),
        permission: getNotificationPermission(),
      })
      if (delivery.notification) for (const d of due) showAlertNotification(bannerMessage(d, now), d.key)
    }
    setBanners((prev) => {
      const added = due.filter((d) => !prev.some((p) => p.key === d.key))
      const all = stampOpenSeen([...prev, ...added], now, visible)
      const live = all.filter((b) => !isBannerExpired(b, now))
      return added.length === 0 && live.length === prev.length && live.every((b, i) => b === prev[i]) ? prev : live
    })
  }, [groups, settings.lead, settings.soundOn, settings.notificationsOn, now])

  const dismiss = (key: string) => setBanners((prev) => prev.filter((b) => b.key !== key))
  // Expired banners are dropped in the effect above; filtering here too means one is never drawn for a frame.
  return { banners: banners.filter((b) => !isBannerExpired(b, now)), dismiss }
}
