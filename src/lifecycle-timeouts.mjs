// The plugin supervisor awaits graceful daemon shutdown before exiting. Its
// parent must cover that complete wait plus final status/record cleanup. A
// hung shutdown still fails at a bounded deadline; it is never force-killed.
export const DAEMON_STOP_TIMEOUT_MS = 20000;
export const SUPERVISOR_STOP_TIMEOUT_MS = DAEMON_STOP_TIMEOUT_MS + 10000;
