import { applyUpdate, dismissUpdate, useUpdateAvailable } from '../lib/swUpdate'

/** A small bar at the bottom of the screen offering to reload into a newly deployed version. */
export function UpdatePrompt() {
  const available = useUpdateAvailable()
  if (!available) return null

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-0 z-[60] flex justify-center px-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
      <div
        role="status"
        className="pointer-events-auto flex items-center gap-1 rounded-lg border border-neutral-700 bg-neutral-800 py-1 pr-1 pl-4 shadow-xl"
      >
        <p className="py-2 text-sm font-medium">Update available</p>
        <button
          type="button"
          onClick={applyUpdate}
          className="ml-2 h-11 rounded-lg bg-emerald-500 px-4 text-sm font-medium text-neutral-950 hover:bg-emerald-400 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-300"
        >
          Reload
        </button>
        <button
          type="button"
          aria-label="Dismiss update prompt"
          onClick={dismissUpdate}
          className="flex size-11 items-center justify-center rounded-full text-neutral-400 hover:bg-neutral-700 hover:text-white focus-visible:outline-2 focus-visible:outline-neutral-300"
        >
          <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
      </div>
    </div>
  )
}
