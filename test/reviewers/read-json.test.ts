import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { readProviderJson } from '../../src/reviewers/read-json.js';

const FIX = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/reviewers');
const run = (f: string, timeoutMs = 15_000) =>
  readProviderJson(`node ${path.join(FIX, f)}`, {
    cwd: process.cwd(),
    timeoutMs,
    env: { RLOOP_HEAD_SHA: 'a'.repeat(40) },
  });

describe('readProviderJson', () => {
  it('returns stdout containing exactly the document', async () => {
    const r = await run('clean.mjs');
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout).findings).toEqual([]);
  });

  it('keeps stderr OUT of stdout, so narration cannot corrupt the document', async () => {
    const r = await run('noisy-stderr.mjs');
    expect(() => JSON.parse(r.stdout)).not.toThrow();
    expect(r.stderr).toContain('analysing 41 files');
    expect(r.stdout).not.toContain('analysing');
  });

  it('reports a non-zero exit without throwing', async () => {
    const r = await run('crash.mjs');
    expect(r.exitCode).toBe(3);
    expect(r.stderr).toContain('boom');
    expect(r.spawnError).toBeNull();
  });

  it('propagates a non-zero exit from a missing binary', async () => {
    const r = await readProviderJson('definitely-not-a-real-binary-xyz', {
      cwd: process.cwd(),
      timeoutMs: 15_000,
    });
    expect(r.exitCode).not.toBe(0);
  });

  it('reports a spawn failure rather than throwing', async () => {
    // A missing BINARY does not reach this path: `bash -c missing-thing`
    // spawns bash fine and exits 127 through `close`. A missing CWD does —
    // bash itself cannot be spawned, and `error` fires with ENOENT.
    const r = await readProviderJson('node --version', {
      cwd: '/nonexistent-directory-for-rloop-spawn-test',
      timeoutMs: 15_000,
    });
    expect(r.spawnError).not.toBeNull();
    expect(r.spawnError?.message).toMatch(/ENOENT/);
    expect(r.exitCode).toBeNull();
  });

  it('times out and says so', async () => {
    const r = await run('hang.mjs', 1_000);
    expect(r.timedOut).toBe(true);
  }, 20_000);

  it('passes the supplied env through to the provider', async () => {
    const r = await run('clean.mjs');
    expect(JSON.parse(r.stdout).sha).toBe('a'.repeat(40));
  });
});
