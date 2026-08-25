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
export function readProviderJson(
  command: string,
  opts: { cwd: string; timeoutMs: number; env?: Record<string, string> },
): Promise<ProviderRun> {
  return new Promise((resolve) => {
    const out: string[] = [];
    const err: string[] = [];
    let timedOut = false;

    const child = spawn('bash', ['-c', command], {
      cwd: opts.cwd,
      env: { ...process.env, ...GIT_ENV_OVERRIDES, ...(opts.env ?? {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });

    child.stdout.on('data', (b: Buffer) => out.push(b.toString('utf8')));
    child.stderr.on('data', (b: Buffer) => err.push(b.toString('utf8')));

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid!, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    }, opts.timeoutMs);

    const settle = (exitCode: number | null, spawnError: Error | null) => {
      clearTimeout(timer);
      resolve({
        stdout: out.join('').trim(),
        stderr: err.join('').trim(),
        exitCode,
        timedOut,
        spawnError,
      });
    };

    child.on('error', (e) => settle(null, e));
    child.on('close', (code) => settle(code, null));
  });
}
