import { spawn } from 'node:child_process';

import { GIT_ENV_OVERRIDES } from '../git.js';

export interface ProviderRun {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  spawnError: Error | null;
}

/**
 * Run a review provider and capture its streams SEPARATELY.
 *
 * `exec.ts::runCommand` cannot be reused here. It interleaves stdout and
 * stderr into one buffer on purpose — gate markers are positional — and a
 * provider that narrates progress on stderr would corrupt the JSON document
 * with it. See test/fixtures/reviewers/noisy-stderr.mjs.
 *
 * The git environment is scrubbed for the same reason gates are: a provider
 * that reads git under a leaked GIT_DIR reviews another repository and says
 * nothing about it.
 */
// Grace window for draining stdio after 'exit', before settling on whatever
// arrived — same constant and same reasoning as src/exec.ts. It sits between
// two failure modes: settle on 'exit' with no drain at all and a chunk still
// in flight when the event fires is lost — Node documents that stdio streams
// "might still be open" at 'exit' — while waiting for 'close' instead blocks
// on every inherited fd, including one a provider backgrounded without
// redirecting (`some-tool &` with no `>/dev/null`) still holds open. A few
// hundred milliseconds is ample for the normal case, where the streams are
// already drained by the time 'exit' fires, and short enough that a held-open
// pipe cannot stall the run.
//
// UNPINNED, deliberately: deleting this drain leaves the suite green — the
// truncation it prevents isn't locally reproducible (20MB, 100+ trials on
// Linux/Node 22, no loss seen). It stays because Node documents stdio as
// possibly still open at 'exit', and completeness is this function's whole
// contract; no observed failure is not evidence of safety here. Do not
// read its presence as evidence anything checks it.
const DRAIN_GRACE_MS = 300;

export function readProviderJson(
  command: string,
  opts: { cwd: string; timeoutMs: number; env?: Record<string, string> },
): Promise<ProviderRun> {
  return new Promise((resolve) => {
    const out: string[] = [];
    const err: string[] = [];
    let timedOut = false;
    // Node documents 'error' as firing before 'close' when a spawn fails,
    // but that ordering is a runtime guarantee, not something this
    // function's correctness should lean on silently — guard it directly so
    // a second event is a no-op instead of a second resolve() call.
    let settled = false;
    let stdoutEnded = false;
    let stderrEnded = false;
    let graceTimer: ReturnType<typeof setTimeout> | null = null;

    const child = spawn('bash', ['-c', command], {
      cwd: opts.cwd,
      env: { ...process.env, ...GIT_ENV_OVERRIDES, ...(opts.env ?? {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });

    child.stdout.on('data', (b: Buffer) => out.push(b.toString('utf8')));
    child.stderr.on('data', (b: Buffer) => err.push(b.toString('utf8')));
    // Without these, an EPIPE (or any other stream error — e.g. racing the
    // timeout's SIGKILL) is an unhandled 'error' event on a Readable, which
    // crashes the whole rloop process instead of degrading one reviewer.
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
        stdout: out.join('').trim(),
        stderr: err.join('').trim(),
        exitCode,
        timedOut,
        spawnError,
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

    child.on('error', (e) => settle(null, e));
    // Resolve on a bounded drain after 'exit' — the provider process itself
    // terminating — rather than raw 'exit' or 'close'. See DRAIN_GRACE_MS
    // above for why neither is safe alone. Whatever stdout/stderr has
    // arrived is already captured above via the 'data' listeners, which fire
    // as chunks arrive rather than only once the streams close.
    child.on('exit', (code) => {
      exitedWith = code;
      if (stdoutEnded && stderrEnded) {
        settle(code, null);
        return;
      }
      exitPending = true;
      graceTimer = setTimeout(() => settle(code, null), DRAIN_GRACE_MS);
    });
  });
}
