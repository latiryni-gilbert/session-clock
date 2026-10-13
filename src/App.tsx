import { AlertBanners } from './components/AlertBanners'
import { NextEvent } from './components/NextEvent'
import { Settings } from './components/Settings'
import { Timeline } from './components/Timeline'
import { UpdatePrompt } from './components/UpdatePrompt'
import { WindowList } from './components/WindowList'
import { buildGroups } from './lib/customWindows'
import { formatClock, getLocalTimeZone } from './lib/formatTime'
import { getNewsMarkers } from './lib/timeline'
import { useAlerts } from './lib/useAlerts'
import { useNewsSettings } from './lib/useNewsSettings'
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
  const { news, saveFailed: newsSaveFailed, setEnabled: setNewsEnabled, setAlertLead: setNewsAlertLead } = useNewsSettings()
  const allGroups = buildGroups(custom)
  const groups = applySettings(allGroups, disabled)
  // Only windows that are switched on raise alerts.
  // News events raise alerts only while the news switch is on.
  const { banners, dismiss, notificationsFailed } = useAlerts(groups, alerts, now, news.enabled ? news.alertLead : null)
  const newsMarkers = news.enabled ? getNewsMarkers(now, timeZone) : []

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
        notificationsFailed={notificationsFailed}
        detectedTimeZone={timeZone}
        news={news}
        onNewsEnabledChange={setNewsEnabled}
        onNewsAlertLeadChange={setNewsAlertLead}
        saveFailed={saveFailed || newsSaveFailed}
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
        {news.enabled && <NextEvent now={now} timeZone={timeZone} />}
      </header>
      {groups.length > 0 ? (
        <>
          <Timeline groups={groups} now={now} timeZone={timeZone} news={newsMarkers} />
          <WindowList groups={groups} now={now} timeZone={timeZone} />
        </>
      ) : (
        <p className="text-neutral-500">All windows are hidden. Open settings (the gear) to show some.</p>
      )}
      <UpdatePrompt />
    </main>
  )
}

export default App
