import { PRESET_GROUPS } from '../config/presets'
import { getHourTicks, getNowFraction, getTimelineSegments } from '../lib/timeline'
import { sortWindowsByStatus } from '../lib/windowStatus'

interface Props {
  now: Date
  timeZone: string
}

const pct = (fraction: number) => `${fraction * 100}%`

export function Timeline({ now, timeZone }: Props) {
  // Same order as the list below: groups in order, active windows first within each.
  const rows = PRESET_GROUPS.flatMap((group) => sortWindowsByStatus(group.windows, now, timeZone))
  const ticks = getHourTicks(now, timeZone)

  return (
    <section aria-label="Today's timeline" className="w-full max-w-2xl">
      <div className="relative">
        <div className="space-y-1.5">
          {rows.map(({ window, status }) => {
            const active = status.kind === 'active'
            return (
              <div key={window.id} className="flex items-center" title={window.name}>
                <span className="mr-3 hidden w-28 shrink-0 truncate text-xs text-neutral-400 sm:block">
                  {window.name}
                </span>
                <div className="relative h-3 flex-1 overflow-hidden rounded-sm bg-neutral-900">
                  {getTimelineSegments(window, now, timeZone).map((seg) => (
                    <div
                      key={seg.start}
                      className={`absolute inset-y-0 min-w-0.5 rounded-sm ${active ? 'opacity-100' : 'opacity-30'}`}
                      style={{
                        left: pct(seg.start),
                        width: pct(seg.end - seg.start),
                        backgroundColor: window.color,
                      }}
                    />
                  ))}
                </div>
              </div>
            )
          })}
        </div>

        {/* Overlay aligned with the bar tracks (skips the name column on wider screens). */}
        <div className="pointer-events-none absolute inset-y-0 right-0 left-0 sm:left-[7.75rem]">
          {ticks.map((tick) => (
            <div
              key={tick.label}
              className="absolute inset-y-0 w-px bg-neutral-800/70"
              style={{ left: pct(tick.fraction) }}
            />
          ))}
          <div
            className="absolute -inset-y-1 w-0.5 -translate-x-1/2 rounded-full bg-white shadow-[0_0_6px_rgba(255,255,255,0.6)]"
            style={{ left: pct(getNowFraction(now, timeZone)) }}
            aria-label="Now"
          />
        </div>
      </div>

      <div className="relative mt-2 h-4 sm:ml-[7.75rem]" aria-hidden>
        {ticks.map((tick) => (
          <span
            key={tick.label}
            className="absolute -translate-x-1/2 font-mono text-[10px] text-neutral-500"
            style={{ left: pct(tick.fraction) }}
          >
            {tick.label}
          </span>
        ))}
      </div>
    </section>
  )
}
