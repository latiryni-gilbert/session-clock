/** The few bits of the Web Audio API used here, so they can be faked in tests. */
export interface AudioContextLike {
  state: string
  currentTime: number
  destination: unknown
  resume(): Promise<void>
  createOscillator(): {
    type: string
    frequency: { value: number }
    connect(node: unknown): void
    start(when?: number): void
    stop(when?: number): void
  }
  createGain(): {
    gain: {
      value: number
      setValueAtTime(v: number, t: number): void
      linearRampToValueAtTime(v: number, t: number): void
      exponentialRampToValueAtTime(v: number, t: number): void
    }
    connect(node: unknown): void
  }
}

export interface AlertSound {
  /** Call from a user gesture (click, tap, key press): browsers only allow audio after one. */
  unlock(): void
  /** True once audio has been unlocked and is running. */
  isUnlocked(): boolean
  /** Plays a short, quiet two-note chime. Resolves false (never throws) if sound isn't possible right now. */
  play(): Promise<boolean>
}

const VOLUME = 0.06 // quiet on purpose

export function createAlertSound(Ctor: (new () => AudioContextLike) | undefined): AlertSound {
  let ctx: AudioContextLike | null = null

  const ensure = (): AudioContextLike | null => {
    try {
      if (!ctx && Ctor) ctx = new Ctor()
      return ctx
    } catch {
      return null
    }
  }

  return {
    unlock() {
      try {
        const c = ensure()
        if (c && c.state !== 'running') c.resume().catch(() => {})
      } catch {
        // Audio is a nicety; never let it break the page.
      }
    },
    isUnlocked: () => ctx?.state === 'running',
    async play() {
      try {
        // Only a context created during a user gesture is allowed to run, so never create one here.
        const c = ctx
        if (!c) return false
        if (c.state !== 'running') await c.resume()
        if (c.state !== 'running') return false
        const t = c.currentTime
        const gain = c.createGain()
        gain.connect(c.destination)
        gain.gain.setValueAtTime(0.0001, t)
        gain.gain.linearRampToValueAtTime(VOLUME, t + 0.02)
        gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.6)
        for (const [freq, offset] of [[880, 0], [1175, 0.18]] as const) {
          const osc = c.createOscillator()
          osc.type = 'sine'
          osc.frequency.value = freq
          osc.connect(gain)
          osc.start(t + offset)
          osc.stop(t + offset + 0.3)
        }
        return true
      } catch {
        return false
      }
    },
  }
}

type WindowWithAudio = { AudioContext?: new () => AudioContextLike; webkitAudioContext?: new () => AudioContextLike }

/** The app's shared sound player, using the browser's AudioContext if there is one. */
export const alertSound: AlertSound = createAlertSound(
  typeof window === 'undefined'
    ? undefined
    : (window as unknown as WindowWithAudio).AudioContext ?? (window as unknown as WindowWithAudio).webkitAudioContext,
)
