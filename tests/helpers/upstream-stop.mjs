// A model of what @getpaseo/server 0.17.4 does when a daemon is stopped, for tests that must not run a real one.
// It follows upstream's order, error classes, codes and time constants; where it simplifies, it says so.
//
//   stopDaemonInstance        dist/server/server/daemon-instance.js
//   terminal cleanup          dist/server/terminal/terminal-worker-reaper.js (reapTerminalWorkers, reapRecord)
//   supervisor shutdown       dist/scripts/supervisor.js, supervisor-entrypoint.js (cleanupTerminals, onSupervisorExit)
//   worker count              dist/server/terminal/worker-terminal-manager.js (MAX_TERMINAL_WORKERS = 2)
//
// The order that matters: SIGTERM to the supervisor; the supervisor closes the daemon worker (killing its tree
// after 10 s), runs its own terminal cleanup, releases the PID lock and exits; stopDaemonInstance waits for that
// for `timeoutMs`, releases the PID lock again, and ONLY THEN runs the terminal cleanup once more in the caller's
// process. A cleanup it cannot confirm throws TerminalCleanupNotConfirmedError out of a stop that has already
// stopped the daemon. The real implementation is exercised by scripts/verify-upgrade.mjs.
// Time is a counter (`clock.now`): nothing here sleeps.
//
// A cleanup that cannot confirm leaves a closing record (terminal-worker/closing-<id>.json) that every later cleanup
// walks again: 3 s per record and pass once its worker is gone. The model keeps them as files when it is given a
// `recordsDir`, so that what reads that directory sees what upstream would leave there.
import fs from 'node:fs';
import path from 'node:path';

export class DaemonInstanceError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
export class TerminalCleanupNotConfirmedError extends Error {
  constructor(unresolved, unreadableRecords = []) {
    super([
      'Terminal cleanup was not confirmed.',
      ...(unresolved.length ? ['These processes may still be running:', ...unresolved.map(entry => `  pid ${entry.pid} (${entry.role}): ${entry.reason} (${entry.detail})`),
        'Their record is kept; the next `paseo daemon stop` retries the cleanup.'] : []),
    ].join('\n'));
    this.code = 'TERMINAL_CLEANUP_NOT_CONFIRMED';
    this.name = 'TerminalCleanupNotConfirmedError';
    this.unresolved = unresolved;
    this.unreadableRecords = unreadableRecords;
  }
}

/** The Paseo release this model (and the budgets in src/lifecycle-timeouts.mjs) were derived from by reading its
 * source. A test fails when the pinned release moves, so that nobody keeps modeling a stop that no longer exists.
 * 0.18.1: re-read on 2026-11-28; the five files named above are byte-identical to 0.17.5, so the model holds. */
export const MODELED_PASEO_VERSION = '0.18.1';
/** Upstream's limits that the budgets count with. */
export const UPSTREAM_LIMITS = Object.freeze({
  terminalWorkers: 2, // worker-terminal-manager.js MAX_TERMINAL_WORKERS: a daemon runs at most two terminal workers
});
/** Upstream's constants, in milliseconds. */
export const UPSTREAM_MS = Object.freeze({
  workerGrace: 10000,    // supervisor.js WORKER_TERMINATION_GRACE_MS: the daemon worker's graceful shutdown, then its tree is killed
  exitPoll: 100,         // daemon-instance.js waitForExit
  shutdownRequest: 5000, // terminal-worker-reaper.js DEFAULT_GRACEFUL_MS, spent on the shutdown request ...
  shutdownWait: 5000,    // ... and again waiting for the worker's terminals (reapRecord uses it twice)
  killConfirm: 3000,     // DEFAULT_CONFIRM_MS after the SIGKILL
});

/** What one terminal worker record costs reapTerminalWorkers (records are handled one after the other) and how it ends. */
export const RECORD_KINDS = Object.freeze({
  // The worker answers the shutdown request and its terminals end.
  responsive: Object.freeze({ ms: 300, confirmed: true }),
  // The socket accepts but the worker does not shut down: request 5 s + wait 5 s, SIGKILL, up to 3 s to confirm.
  unresponsive: Object.freeze({ ms: UPSTREAM_MS.shutdownRequest + UPSTREAM_MS.shutdownWait + UPSTREAM_MS.killConfirm, confirmed: true }),
  // A terminal process outlives the SIGKILL: same time, left unresolved. A later pass signals again and waits 3 s.
  survives: Object.freeze({ ms: UPSTREAM_MS.shutdownRequest + UPSTREAM_MS.shutdownWait + UPSTREAM_MS.killConfirm, confirmed: false, retryMs: UPSTREAM_MS.killConfirm }),
  // `ps` cannot run, so nothing can be identified and nothing is signaled: 5 s waiting, 3 s confirming, unresolved.
  noPs: Object.freeze({ ms: UPSTREAM_MS.shutdownWait + UPSTREAM_MS.killConfirm, confirmed: false, retryMs: UPSTREAM_MS.killConfirm }),
});

