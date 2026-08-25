import { describe, expect, it } from 'vitest';
import { runCommand } from '../src/exec.js';

describe('runCommand', () => {
  it('captures interleaved stdout and stderr, and reports the exit code', async () => {
    const r = await runCommand('echo out && echo err 1>&2 && exit 3', { cwd: process.cwd(), timeoutMs: 15_000 });
    expect(r.output).toContain('out');
    expect(r.output).toContain('err');
    expect(r.exitCode).toBe(3);
  });

  it('resolves promptly when the command exits, not on a backgrounded grandchild closing its stdio', async () => {
    // Same bug as src/reviewers/read-json.ts, same fix: resolving on 'close'
    // instead of 'exit' waits for every inherited stdio fd to close,
    // including one held open by a process a gate backgrounded without
    // redirecting output (`sleep 2 &` with no `>/dev/null`). Before the fix
    // this gate command would not resolve until the backgrounded sleep
    // itself exited.
    const start = Date.now();
    const r = await runCommand('sleep 2 & echo RLOOP_DONE', {
      cwd: process.cwd(),
      timeoutMs: 15_000,
    });
    const elapsed = Date.now() - start;

    expect(r.timedOut).toBe(false);
    expect(r.exitCode).toBe(0);
    expect(r.output).toContain('RLOOP_DONE');
    expect(elapsed).toBeLessThan(1_500);
  });

  it('does not truncate a several-hundred-KB payload (large-payload regression guard)', async () => {
    // Same property src/reviewers/read-json.ts pins for provider documents,
    // guarded here too since gate output goes through this same 'exit'-based
    // resolution.
    const size = 400 * 1024;
    const r = await runCommand(`node -e "process.stdout.write('x'.repeat(${size}) + 'END-OF-OUTPUT')"`, {
      cwd: process.cwd(),
      timeoutMs: 15_000,
    });
    expect(r.exitCode).toBe(0);
    expect(r.output).toHaveLength(size + 'END-OF-OUTPUT'.length);
    expect(r.output.endsWith('END-OF-OUTPUT')).toBe(true);
  });
});
