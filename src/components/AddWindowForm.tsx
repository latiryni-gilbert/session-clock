import { useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { COLOR_SWATCHES, LIMITS, validateDraft, type DraftErrors, type DraftField, type WindowDraft } from '../lib/customWindows'
import { getTimeZoneOptions } from '../lib/timeZones'
import type { Weekday } from '../lib/tradingWindow'
import { TimeZonePicker } from './TimeZonePicker'

/** Id the footer's Save button points at via its `form` attribute. */
export const ADD_WINDOW_FORM_ID = 'add-window-form'

interface Props {
  draft: WindowDraft
  onChange: (draft: WindowDraft) => void
  onSubmit: (draft: WindowDraft) => void
  detectedTimeZone: string
}

const DAYS: { day: Weekday; label: string }[] = [
  { day: 1, label: 'Mon' },
  { day: 2, label: 'Tue' },
  { day: 3, label: 'Wed' },
  { day: 4, label: 'Thu' },
  { day: 5, label: 'Fri' },
  { day: 6, label: 'Sat' },
  { day: 7, label: 'Sun' },
]

const inputClass = (invalid: boolean) =>
  `w-full rounded-lg border bg-neutral-950 px-3 py-2.5 text-base text-neutral-100 placeholder:text-neutral-600 focus:outline-2 focus:outline-neutral-400 ${
    invalid ? 'border-rose-500' : 'border-neutral-700'
  }`

function Field({ label, htmlFor, error, errorId, hint, children }: {
  label: string
  htmlFor?: string
  error?: string
  errorId: string
  hint?: ReactNode
  children: ReactNode
}) {
  return (
    <div>
      <label htmlFor={htmlFor} className="mb-1 flex items-baseline justify-between text-sm font-medium text-neutral-300">
        {label}
        {hint && <span className="text-xs font-normal text-neutral-500">{hint}</span>}
      </label>
      {children}
      {error && (
        <p id={errorId} role="alert" className="mt-1 text-sm text-rose-400">
          {error}
        </p>
      )}
    </div>
  )
}

export function AddWindowForm({ draft, onChange, onSubmit, detectedTimeZone }: Props) {
  const uid = useId()
  const formRef = useRef<HTMLFormElement>(null)
  const [submitted, setSubmitted] = useState(false)
  const zones = useMemo(() => getTimeZoneOptions(detectedTimeZone), [detectedTimeZone])

  const allErrors = validateDraft(draft)
  // Errors only appear after the first Save attempt, then stay in sync as the user fixes them.
  const errors: DraftErrors = submitted ? allErrors : {}
  const id = (f: DraftField) => `${uid}-${f}`
  const err = (f: DraftField) => (errors[f] ? `${id(f)}-error` : undefined)
  const set = (patch: Partial<WindowDraft>) => onChange({ ...draft, ...patch })

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    setSubmitted(true)
    const first = (['name', 'shortName', 'start', 'end', 'timeZone', 'days', 'color'] as const).find((f) => allErrors[f])
    if (first) {
      const target = formRef.current?.querySelector<HTMLElement>(`[data-field="${first}"]`)
      target?.focus()
      return
    }
    onSubmit(draft)
  }

  const toggleDay = (day: Weekday) =>
    set({ days: draft.days.includes(day) ? draft.days.filter((d) => d !== day) : [...draft.days, day].sort() })

  return (
    <form ref={formRef} id={ADD_WINDOW_FORM_ID} noValidate onSubmit={handleSubmit} className="space-y-5">
      <Field label="Name" htmlFor={id('name')} error={errors.name} errorId={`${id('name')}-error`} hint={`${[...draft.name].length}/${LIMITS.name}`}>
        <input
          id={id('name')}
          data-field="name"
          type="text"
          maxLength={LIMITS.name}
          autoComplete="off"
          placeholder="e.g. Opening range"
          value={draft.name}
          onChange={(e) => set({ name: e.target.value })}
          aria-invalid={!!errors.name}
          aria-describedby={err('name')}
          className={inputClass(!!errors.name)}
        />
      </Field>

      <Field label="Short label" htmlFor={id('shortName')} error={errors.shortName} errorId={`${id('shortName')}-error`} hint={`Shown on the timeline · ${[...draft.shortName].length}/${LIMITS.shortName}`}>
        <input
          id={id('shortName')}
          data-field="shortName"
          type="text"
          maxLength={LIMITS.shortName}
          autoComplete="off"
          autoCapitalize="characters"
          placeholder="e.g. ORB"
          value={draft.shortName}
          onChange={(e) => set({ shortName: e.target.value })}
          aria-invalid={!!errors.shortName}
          aria-describedby={err('shortName')}
          className={inputClass(!!errors.shortName)}
        />
      </Field>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Start" htmlFor={id('start')} error={errors.start} errorId={`${id('start')}-error`}>
          <input
            id={id('start')}
            data-field="start"
            type="time"
            value={draft.start}
            onChange={(e) => set({ start: e.target.value })}
            aria-invalid={!!errors.start}
            aria-describedby={err('start')}
            className={`${inputClass(!!errors.start)} [color-scheme:dark]`}
          />
        </Field>
        <Field label="End" htmlFor={id('end')} error={errors.end} errorId={`${id('end')}-error`}>
          <input
            id={id('end')}
            data-field="end"
            type="time"
            value={draft.end}
            onChange={(e) => set({ end: e.target.value })}
            aria-invalid={!!errors.end}
            aria-describedby={err('end')}
            className={`${inputClass(!!errors.end)} [color-scheme:dark]`}
          />
        </Field>
      </div>

      <Field label="Time zone" htmlFor={id('timeZone')} error={errors.timeZone} errorId={`${id('timeZone')}-error`} hint="Start and end are in this zone">
        <TimeZonePicker
          id={id('timeZone')}
          value={draft.timeZone}
          onChange={(timeZone) => set({ timeZone })}
          zones={zones}
          invalid={!!errors.timeZone}
          describedBy={err('timeZone')}
        />
      </Field>

      <fieldset data-field="days" tabIndex={-1} aria-describedby={`${id('days')}-hint ${err('days') ?? ''}`.trim()} className="focus:outline-none">
        <legend className="mb-1 text-sm font-medium text-neutral-300">Days</legend>
        <div className="flex flex-wrap gap-1.5">
          {DAYS.map(({ day, label }) => (
            <label key={day} className="cursor-pointer">
              <input
                type="checkbox"
                className="peer sr-only"
                checked={draft.days.includes(day)}
                onChange={() => toggleDay(day)}
              />
              <span className="flex h-11 min-w-12 items-center justify-center rounded-lg border border-neutral-700 px-2 text-sm text-neutral-400 peer-checked:border-emerald-500 peer-checked:bg-emerald-500/15 peer-checked:text-emerald-300 peer-focus-visible:outline-2 peer-focus-visible:outline-neutral-300">
                {label}
              </span>
            </label>
          ))}
        </div>
        <p id={`${id('days')}-hint`} className="mt-1.5 text-xs text-neutral-500">
          Pick the day the window <em>starts</em>, in the time zone above. A window that runs past midnight counts as the day it
          began, so Sun 18:00 to Mon 17:00 is a Sunday window.
        </p>
        {errors.days && (
          <p id={`${id('days')}-error`} role="alert" className="mt-1 text-sm text-rose-400">
            {errors.days}
          </p>
        )}
      </fieldset>

      <fieldset>
        <legend className="mb-1 text-sm font-medium text-neutral-300">Color</legend>
        <div className="flex flex-wrap gap-2">
          {COLOR_SWATCHES.map((color) => (
            <label key={color} className="cursor-pointer" title={color}>
              <input
                type="radio"
                name={`${uid}-color`}
                className="peer sr-only"
                aria-label={`Color ${color}`}
                checked={draft.color === color}
                onChange={() => set({ color })}
              />
              <span
                className="block size-9 rounded-full ring-2 ring-transparent ring-offset-2 ring-offset-neutral-900 peer-checked:ring-white peer-focus-visible:ring-neutral-300"
                style={{ backgroundColor: color }}
              />
            </label>
          ))}
        </div>
      </fieldset>
    </form>
  )
}
