import { getNextEvent } from '../lib/newsEvents'
import { FOREX_FACTORY_CALENDAR_URL, formatNextEvent } from '../lib/newsText'

interface Props {
  now: Date
  timeZone: string
}

/** "Next: CPI in 2h 15m (07:30)" plus a plain link to ForexFactory's calendar (no data is fetched from it). */
export function NextEvent({ now, timeZone }: Props) {
  const next = getNextEvent(now, timeZone)

  return (
    <p className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1 text-sm">
      {next && <span className="font-medium text-rose-300">{formatNextEvent(next)}</span>}
      <a
        href={FOREX_FACTORY_CALENDAR_URL}
        target="_blank"
        rel="noopener noreferrer"
        className="text-neutral-400 underline decoration-neutral-600 underline-offset-2 hover:text-white focus-visible:outline-2 focus-visible:outline-neutral-300"
      >
        Full calendar on ForexFactory<span aria-hidden> ↗</span>
        <span className="sr-only"> (opens in a new tab)</span>
      </a>
    </p>
  )
}
