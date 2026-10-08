import { DateTime } from 'luxon'
import { PRESET_GROUPS } from '../config/presets'
import { formatTimeRange } from '../lib/formatTime'
import type { TradingWindow } from '../lib/tradingWindow'
import { sortWindowsByStatus, statusLabel, type WindowStatus } from '../lib/windowStatus'

interface Props {
  now: Date
  timeZone: string
}

function WindowRow({
  window,
  status,
  now,
  timeZone,
}: Props & { window: TradingWindow; status: WindowStatus }) {
  const active = status.kind === 'active'
  // When the label already names the day ("Opens Sun 18:00"), tag the times relative to the open instead of today.
  const farAway = status.kind === 'upcoming' && status.opensInMs > 24 * 60 * 60 * 1000
  const reference = farAway ? status.start : DateTime.fromJSDate(now, { zone: timeZone })
  const times = formatTimeRange(status.start, status.end, reference)

  return (
    <li
      className={`flex items-center gap-3 rounded-lg border px-4 py-3 ${
        active
          ? 'border-emerald-500/60 bg-emerald-500/10'
          : 'border-neutral-800 bg-neutral-900/40'
      }`}
    >
      <span
        aria-hidden
        className={`size-3 shrink-0 rounded-full ${active ? 'ring-4 ring-emerald-500/30' : 'opacity-60'}`}
        style={{ backgroundColor: window.color }}
      />
      <div className="min-w-0 flex-1">
        <p className={`truncate font-medium ${active ? 'text-white' : 'text-neutral-200'}`}>{window.name}</p>
        <p className="font-mono text-sm tabular-nums text-neutral-500">{times}</p>
      </div>
      <p
        className={`shrink-0 text-right text-sm ${
          active ? 'font-semibold text-emerald-300' : 'text-sky-300'
        }`}
      >
        {statusLabel(status)}
      </p>
    </li>
  )
}

export function WindowList({ now, timeZone }: Props) {
  return (
    <div className="w-full max-w-2xl space-y-8">
      {PRESET_GROUPS.map((group) => (
        <section key={group.name}>
          <h2 className="mb-3 text-xs font-medium uppercase tracking-[0.2em] text-neutral-500">{group.name}</h2>
          <ul className="space-y-2">
            {sortWindowsByStatus(group.windows, now, timeZone).map(({ window, status }) => (
              <WindowRow key={window.id} window={window} status={status} now={now} timeZone={timeZone} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  )
}
