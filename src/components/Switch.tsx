interface Props {
  state: 'on' | 'off' | 'mixed'
  onToggle: () => void
  label: string
  /** "checkbox" is used for group toggles because it supports the "mixed" state. */
  role?: 'switch' | 'checkbox'
}

/** A toggle with a 44px-tall tap target. */
export function Switch({ state, onToggle, label, role = 'switch' }: Props) {
  return (
    <button
      type="button"
      role={role}
      aria-checked={state === 'mixed' ? 'mixed' : state === 'on'}
      aria-label={label}
      onClick={onToggle}
      className="-my-2 flex h-11 w-14 shrink-0 cursor-pointer items-center justify-end rounded-full focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-neutral-300"
    >
      <span
        className={`relative h-6 w-11 rounded-full transition-colors ${
          state === 'on' ? 'bg-emerald-500' : state === 'mixed' ? 'bg-amber-500/80' : 'bg-neutral-700'
        }`}
      >
        <span
          className={`absolute top-0.5 size-5 rounded-full bg-white shadow transition-all ${
            state === 'on' ? 'left-[1.375rem]' : state === 'mixed' ? 'left-[0.6875rem]' : 'left-0.5'
          }`}
        />
      </span>
    </button>
  )
}
