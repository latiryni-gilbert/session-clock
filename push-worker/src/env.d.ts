// The bindings this Worker receives. GIT_COMMIT_SHA is set at deploy time (see wrangler.jsonc).
declare namespace Cloudflare {
  interface Env {
    GIT_COMMIT_SHA: string
  }
  // Lets `exports.default` (the Worker's own entry point) be typed in tests.
  interface GlobalProps {
    mainModule: typeof import('./index')
  }
}
