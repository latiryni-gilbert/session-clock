import { DateTime } from 'luxon'
import { formatTimeRange } from '../lib/formatTime'
import type { PresetGroup, TradingWindow } from '../lib/tradingWindow'
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
      className={`grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-0.5 rounded-lg border px-4 py-3 ${
        active
          ? 'border-emerald-500/60 bg-emerald-500/10'
          : 'border-neutral-800 bg-neutral-900/40'
      }`}
    >
      <span
        aria-hidden
        className={`row-span-2 size-3 rounded-full ${active ? 'ring-4 ring-emerald-500/30' : 'opacity-60'}`}
        style={{ backgroundColor: window.color }}
      />
      <p className={`truncate font-medium ${active ? 'text-white' : 'text-neutral-200'}`}>{window.name}</p>
      <p
        className={`whitespace-nowrap text-right text-sm ${
          active ? 'font-semibold text-emerald-300' : 'text-sky-300'
        }`}
      >
        {statusLabel(status)}
      </p>
      {/* Spans the name and status columns so the range never wraps, even on phones. */}
      <p className="col-span-2 whitespace-nowrap font-mono text-xs tabular-nums text-neutral-500 sm:text-sm">
        {times}
      </p>
    </li>
  )
}

export function WindowList({ groups, now, timeZone }: Props & { groups: PresetGroup[] }) {
  return (
    <div className="w-full max-w-2xl space-y-8">
      {groups.map((group) => (
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
