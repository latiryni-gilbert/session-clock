import { useEffect, useRef, useState } from 'react'
import { emptyDraft, type WindowDraft } from '../lib/customWindows'
import type { PresetGroup } from '../lib/tradingWindow'
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
  detectedTimeZone: string
  saveFailed: boolean
}

export function Settings({ groups, disabled, onChange, onAddWindow, detectedTimeZone, saveFailed }: Props) {
  const [open, setOpen] = useState(false)
  const [view, setView] = useState<'list' | 'form'>('list')
  // Held here, not in the form, so closing the panel mid-way doesn't lose what was typed.
  const [draft, setDraft] = useState(() => emptyDraft(detectedTimeZone))
  const [justAdded, setJustAdded] = useState<string | null>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const gearRef = useRef<HTMLButtonElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)

  // Reopening the panel always starts on the list; the draft survives.
  const close = () => {
    setOpen(false)
    setView('list')
    setJustAdded(null)
  }

  useEffect(() => {
    if (!open) return
    const gear = gearRef.current
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false)
        setView('list')
        setJustAdded(null)
      }
    }
    document.addEventListener('keydown', onKey)
    document.body.style.overflow = 'hidden' // keep the page from scrolling behind the panel
    closeRef.current?.focus()
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = ''
      gear?.focus()
    }
  }, [open])

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
          onClick={(e) => e.target === e.currentTarget && close()}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="settings-title"
            className="flex max-h-[85dvh] w-full flex-col overflow-hidden rounded-t-2xl border border-neutral-800 bg-neutral-900 shadow-2xl sm:max-w-md sm:rounded-2xl"
          >
            <header className="flex items-center justify-between gap-2 border-b border-neutral-800 px-2 py-2 pl-5">
              {view === 'form' ? (
                <button
                  type="button"
                  onClick={() => setView('list')}
                  className="-ml-3 flex h-11 items-center gap-1 rounded-full pr-3 pl-2 text-neutral-300 hover:bg-neutral-800 hover:text-white focus-visible:outline-2 focus-visible:outline-neutral-400"
                >
                  <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <path d="M15 6l-6 6 6 6" />
                  </svg>
                  <span className="sr-only">Back to </span>
                  <span id="settings-title" className="font-medium text-white">
                    Add window
                  </span>
                </button>
              ) : (
                <h2 id="settings-title" className="font-medium">
                  Show windows
                </h2>
              )}
              <button
                ref={closeRef}
                type="button"
                aria-label="Close settings"
                onClick={close}
                className="flex size-11 shrink-0 items-center justify-center rounded-full text-neutral-400 hover:bg-neutral-800 hover:text-white focus-visible:outline-2 focus-visible:outline-neutral-400"
              >
                <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
                  <path d="M6 6l12 12M18 6L6 18" />
                </svg>
              </button>
            </header>

            <div ref={bodyRef} className="overflow-y-auto overscroll-contain px-5 py-4">
              {view === 'form' ? (
                <AddWindowForm
                  draft={draft}
                  onChange={setDraft}
                  detectedTimeZone={detectedTimeZone}
                  onSubmit={(d) => {
                    if (!onAddWindow(d)) return
                    setDraft(emptyDraft(detectedTimeZone))
                    setJustAdded(d.name.trim())
                    setView('list')
                    // The new window is in the last group; bring it into view.
                    requestAnimationFrame(() => bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight }))
                  }}
                />
              ) : (
                <div className="space-y-5">
                  {justAdded && (
                    <p role="status" className="rounded-lg bg-emerald-500/10 px-3 py-2 text-sm text-emerald-300">
                      Added &ldquo;{justAdded}&rdquo; under My windows.
                    </p>
                  )}
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
                            return (
                              <li key={w.id} className="flex min-h-11 items-center gap-3 py-1 pl-1">
                                <span aria-hidden className="size-3 shrink-0 rounded-full" style={{ backgroundColor: w.color }} />
                                <span className={`min-w-0 flex-1 truncate ${on ? 'text-neutral-100' : 'text-neutral-500'}`}>
                                  {w.name}
                                </span>
                                <Switch
                                  state={on ? 'on' : 'off'}
                                  label={`Show ${group.name} ${w.name}`}
                                  onToggle={() => onChange(setWindowEnabled(disabled, w.id, !on))}
                                />
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
              {view === 'form' ? (
                <>
                  <button
                    type="button"
                    onClick={() => {
                      setDraft(emptyDraft(detectedTimeZone))
                      setView('list')
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
                    Save window
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  onClick={() => {
                    setJustAdded(null)
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
