import { useEffect, useRef, useState } from 'react'
import { getDueAlerts, isBannerExpired, loadFired, pruneFired, saveFired, type DueAlert, type FiredAlerts } from './alerts'
import { alertSound } from './alertSound'
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

  useEffect(() => {
    const fired = firedRef.current!
    const due = getDueAlerts(groups, settings.lead, now, fired)
    if (due.length > 0) {
      for (const alert of due) fired.set(alert.key, alert.openAtMs)
      firedRef.current = pruneFired(fired, now.getTime())
      saveFired(firedRef.current)
      setBanners((prev) => [...prev, ...due.filter((d) => !prev.some((p) => p.key === d.key))])
      if (settings.soundOn) void alertSound.play()
    }
    setBanners((prev) => (prev.some((b) => isBannerExpired(b, now)) ? prev.filter((b) => !isBannerExpired(b, now)) : prev))
  }, [groups, settings.lead, settings.soundOn, now])

  const dismiss = (key: string) => setBanners((prev) => prev.filter((b) => b.key !== key))
  return { banners, dismiss }
}
