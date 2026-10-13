// Kept out of src/index.ts on purpose: a Worker's entry module may only export handlers and classes,
// so a plain exported constant there makes the Worker fail to start when it is really deployed.
export const SERVICE_NAME = 'session-clock-push'
