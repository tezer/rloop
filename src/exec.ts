import { spawn } from 'node:child_process';

import { GIT_ENV_OVERRIDES } from './git.js';

export interface CommandOutcome {
  /** stdout and stderr, interleaved in arrival order. */
  output: string;
  exitCode: number | null;
  timedOut: boolean;
  spawnError: Error | null;
  durationMs: number;
}

export interface CommandOptions {
  cwd: string;
  timeoutMs: number;
  env?: Record<string, string>;
}

/**
 * Run a shell command, capturing stdout and stderr INTERLEAVED into one buffer.
 *
 * Interleaving matters: markers are positional ("did the route table print
 * after the type-check?"), and splitting the streams destroys that ordering.
 */
// Grace window for draining stdio after 'exit', before settling on whatever
// arrived. It sits between two failure modes: settle on 'exit' with no drain
// at all and a chunk still in flight when the event fires is lost — Node
// documents that stdio streams "might still be open" at 'exit' — while
// waiting for 'close' instead blocks on every inherited fd, including one a
// backgrounded grandchild (`sleep 100 &` with no `>/dev/null`) holds open
// long after the command itself is done. A few hundred milliseconds is ample
// for the normal case, where the streams are already drained by the time
// 'exit' fires, and short enough that a held-open pipe cannot stall the run.
//
// UNPINNED, deliberately: deleting this drain leaves the suite green — the
// truncation it prevents isn't locally reproducible (20MB, 100+ trials on
// Linux/Node 22, no loss seen). It stays because Node documents stdio as
// possibly still open at 'exit', and completeness is this function's whole
// contract; no observed failure is not evidence of safety here. Do not
// read its presence as evidence anything checks it.
const DRAIN_GRACE_MS = 300;

export function runCommand(command: string, opts: CommandOptions): Promise<CommandOutcome> {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const chunks: string[] = [];
    let timedOut = false;
    // Node documents 'error' as firing before 'exit' when a spawn fails, but
    // that ordering is a runtime guarantee, not something this function's
    // correctness should lean on silently — guard it directly, same as
    // src/reviewers/read-json.ts, so a second event is a no-op instead of a
    // second resolve() call.
    let settled = false;
    let stdoutEnded = false;
    let stderrEnded = false;
    let graceTimer: ReturnType<typeof setTimeout> | null = null;

    const child = spawn('bash', ['-c', command], {
      cwd: opts.cwd,
      // Gate commands get the SCRUBBED git environment, not the raw one.
      // Scrubbing rloop's own git calls is not enough: gates run scripts that
      // read git themselves, and a leaked GIT_DIR would send those to another
      // repository while rloop reported honestly about this one. A gate that
      // genuinely needs an override can still set it explicitly via `env:`,
      // which is applied last and deliberately wins.
      env: { ...process.env, ...GIT_ENV_OVERRIDES, ...(opts.env ?? {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
      // Own process group, so a timeout kills the whole tree rather than
      // orphaning children (a hung container pull outlives its npm parent).
      detached: true,
    });

    const collect = (buf: Buffer) => chunks.push(buf.toString('utf8'));
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    // Without these, a stream error — an EPIPE, or one racing the timeout's
    // own SIGKILL below — is an unhandled 'error' event on a Readable. That
    // throws synchronously out of Node's stream machinery, past this
    // function's Promise executor, uncaught by anything: every gate rloop
    // runs, including rloop's own self-gating, goes through this function,
    // so that crash takes down the whole process rather than failing the one
    // gate that hit it. See src/reviewers/read-json.ts for the identical
    // hazard on the provider path — same invariant, same fix.
    child.stdout.on('error', () => {});
    child.stderr.on('error', () => {});

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid!, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    }, opts.timeoutMs);

    const settle = (exitCode: number | null, spawnError: Error | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (graceTimer) clearTimeout(graceTimer);
      resolve({
        output: chunks.join(''),
        exitCode,
        timedOut,
        spawnError,
        durationMs: Date.now() - startedAt,
      });
    };

    // Settle as soon as BOTH streams have ended, if 'exit' already fired and
    // is just waiting on the drain — see the grace-timer branch below.
    let exitedWith: number | null = null;
    let exitPending = false;
    const settleIfDrained = () => {
      if (exitPending && stdoutEnded && stderrEnded) settle(exitedWith, null);
    };
    child.stdout.on('end', () => {
      stdoutEnded = true;
      settleIfDrained();
    });
    child.stderr.on('end', () => {
      stderrEnded = true;
      settleIfDrained();
    });

    child.on('error', (err) => settle(null, err));
    // Resolve on a bounded drain after 'exit', not on 'close' — see
    // DRAIN_GRACE_MS above for why neither raw 'exit' nor 'close' is safe on
    // its own. Output already collected above via the 'data' listeners is
    // what gets reported either way.
    child.on('exit', (code) => {
      exitedWith = code;
      if (stdoutEnded && stderrEnded) {
        settle(code, null);
        return;
      }
      if (timedOut) {
        // The timeout above already SIGKILLed the whole process group, so
        // there is no writer left to drain — waiting out DRAIN_GRACE_MS here
        // would just let a timed-out command overshoot opts.timeoutMs by up
        // to that long for nothing. Settle immediately on whatever arrived
        // before the kill.
        settle(code, null);
        return;
      }
      exitPending = true;
      graceTimer = setTimeout(() => settle(code, null), DRAIN_GRACE_MS);
    });
  });
}