/**
 * @param {object} host what the test's fake machine offers
 * @param {{now: number}} host.clock the fake clock
 * @param {() => object | null} host.readLock the PID lock as written now, or null
 * @param {(lock: object) => boolean} host.ownerRunning is the process named by the lock alive
 * @param {(a: object, b: object) => boolean} host.sameLock upstream isSamePidLock
 * @param {(pid: number, signal: string) => void} host.deliver the signal the stop sends (the test fails if it is not allowed)
 * @param {(pid: number) => void} host.exit the supervisor process ends
 * @param {(lock: object) => void} host.releaseLock upstream releasePidLock: removes the file only if it still names this owner
 * @param {() => object} host.scenario how this stop goes
 *   workerShutdownMs   how long the daemon worker takes to shut down (the supervisor kills its tree after 10 s)
 *   records            terminal worker records the supervisor finds, by RECORD_KINDS name
 *   supervisorHangs    the supervisor never exits
 *   retryConfirms      a later cleanup of the records an earlier one left open confirms them (procps was installed)
 *   leaveSupervisor    (not something upstream can do) the supervisor process survives its own exit
 *   duringWait         called once, at the first poll of the supervisor's exit (a test replaces the daemon here)
 *   afterRelease       called once the PID lock is released, before the caller's terminal cleanup
 * @param {string} [host.recordsDir] where the closing records are kept as files (<PASEO_HOME>/terminal-worker)
 */
export function createUpstreamStop(host) {
  const { clock } = host;
  const events = [], closing = [];
  let nextRecord = 0;
  const note = event => events.push({ event, at: clock.now });
  const closingFile = entry => host.recordsDir && path.join(host.recordsDir, `closing-${entry.id}.json`);
  const keep = entry => { const file = closingFile(entry); if (file) { fs.mkdirSync(host.recordsDir, { recursive: true }); fs.writeFileSync(file, JSON.stringify({ recordId: entry.id, closing: { unresolved: [{ pid: entry.pid, role: entry.role, reason: entry.reason, detail: entry.detail }] } })); } return entry; };
  const retire = entry => { const file = closingFile(entry); if (file) fs.rmSync(file, { force: true }); };
  const closingEntry = (kind, index = 0) => ({ id: `record-${++nextRecord}`, pid: 700000 + nextRecord + index, role: 'terminal program', reason: kind === 'noPs' ? 'inspection failed' : 'still alive', detail: kind === 'noPs' ? 'spawn ps ENOENT' : 'survived SIGKILL', kind });
  // The caller's own reapTerminalWorkers, after the supervisor exited and the PID lock was released: it retries
  // what the supervisor's cleanup left open and throws when it still cannot confirm it.
  async function closeLeftoverTerminals() {
    note('terminal-cleanup');
    const retried = closing.splice(0);
    for (const entry of retried) { clock.now += RECORD_KINDS[entry.kind].retryMs; await Promise.resolve(); }
    if (host.scenario().retryConfirms) { retried.forEach(retire); return; }
    closing.push(...retried);
    if (retried.length) throw new TerminalCleanupNotConfirmedError(retried.map(({ kind, id, ...entry }) => entry));
  }
  async function stopDaemonInstance(home, options = {}) {
    const { timeoutMs = 15000 } = options;
    if (options.force) throw new Error('A forced stop is outside this model: Agent Connect must never ask for one');
    const deadline = clock.now + timeoutMs;
    const scenario = host.scenario();
    const instance = host.readLock();
    if (options.instance && instance && !host.sameLock(instance, options.instance)) {
      throw new DaemonInstanceError('DAEMON_REPLACED', `Supervisor changed for ${home}; refusing to stop PID ${instance.pid}.`);
    }
    if (!instance || !host.ownerRunning(instance)) {
      if (instance) host.releaseLock(instance);
      await closeLeftoverTerminals();
      return { action: 'not_running', pid: instance?.pid ?? null, forced: false, usedLifecycleRpc: false };
    }
    if (instance.pid <= 1) throw new Error('Refusing to stop invalid supervisor PID');
    host.deliver(instance.pid, 'SIGTERM');
    note('sigterm');
    // The supervisor's shutdown takes the worker's grace (at most 10 s), one cleanup per terminal worker record, and
    // another look at every closing record an earlier cleanup left (3 s each).
    const records = scenario.records ?? [];
    const exitAt = scenario.supervisorHangs ? Infinity : clock.now + Math.min(scenario.workerShutdownMs ?? 0, UPSTREAM_MS.workerGrace)
      + records.reduce((sum, kind) => sum + RECORD_KINDS[kind].ms, 0) + closing.reduce((sum, entry) => sum + RECORD_KINDS[entry.kind].retryMs, 0) + (scenario.exitOverheadMs ?? 200);
    let waited = false;
    while (clock.now < exitAt) {
      if (!waited) { waited = true; scenario.duringWait?.(); }
      const current = host.readLock();
      if (current && !host.sameLock(instance, current)) throw new DaemonInstanceError('DAEMON_REPLACED', `Supervisor changed for ${home}; stop of PID ${instance.pid} was not confirmed.`);
      if (clock.now >= deadline) throw new DaemonInstanceError('STOP_NOT_CONFIRMED', `Timed out waiting for supervisor PID ${instance.pid} in ${home} to exit; use --force to permit forced cleanup.`);
      clock.now += UPSTREAM_MS.exitPoll;
      await Promise.resolve();
    }
    // The supervisor's own cleanup is what left these closing records (and confirmed the old ones, once ps works again);
    // it then released the lock and exited.
    if (scenario.retryConfirms) closing.splice(0).forEach(retire);
    closing.push(...records.filter(kind => !RECORD_KINDS[kind].confirmed).map((kind, index) => keep(closingEntry(kind, index))));
    if (!scenario.leaveSupervisor) host.exit(instance.pid);
    note('supervisor-exit');
    host.releaseLock(instance);
    note('lock-released');
    scenario.afterRelease?.();
    await closeLeftoverTerminals();
    return { action: 'stopped', pid: instance.pid, forced: false, usedLifecycleRpc: false };
  }
  /** A closing record an earlier cleanup left (a test's way to age the host without running many stops). */
  const addClosing = kind => { const entry = keep(closingEntry(kind)); closing.push(entry); return entry; };
  return { stopDaemonInstance, events, closing, addClosing };
}
