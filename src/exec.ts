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
export function runCommand(command: string, opts: CommandOptions): Promise<CommandOutcome> {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const chunks: string[] = [];
    let timedOut = false;

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
        output: chunks.join(''),
        exitCode,
        timedOut,
        spawnError,
        durationMs: Date.now() - startedAt,
      });
    };

    child.on('error', (err) => settle(null, err));
    child.on('close', (code) => settle(code, null));
  });
}
