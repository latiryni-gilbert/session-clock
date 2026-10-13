// Constants live here, not in index.ts: a Worker's entry module may only export handlers.
export const SERVICE_NAME = 'session-clock-push'

export const MAX_BODY_BYTES = 64 * 1024
export const MAX_ALERTS = 500
export const MAX_SCHEDULE_DAYS = 15
export const MAX_TITLE_CHARS = 80
export const MAX_BODY_CHARS = 200
export const MAX_ENDPOINT_CHARS = 2048
