import { useEffect, useState } from 'react'

/**
 * Current time, re-rendering on every whole second of the wall clock.
 * Also refreshes the moment the page becomes visible again (or is restored from the back/forward
 * cache), because timers are throttled or frozen while a tab is hidden or a phone is locked.
 */
export function useNow(): Date {
  const [now, setNow] = useState(() => new Date())

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>
    const tick = () => {
      setNow(new Date())
      // Aim at the next second boundary so the display doesn't drift or skip.
      timer = setTimeout(tick, 1000 - (Date.now() % 1000))
    }
    const restart = () => {
      clearTimeout(timer)
      tick()
    }
    const onVisibility = () => document.visibilityState === 'visible' && restart()

    timer = setTimeout(tick, 1000 - (Date.now() % 1000))
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('pageshow', restart)
    return () => {
      clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('pageshow', restart)
    }
  }, [])

  return now
}
