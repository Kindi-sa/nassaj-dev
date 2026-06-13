/**
 * Single-listener bind guard — B-41 ("self-hosting trap").
 *
 * Problem proven in T-95 diagnosis (2026-06-13): nassaj-dev runs as a PM2
 * fork-mode app whose claude/agy sessions are DIRECT CHILD processes of the
 * server. On `pm2 restart` while a session is active, the old process enters
 * the graceful drain (shutdown-drain.service.ts) and — because PM2 7.0.1
 * fork-mode loses track of the live pid under `treekill:false` (ADR-028 / B-24)
 * — PM2 spawns a REPLACEMENT instance while the old one is still alive and (for
 * the duration of the drain) still effectively holding port 3004. The naked
 * `server.listen()` in the replacement then throws EADDRINUSE, the process
 * exits with code 1, PM2 respawns it, and the cycle repeats every
 * exp_backoff interval.
 *
 * Evidence: 767 EADDRINUSE events on 2026-06-13 alone, a single uninterrupted
 * crash-loop from 2026-06-12 19:43 to 2026-06-13 03:13:43 (~7.5h) that only
 * ended when the surviving old process finally exited and freed the port.
 *
 * Fix: never let a bind failure crash-loop. The replacement instance:
 *   1. Retries `listen()` with bounded backoff for a finite window. This
 *      absorbs the brief, EXPECTED overlap while a draining predecessor frees
 *      the listener socket (the B-23 drain releases it within milliseconds of
 *      the stop signal, so a healthy handoff binds on the first or second try).
 *   2. If the port is STILL held after the window, the predecessor is wedged
 *      (a long-running session draining with no deadline, or a true ghost).
 *      Instead of looping forever and churning PM2 restart accounting, it
 *      exits cleanly (code 0) with a loud operator message. PM2's own restart
 *      policy then re-attempts on its schedule, but each attempt is a single
 *      bounded try rather than an instant tight crash, and the process is never
 *      marked `errored` from a bind race.
 *
 * This is transport-layer hardening only: it changes nothing about how
 * sessions run. Combined with the bounded drain default (DRAIN_TIMEOUT_MS),
 * the wedged-predecessor window is now finite from both ends.
 */

/**
 * Parses LISTEN_BIND_WINDOW_MS from the environment. A non-negative finite
 * integer is honoured; anything else falls back to the default (8000ms). This
 * lets operators widen the overlap tolerance if a slow drain handoff is
 * expected, without touching code.
 */
export function resolveBindWindowMs(raw: string | undefined, fallback = 8000): number {
  const parsed = parseInt(raw ?? '', 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

/** Minimal structural view of node:http Server used by the guard. */
type GuardHttpServer = {
  listen: (port: number, host: string, callback: () => void) => unknown;
  once: (event: 'error', listener: (err: NodeJS.ErrnoException) => void) => unknown;
  removeListener?: (event: 'error', listener: (...args: unknown[]) => void) => unknown;
};

type GuardLogger = {
  log: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
};

export type ListenWithGuardDeps = {
  server: GuardHttpServer;
  port: number;
  host: string;
  /** Called once the socket is successfully bound and listening. */
  onListening: () => void;
  /**
   * Total wall-clock budget (ms) spent retrying EADDRINUSE before giving up.
   * A healthy drain handoff frees the port within ~1 poll, so a few seconds is
   * generous. Default 8000.
   */
  bindWindowMs?: number;
  /** Delay between bind attempts (ms). Default 500. */
  retryDelayMs?: number;
  /** Clean exit when the port stays held past the window. process.exit in prod. */
  exit: (code: number) => void;
  logger?: GuardLogger;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

/** Reasons a single bind attempt can resolve. */
type AttemptResult = 'listening' | 'addr-in-use' | 'fatal';

/**
 * Binds the HTTP server to the port, tolerating a brief EADDRINUSE overlap
 * from a draining predecessor. Resolves once listening; on a wedged port it
 * exits cleanly (0) so PM2 reschedules instead of accumulating crash state.
 */
export async function listenWithGuard(deps: ListenWithGuardDeps): Promise<void> {
  const {
    server,
    port,
    host,
    onListening,
    bindWindowMs = 8000,
    retryDelayMs = 500,
    exit,
    logger = console,
    sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    now = Date.now,
  } = deps;

  const attempt = (): Promise<AttemptResult> =>
    new Promise<AttemptResult>((resolve) => {
      const onError = (err: NodeJS.ErrnoException): void => {
        if (err && err.code === 'EADDRINUSE') {
          resolve('addr-in-use');
          return;
        }
        logger.error('[LISTEN] fatal bind error:', err?.message ?? err);
        resolve('fatal');
      };

      server.once('error', onError);
      server.listen(port, host, () => {
        // Bound successfully — drop the transient error listener so a later
        // runtime socket error is not swallowed by this handler.
        server.removeListener?.('error', onError as (...args: unknown[]) => void);
        onListening();
        resolve('listening');
      });
    });

  const deadline = now() + Math.max(0, bindWindowMs);
  let attempts = 0;

  for (;;) {
    attempts += 1;
    const result = await attempt();

    if (result === 'listening') {
      if (attempts > 1) {
        logger.log(`[LISTEN] bound to ${host}:${port} after ${attempts} attempt(s)`);
      }
      return;
    }

    if (result === 'fatal') {
      // A non-EADDRINUSE failure is a real error — surface it as a crash.
      exit(1);
      return;
    }

    // EADDRINUSE: a predecessor still holds the port.
    if (now() >= deadline) {
      logger.warn(
        `[LISTEN] port ${port} still held after ${attempts} attempt(s) over ${bindWindowMs}ms — ` +
        'a draining or ghost predecessor owns the socket (B-41). Exiting cleanly (0) so the ' +
        'supervisor reschedules a single bounded retry instead of crash-looping on EADDRINUSE.',
      );
      exit(0);
      return;
    }

    logger.log(
      `[LISTEN] port ${port} in use (attempt ${attempts}); predecessor draining — retrying in ${retryDelayMs}ms`,
    );
    await sleep(retryDelayMs);
  }
}
