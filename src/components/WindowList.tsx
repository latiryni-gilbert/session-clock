import { DateTime } from 'luxon'
import { PRESET_GROUPS } from '../config/presets'
import { formatTimeRange } from '../lib/formatTime'
import type { TradingWindow } from '../lib/tradingWindow'
import { getWindowStatus, statusLabel } from '../lib/windowStatus'

interface Props {
  now: Date
  timeZone: string
}

function WindowRow({ window, now, timeZone }: Props & { window: TradingWindow }) {
  const status = getWindowStatus(window, now, timeZone)
  const active = status.kind === 'active'
  const times =
    status.kind === 'closed' && !status.start
      ? 'Not today'
      : formatTimeRange(status.start!, status.end!, DateTime.fromJSDate(now, { zone: timeZone }))

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
          active ? 'font-semibold text-emerald-300' : status.kind === 'upcoming' ? 'text-sky-300' : 'text-neutral-500'
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
            {group.windows.map((w) => (
              <WindowRow key={w.id} window={w} now={now} timeZone={timeZone} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  )
}
