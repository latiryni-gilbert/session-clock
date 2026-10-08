import { useId, useMemo, useState } from 'react'
import { filterTimeZones, findTimeZone } from '../lib/timeZones'

interface Props {
  id: string
  value: string
  onChange: (value: string) => void
  zones: string[]
  invalid: boolean
  describedBy?: string
}

const MAX_SHOWN = 120

/** A text box that filters the IANA zone list as you type; pick one to fill it in. */
export function TimeZonePicker({ id, value, onChange, zones, invalid, describedBy }: Props) {
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(-1)
  const listId = useId()

  const matches = useMemo(() => {
    // When the box already holds a full zone name, show the whole list so the user can browse.
    const query = findTimeZone(zones, value) ? '' : value
    return filterTimeZones(zones, query).slice(0, MAX_SHOWN)
  }, [zones, value])

  const choose = (zone: string) => {
    onChange(zone)
    setOpen(false)
    setActive(-1)
  }

  return (
    <div className="relative">
      <input
        id={id}
        data-field="timeZone"
        type="text"
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-invalid={invalid}
        aria-describedby={describedBy}
        aria-activedescendant={open && active >= 0 ? `${listId}-${active}` : undefined}
        autoComplete="off"
        autoCapitalize="none"
        spellCheck={false}
        placeholder="Search, e.g. new york"
        value={value}
        onFocus={() => setOpen(true)}
        onBlur={() => {
          setOpen(false)
          const canonical = findTimeZone(zones, value)
          if (canonical && canonical !== value) onChange(canonical)
        }}
        onChange={(e) => {
          onChange(e.target.value)
          setOpen(true)
          setActive(-1)
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault()
            setOpen(true)
            if (matches.length > 0) {
              const step = e.key === 'ArrowDown' ? 1 : -1
              setActive((i) => (i + step + matches.length) % matches.length)
            }
          } else if (e.key === 'Enter' && open && active >= 0) {
            e.preventDefault() // pick the highlighted zone instead of submitting the form
            choose(matches[active])
          } else if (e.key === 'Escape' && open) {
            e.stopPropagation() // close just the list, not the whole settings panel
            e.nativeEvent.stopImmediatePropagation()
            setOpen(false)
          }
        }}
        className={`w-full rounded-lg border bg-neutral-950 px-3 py-2.5 text-base text-neutral-100 placeholder:text-neutral-600 focus:outline-2 focus:outline-neutral-400 ${
          invalid ? 'border-rose-500' : 'border-neutral-700'
        }`}
      />
      {open && (
        <ul
          id={listId}
          role="listbox"
          className="absolute z-10 mt-1 max-h-48 w-full overflow-y-auto overscroll-contain rounded-lg border border-neutral-700 bg-neutral-900 py-1 shadow-xl"
        >
          {matches.length === 0 ? (
            <li className="px-3 py-2 text-sm text-neutral-500">No matching time zone</li>
          ) : (
            matches.map((zone, i) => (
              <li
                key={zone}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={zone === value}
                onMouseDown={(e) => e.preventDefault()} // keep focus in the box so blur doesn't close the list first
                onClick={() => choose(zone)}
                className={`cursor-pointer px-3 py-2 text-sm ${
                  i === active ? 'bg-neutral-700 text-white' : zone === value ? 'text-emerald-300' : 'text-neutral-200'
                } hover:bg-neutral-800`}
              >
                {zone}
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  )
}
