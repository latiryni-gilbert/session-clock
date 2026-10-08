import { bannerMessage, type DueAlert } from '../lib/alerts'

interface Props {
  banners: DueAlert[]
  now: Date
  onDismiss: (key: string) => void
}

/** Stacked alert banners at the top of the page; they stay in view while scrolling. */
export function AlertBanners({ banners, now, onDismiss }: Props) {
  if (banners.length === 0) return null
  return (
    <div className="sticky top-3 z-40 -mt-2 w-full max-w-2xl space-y-2">
      {banners.map((b) => (
        <div
          key={b.key}
          role="status"
          className="flex items-center gap-3 rounded-lg border border-neutral-700 bg-neutral-800 py-1 pr-1 pl-4 shadow-lg"
          style={{ borderLeftWidth: 4, borderLeftColor: b.color }}
        >
          <p className="min-w-0 flex-1 py-2 font-medium">{bannerMessage(b, now)}</p>
          <button
            type="button"
            aria-label={`Dismiss alert for ${b.label}`}
            onClick={() => onDismiss(b.key)}
            className="flex size-11 shrink-0 items-center justify-center rounded-full text-neutral-400 hover:bg-neutral-700 hover:text-white focus-visible:outline-2 focus-visible:outline-neutral-300"
          >
            <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>
      ))}
    </div>
  )
}
