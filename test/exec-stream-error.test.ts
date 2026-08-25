import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';

/**
 * `spawn` is mocked at module load, in this file only — `test/exec.test.ts`
 * exercises `runCommand` against a real shell and must not be affected by a
 * global fake. `execFile` must stay real: `src/exec.ts` transitively imports
 * `src/git.ts`, which uses it (via `promisify`) at its own module scope, so a
 * bare `{ spawn: vi.fn() }` mock breaks that unrelated import.
 */
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: vi.fn() };
});

import { spawn } from 'node:child_process';
import { runCommand } from '../src/exec.js';

/**
 * Minimal fake ChildProcess: just enough surface for `runCommand` to drive
 * (`stdout`/`stderr` as EventEmitters, `pid`, `kill`, and the process itself
 * as an EventEmitter for `'error'`/`'exit'`).
 */
function fakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    pid: number;
    kill: (signal?: string) => void;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.pid = 4242;
  child.kill = vi.fn();
  return child;
}

describe('runCommand — stream error resilience', () => {
  it('survives a stdout stream error instead of throwing (EPIPE / timeout-SIGKILL race)', async () => {
    const child = fakeChild();
    vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);

    const promise = runCommand('irrelevant — spawn is mocked', {
      cwd: process.cwd(),
      timeoutMs: 5_000,
    });

    // Node's EventEmitter throws SYNCHRONOUSLY, out of this very call, if
    // 'error' has no listener. That is the actual crash this test guards
    // against: without exec.ts's own no-op stdout/stderr 'error' handlers,
    // this line — not a rejected promise, not a caught exception — takes
    // down the process, and src/cli.ts's `.then/.catch` around `main()`
    // cannot catch a synchronous throw from Node's internal stream
    // machinery.
    child.stdout.emit('error', new Error('EPIPE'));
    child.stderr.emit('end');
    child.stdout.emit('end');
    child.emit('exit', 0);

    const result = await promise;
    expect(result.exitCode).toBe(0);
    expect(result.spawnError).toBeNull();
  });
});
