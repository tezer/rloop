import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Separate module from `test/reviewers/read-json.test.ts` for the same
 * reason as `test/exec-stream-error.test.ts`: `spawn` is mocked here, and
 * that must not leak into the tests that exercise `readProviderJson` against
 * real fixture processes.
 */
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: vi.fn() };
});

import { spawn } from 'node:child_process';
import { readProviderJson } from '../../src/reviewers/read-json.js';

function fakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    pid: number;
    kill: (signal?: string) => void;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.pid = 999_999; // deliberately not a real pid — process.kill(-pid) must throw and fall back to child.kill()
  child.kill = vi.fn();
  return child;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('readProviderJson — timeout does not overshoot the drain grace window', () => {
  it('settles as soon as the killed provider exits, without waiting out DRAIN_GRACE_MS', async () => {
    vi.useFakeTimers();
    const child = fakeChild();
    vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);

    const promise = readProviderJson('irrelevant — spawn is mocked', { cwd: process.cwd(), timeoutMs: 50 });
    let settled = false;
    void promise.then(() => {
      settled = true;
    });

    // Fire the timeout: sets timedOut and SIGKILLs the (fake) process group.
    // Streams have not ended yet — same as a provider whose stdio fd is
    // genuinely slow to close after the kill.
    await vi.advanceTimersByTimeAsync(50);
    expect(settled).toBe(false); // still waiting on the process to actually exit

    // The killed process reports its exit; stdout/stderr 'end' have NOT
    // fired. Before the fix this fell into the same DRAIN_GRACE_MS branch a
    // normal exit uses, and the promise stayed pending for another 300ms
    // despite there being nothing left to drain (the kill already ended
    // everything in the process group). The fix must settle right here.
    child.emit('exit', null);
    await vi.advanceTimersByTimeAsync(0);

    expect(settled).toBe(true);
    const result = await promise;
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBeNull();
  });
});
