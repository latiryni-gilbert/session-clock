// Browsers may call this API only from the production site, this project's Vercel previews, and localhost.
// Each pattern must match the whole origin. The preview pattern ends in the project's Vercel scope, so
// only deployments from this Vercel team match (a stranger can't register a matching *.vercel.app name).
const ALLOWED_ORIGINS: RegExp[] = [
  /^https:\/\/sessionclock\.vercel\.app$/,
  // Preview deployments: session-clock-<hash>-<scope>.vercel.app and session-clock-git-<branch>-<scope>.vercel.app
  /^https:\/\/session-clock-[a-z0-9-]+-latiryni-gilberts-projects\.vercel\.app$/,
  // Local development, any port.
  /^https?:\/\/localhost(:\d{1,5})?$/,
]

export function isAllowedOrigin(origin: string): boolean {
  return ALLOWED_ORIGINS.some((pattern) => pattern.test(origin))
}

export function corsHeaders(origin: string, allowedMethod: string): Record<string, string> {
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': `${allowedMethod}, OPTIONS`,
    'access-control-allow-headers': 'content-type',
    'access-control-max-age': '86400',
  }
}
