// Settings read from the environment at build time (Vite exposes variables that start with VITE_).
interface ImportMetaEnv {
  /** The push Worker's address, e.g. https://session-clock-push.example.workers.dev. Without it, background alerts are hidden. */
  readonly VITE_PUSH_WORKER_URL?: string
}
