import { getHourTicks, getNowFraction, getTimelineSegments } from '../lib/timeline'
import type { PresetGroup } from '../lib/tradingWindow'
import { getWindowStatus } from '../lib/windowStatus'

interface Props {
  groups: PresetGroup[]
  now: Date
  timeZone: string
}

const pct = (fraction: number) => `${fraction * 100}%`

// Width of the short-label column (w-14 + mr-2 = 4rem), used to line up the overlay and hour labels.
const LABEL_COLUMN = '4rem'

export function Timeline({ groups, now, timeZone }: Props) {
  const ticks = getHourTicks(now, timeZone)

  return (
    <section aria-label="Today's timeline" className="w-full max-w-2xl">
      <div className="relative">
        {/* Rows stay in fixed preset order so bars don't jump as statuses change; only the list below re-sorts. */}
        <div className="space-y-3">
          {groups.map((group) => (
            <div key={group.name}>
              <h3 className="mb-1 text-[10px] font-medium uppercase tracking-[0.2em] text-neutral-500">
                {group.shortName}
              </h3>
              <div className="space-y-1.5">
                {group.windows.map((window) => {
                  const active = getWindowStatus(window, now, timeZone).kind === 'active'
                  return (
                    <div key={window.id} className="flex items-center" title={window.name}>
                      <span className="mr-2 w-14 shrink-0 truncate text-xs text-neutral-400">{window.shortName}</span>
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
            </div>
          ))}
        </div>

        {/* Overlay aligned with the bar tracks (skips the label column). */}
        <div className="pointer-events-none absolute inset-y-0 right-0" style={{ left: LABEL_COLUMN }}>
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

      <div className="relative mt-2 h-4" style={{ marginLeft: LABEL_COLUMN }} aria-hidden>
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
