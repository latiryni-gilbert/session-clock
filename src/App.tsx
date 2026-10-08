import { Settings } from './components/Settings'
import { Timeline } from './components/Timeline'
import { WindowList } from './components/WindowList'
import { PRESET_GROUPS } from './config/presets'
import { formatClock, getLocalTimeZone } from './lib/formatTime'
import { useNow } from './lib/useNow'
import { useWindowSettings } from './lib/useWindowSettings'
import { applySettings } from './lib/windowSettings'

const timeZone = getLocalTimeZone()

function App() {
  const now = useNow()
  const { disabled, update, saveFailed } = useWindowSettings()
  const groups = applySettings(PRESET_GROUPS, disabled)

  return (
    <main className="relative flex min-h-screen flex-col items-center gap-12 px-4 py-12 sm:py-16">
      <Settings disabled={disabled} onChange={update} saveFailed={saveFailed} />
      <header className="flex flex-col items-center gap-3 text-center">
        <h1 className="text-sm font-medium uppercase tracking-[0.3em] text-neutral-400">
          Session Clock
        </h1>
        <time
          dateTime={now.toISOString()}
          className="font-mono text-6xl font-semibold tabular-nums sm:text-8xl"
        >
          {formatClock(now, timeZone)}
        </time>
        <p className="text-neutral-500">{timeZone}</p>
      </header>
      {groups.length > 0 ? (
        <>
          <Timeline groups={groups} now={now} timeZone={timeZone} />
          <WindowList groups={groups} now={now} timeZone={timeZone} />
        </>
      ) : (
        <p className="text-neutral-500">All windows are hidden. Open settings (the gear) to show some.</p>
      )}
    </main>
  )
}

export default App
