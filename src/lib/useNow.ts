import { useEffect, useState } from 'react'

/** Current time, re-rendering on every whole second of the wall clock. */
export function useNow(): Date {
  const [now, setNow] = useState(() => new Date())

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>
    const tick = () => {
      setNow(new Date())
      // Aim at the next second boundary so the display doesn't drift or skip.
      timer = setTimeout(tick, 1000 - (Date.now() % 1000))
    }
    timer = setTimeout(tick, 1000 - (Date.now() % 1000))
    return () => clearTimeout(timer)
  }, [])

  return now
}
