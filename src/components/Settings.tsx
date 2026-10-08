import { useEffect, useRef, useState } from 'react'
import { ALERT_LEADS, getAlertLead, isAlertLead, type AlertLead, type AlertSettings } from '../lib/alertSettings'
import { alertSound } from '../lib/alertSound'
import { draftFromWindow, type DeletedWindow } from '../lib/customWindowActions'
import { CUSTOM_ID_PREFIX, emptyDraft, type WindowDraft } from '../lib/customWindows'
import type { PresetGroup, TradingWindow } from '../lib/tradingWindow'
import {
  getGroupState,
  isWindowEnabled,
  setGroupEnabled,
  setWindowEnabled,
  type DisabledIds,
} from '../lib/windowSettings'
import { ADD_WINDOW_FORM_ID, AddWindowForm } from './AddWindowForm'
import { Switch } from './Switch'

interface Props {
  groups: PresetGroup[]
  disabled: DisabledIds
  onChange: (next: DisabledIds) => void
  onAddWindow: (draft: WindowDraft) => boolean
  onEditWindow: (id: string, draft: WindowDraft) => boolean
  onDeleteWindow: (id: string) => void
  onUndoDelete: () => void
  lastDeleted: DeletedWindow | null
  alerts: AlertSettings
  onAlertLeadChange: (id: string, lead: AlertLead | null) => void
  onSoundChange: (soundOn: boolean) => void
  detectedTimeZone: string
  saveFailed: boolean
}

type View = 'list' | 'form' | 'confirm'

const iconButton =
  'flex size-11 shrink-0 items-center justify-center rounded-full text-neutral-400 hover:bg-neutral-800 hover:text-white focus-visible:outline-2 focus-visible:outline-neutral-400'

