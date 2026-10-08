import { useEffect, useRef, useState } from 'react'
import { PRESET_GROUPS } from '../config/presets'
import {
  getGroupState,
  isWindowEnabled,
  setGroupEnabled,
  setWindowEnabled,
  type DisabledIds,
} from '../lib/windowSettings'
import { Switch } from './Switch'

interface Props {
  disabled: DisabledIds
  onChange: (next: DisabledIds) => void
  saveFailed: boolean
}

export function Settings({ disabled, onChange, saveFailed }: Props) {
  const [open, setOpen] = useState(false)
  const gearRef = useRef<HTMLButtonElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open) return
    const gear = gearRef.current
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
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
          onClick={(e) => e.target === e.currentTarget && setOpen(false)}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="settings-title"
            className="flex max-h-[85dvh] w-full flex-col overflow-hidden rounded-t-2xl border border-neutral-800 bg-neutral-900 shadow-2xl sm:max-w-md sm:rounded-2xl"
          >
            <header className="flex items-center justify-between border-b border-neutral-800 px-4 py-2 pl-5">
              <h2 id="settings-title" className="font-medium">
                Show windows
              </h2>
              <button
                ref={closeRef}
                type="button"
                aria-label="Close settings"
                onClick={() => setOpen(false)}
                className="flex size-11 items-center justify-center rounded-full text-neutral-400 hover:bg-neutral-800 hover:text-white focus-visible:outline-2 focus-visible:outline-neutral-400"
              >
                <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
                  <path d="M6 6l12 12M18 6L6 18" />
                </svg>
              </button>
            </header>

            <div className="space-y-5 overflow-y-auto overscroll-contain px-5 py-4">
              {PRESET_GROUPS.map((group) => {
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
                  Your browser is blocking storage, so these choices will reset when you reload.
                </p>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  )
}
