import { WindowList } from './components/WindowList'
import { formatClock, getLocalTimeZone } from './lib/formatTime'
import { useNow } from './lib/useNow'

const timeZone = getLocalTimeZone()

function App() {
  const now = useNow()

  return (
    <main className="flex min-h-screen flex-col items-center gap-12 px-4 py-12 sm:py-16">
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
      <WindowList now={now} timeZone={timeZone} />
    </main>
  )
}

export default App