export function Settings({
  groups,
  disabled,
  onChange,
  onAddWindow,
  onEditWindow,
  onDeleteWindow,
  onUndoDelete,
  lastDeleted,
  alerts,
  onAlertLeadChange,
  onSoundChange,
  detectedTimeZone,
  saveFailed,
}: Props) {
  const [open, setOpen] = useState(false)
  const [view, setView] = useState<View>('list')
  // Held here, not in the form, so closing the panel mid-way doesn't lose what was typed.
  const [draft, setDraft] = useState(() => emptyDraft(detectedTimeZone))
  const [editing, setEditing] = useState<{ id: string; draft: WindowDraft } | null>(null)
  const [confirming, setConfirming] = useState<TradingWindow | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const gearRef = useRef<HTMLButtonElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const cancelDeleteRef = useRef<HTMLButtonElement>(null)

  // Closing the panel always returns it to the list; an unfinished "add" draft survives.
  const reset = () => {
    setOpen(false)
    setView('list')
    setEditing(null)
    setConfirming(null)
    setNote(null)
  }

  useEffect(() => {
    if (!open) return
    const gear = gearRef.current
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && reset()
    document.addEventListener('keydown', onKey)
    document.body.style.overflow = 'hidden' // keep the page from scrolling behind the panel
    closeRef.current?.focus()
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = ''
      gear?.focus()
    }
  }, [open])

  // Land on the safe choice when asked to confirm a delete.
  useEffect(() => {
    if (view === 'confirm') cancelDeleteRef.current?.focus()
  }, [view])

  const backToList = () => {
    setView('list')
    setEditing(null)
    setConfirming(null)
  }

  const isEditing = view === 'form' && editing !== null
  const title = view === 'confirm' ? 'Delete window' : isEditing ? 'Edit window' : 'Add window'

  return (
    <>
      <button
        ref={gearRef}
        type="button"
        aria-label="Settings"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
        className="absolute top-3 right-3 flex size-11 items-center justify-center rounded-full text-neutral-400 hover:bg-neutral-800 hover:text-white focus-visible:outline-2 focus-visible:outline-neutral-400"
      >
        <svg viewBox="0 0 24 24" className="size-6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h0a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h0a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 sm:items-center sm:p-4"
          onClick={(e) => e.target === e.currentTarget && reset()}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="settings-title"
            className="flex max-h-[85dvh] w-full flex-col overflow-hidden rounded-t-2xl border border-neutral-800 bg-neutral-900 shadow-2xl sm:max-w-md sm:rounded-2xl"
          >
            <header className="flex items-center justify-between gap-2 border-b border-neutral-800 px-2 py-2 pl-5">
              {view !== 'list' ? (
                <button
                  type="button"
                  onClick={backToList}
                  className="-ml-3 flex h-11 items-center gap-1 rounded-full pr-3 pl-2 text-neutral-300 hover:bg-neutral-800 hover:text-white focus-visible:outline-2 focus-visible:outline-neutral-400"
                >
                  <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <path d="M15 6l-6 6 6 6" />
                  </svg>
                  <span className="sr-only">Back to settings: </span>
                  <span id="settings-title" className="font-medium text-white">
                    {title}
                  </span>
                </button>
              ) : (
                <h2 id="settings-title" className="font-medium">
                  Settings
                </h2>
              )}
              <button ref={closeRef} type="button" aria-label="Close settings" onClick={reset} className={iconButton}>
                <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
                  <path d="M6 6l12 12M18 6L6 18" />
                </svg>
              </button>
            </header>

            <div ref={bodyRef} className="overflow-y-auto overscroll-contain px-5 py-4">
              {view === 'form' && (
                <AddWindowForm
                  // Remount (clearing "submitted" error state) when switching between adding and editing.
                  key={editing?.id ?? 'new'}
                  draft={editing ? editing.draft : draft}
                  onChange={(d) => (editing ? setEditing({ id: editing.id, draft: d }) : setDraft(d))}
                  detectedTimeZone={detectedTimeZone}
                  onSubmit={(d) => {
                    if (editing) {
                      if (!onEditWindow(editing.id, d)) return
                      setNote(`Saved changes to \u201c${d.name.trim()}\u201d.`)
                      setEditing(null)
                      setView('list')
                      return
                    }
                    if (!onAddWindow(d)) return
                    setDraft(emptyDraft(detectedTimeZone))
                    setNote(`Added \u201c${d.name.trim()}\u201d under My windows.`)
                    setView('list')
                    // The new window is in the last group; bring it into view.
                    requestAnimationFrame(() => bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight }))
                  }}
                />
              )}

              {view === 'confirm' && confirming && (
                <div className="space-y-2 py-2">
                  <h3 className="text-lg font-medium">Delete {confirming.name}?</h3>
                  <p className="text-sm text-neutral-400">
                    It will be removed from the timeline, the list and these settings. You can undo for a few seconds afterwards.
                  </p>
                </div>
              )}

              {view === 'list' && (
                <div className="space-y-5">
                  {lastDeleted ? (
                    <div role="status" className="flex items-center justify-between gap-3 rounded-lg bg-neutral-800 px-3 py-1 text-sm text-neutral-200">
                      <span className="min-w-0 truncate py-2">Deleted {lastDeleted.window.name}</span>
                      <button
                        type="button"
                        onClick={onUndoDelete}
                        className="h-11 shrink-0 rounded-lg px-3 font-medium text-emerald-300 hover:bg-neutral-700 focus-visible:outline-2 focus-visible:outline-emerald-300"
                      >
                        Undo
                      </button>
                    </div>
                  ) : (
                    note && (
                      <p role="status" className="rounded-lg bg-emerald-500/10 px-3 py-2 text-sm text-emerald-300">
                        {note}
                      </p>
                    )
                  )}
                  <section>
                    <h3 className="text-xs font-medium uppercase tracking-[0.2em] text-neutral-400">Alerts</h3>
                    <div className="mt-1 flex items-center justify-between gap-3 py-1">
                      <div className="min-w-0">
                        <p>Alert sound</p>
                        <p className="text-xs text-neutral-500">
                          A quiet chime with each alert. Browsers only allow sound once you have clicked or tapped the page.
                        </p>
                      </div>
                      <Switch
                        state={alerts.soundOn ? 'on' : 'off'}
                        label="Alert sound"
                        onToggle={() => {
                          const next = !alerts.soundOn
                          onSoundChange(next)
                          if (next) {
                            // This click counts as the gesture browsers require, so preview the chime.
                            alertSound.unlock()
                            void alertSound.play()
                          }
                        }}
                      />
                    </div>
                  </section>
                  {groups.map((group) => {
                    const state = getGroupState(disabled, group)
                    return (
                      <section key={group.name}>
                        <div className="flex items-center justify-between gap-3">
                          <h3 className="text-xs font-medium uppercase tracking-[0.2em] text-neutral-400">{group.name}</h3>
                          <Switch
                            role="checkbox"
                            state={state}
                            label={`Show all ${group.name}`}
                            onToggle={() => onChange(setGroupEnabled(disabled, group, state !== 'on'))}
                          />
                        </div>
                        <ul className="mt-1 divide-y divide-neutral-800/70">
                          {group.windows.map((w) => {
                            const on = isWindowEnabled(disabled, w.id)
                            const custom = w.id.startsWith(CUSTOM_ID_PREFIX)
                            return (
                              <li key={w.id} className="py-1 pl-1">
                              <div className="flex min-h-11 items-center gap-2">
                                <span aria-hidden className="mr-1 size-3 shrink-0 rounded-full" style={{ backgroundColor: w.color }} />
                                <span className={`min-w-0 flex-1 truncate ${on ? 'text-neutral-100' : 'text-neutral-500'}`}>
                                  {w.name}
                                </span>
                                {custom && (
                                  <>
                                    <button
                                      type="button"
                                      aria-label={`Edit ${w.name}`}
                                      title="Edit"
                                      onClick={() => {
                                        setNote(null)
                                        setEditing({ id: w.id, draft: draftFromWindow(w) })
                                        setView('form')
                                      }}
                                      className={iconButton}
                                    >
                                      <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                                        <path d="M12 20h9" />
                                        <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
                                      </svg>
                                    </button>
                                    <button
                                      type="button"
                                      aria-label={`Delete ${w.name}`}
                                      title="Delete"
                                      onClick={() => {
                                        setNote(null)
                                        setConfirming(w)
                                        setView('confirm')
                                      }}
                                      className={`${iconButton} hover:text-rose-400`}
                                    >
                                      <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                                        <path d="M3 6h18" />
                                        <path d="M8 6V4h8v2" />
                                        <path d="M19 6l-1 14H6L5 6" />
                                        <path d="M10 11v6M14 11v6" />
                                      </svg>
                                    </button>
                                  </>
                                )}
                                <Switch
                                  state={on ? 'on' : 'off'}
                                  label={`Show ${group.name} ${w.name}`}
                                  onToggle={() => onChange(setWindowEnabled(disabled, w.id, !on))}
                                />
                              </div>
                                <div className="flex items-center gap-2 pb-1 pl-6">
                                  <label htmlFor={`alert-${w.id}`} className="text-xs text-neutral-500">
                                    Alert
                                  </label>
                                  <select
                                    id={`alert-${w.id}`}
                                    aria-label={`Alert for ${group.name} ${w.name}`}
                                    value={getAlertLead(alerts, w.id) ?? 'off'}
                                    onChange={(e) => {
                                      const v = Number(e.target.value)
                                      onAlertLeadChange(w.id, isAlertLead(v) ? v : null)
                                    }}
                                    className="h-9 rounded-md border border-neutral-700 bg-neutral-950 px-2 text-sm text-neutral-200 [color-scheme:dark] focus-visible:outline-2 focus-visible:outline-neutral-400"
                                  >
                                    <option value="off">Off</option>
                                    {ALERT_LEADS.map((m) => (
                                      <option key={m} value={m}>
                                        {m} minutes before
                                      </option>
                                    ))}
                                  </select>
                                </div>
                              </li>
                            )
                          })}
                        </ul>
                      </section>
                    )
                  })}
                  {saveFailed && (
                    <p className="rounded-lg bg-amber-500/10 px-3 py-2 text-sm text-amber-300">
                      Your browser is blocking storage, so your choices and custom windows will reset when you reload.
                    </p>
                  )}
                </div>
              )}
            </div>

            <footer className="flex gap-3 border-t border-neutral-800 px-5 py-3">
              {view === 'form' && (
                <>
                  <button
                    type="button"
                    onClick={() => {
                      if (!editing) setDraft(emptyDraft(detectedTimeZone))
                      backToList()
                    }}
                    className="h-11 flex-1 rounded-lg border border-neutral-700 text-neutral-200 hover:bg-neutral-800 focus-visible:outline-2 focus-visible:outline-neutral-400"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    form={ADD_WINDOW_FORM_ID}
                    className="h-11 flex-1 rounded-lg bg-emerald-500 font-medium text-neutral-950 hover:bg-emerald-400 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-300"
                  >
                    {isEditing ? 'Save changes' : 'Save window'}
                  </button>
                </>
              )}
              {view === 'confirm' && confirming && (
                <>
                  <button
                    ref={cancelDeleteRef}
                    type="button"
                    onClick={backToList}
                    className="h-11 flex-1 rounded-lg border border-neutral-700 text-neutral-200 hover:bg-neutral-800 focus-visible:outline-2 focus-visible:outline-neutral-400"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      onDeleteWindow(confirming.id)
                      backToList()
                    }}
                    className="h-11 flex-1 rounded-lg bg-rose-500 font-medium text-white hover:bg-rose-400 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-300"
                  >
                    Delete
                  </button>
                </>
              )}
              {view === 'list' && (
                <button
                  type="button"
                  onClick={() => {
                    setNote(null)
                    setView('form')
                  }}
                  className="h-11 w-full rounded-lg border border-neutral-700 font-medium text-neutral-100 hover:bg-neutral-800 focus-visible:outline-2 focus-visible:outline-neutral-400"
                >
                  + Add window
                </button>
              )}
            </footer>
          </div>
        </div>
      )}
    </>
  )
}
