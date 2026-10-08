import { AlertBanners } from './components/AlertBanners'
import { Settings } from './components/Settings'
import { Timeline } from './components/Timeline'
import { WindowList } from './components/WindowList'
import { buildGroups } from './lib/customWindows'
import { formatClock, getLocalTimeZone } from './lib/formatTime'
import { useAlerts } from './lib/useAlerts'
import { useNow } from './lib/useNow'
import { useWindows } from './lib/useWindows'
import { applySettings } from './lib/windowSettings'

const timeZone = getLocalTimeZone()

function App() {
  const now = useNow()
  const {
    custom,
    disabled,
    saveFailed,
    lastDeleted,
    alerts,
    setDisabled,
    addCustomWindow,
    editCustomWindow,
    deleteWindow,
    undoDelete,
    changeAlertLead,
    changeSoundOn,
    changeNotificationsOn,
  } = useWindows()
  const allGroups = buildGroups(custom)
  const groups = applySettings(allGroups, disabled)
  // Only windows that are switched on raise alerts.
  const { banners, dismiss } = useAlerts(groups, alerts, now)

  return (
    <main className="relative flex min-h-screen flex-col items-center gap-12 px-4 pt-16 pb-12 sm:py-16">
      <Settings
        groups={allGroups}
        disabled={disabled}
        onChange={setDisabled}
        onAddWindow={addCustomWindow}
        onEditWindow={editCustomWindow}
        onDeleteWindow={deleteWindow}
        onUndoDelete={undoDelete}
        lastDeleted={lastDeleted}
        alerts={alerts}
        onAlertLeadChange={changeAlertLead}
        onSoundChange={changeSoundOn}
        onNotificationsChange={changeNotificationsOn}
        detectedTimeZone={timeZone}
        saveFailed={saveFailed}
      />
      <AlertBanners banners={banners} now={now} onDismiss={dismiss} />
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
