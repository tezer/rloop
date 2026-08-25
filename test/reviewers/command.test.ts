import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { runCommandReviewer } from '../../src/reviewers/command.js';

const FIX = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/reviewers');
const HEAD = 'a'.repeat(40);
const rev = (file: string, dismiss: Array<{ fingerprint: string; reason: string }> = []) => ({
  name: 'codex',
  run: `node ${path.join(FIX, file)}`,
  timeout_seconds: 15,
  dismiss,
});
const go = (file: string, dismiss?: Array<{ fingerprint: string; reason: string }>) =>
  runCommandReviewer(rev(file, dismiss), { repoRoot: process.cwd(), headSha: HEAD });

describe('runCommandReviewer', () => {
  it('reports clean when the document has no findings', async () => {
    expect((await go('clean.mjs')).status).toBe('clean');
  });

  it('reports findings, and computes a fingerprint for each', async () => {
    const r = await go('findings.mjs');
    expect(r.status).toBe('findings');
    expect(r.findings).toHaveLength(2);
    for (const f of r.findings) expect(f.fingerprint).toMatch(/^[0-9a-f]{8}$/);
  });

  it('is clean when only MINOR findings are present', async () => {
    // minor never blocks, but the findings still travel in the report.
    const r = await go('minor-only.mjs');
    expect(r.status).toBe('clean');
    expect(r.findings).toHaveLength(1);
  });

  it('names dismissals that matched nothing, so dead entries can be deleted', async () => {
    // A dismissal list that quietly accumulates unmatched entries is how a
    // real finding gets pre-suppressed by accident. Warning, not an error:
    // the usual cause is that the finding was genuinely fixed.
    const r = await go('clean.mjs', [{ fingerprint: 'deadbeef', reason: 'stale entry' }]);
    expect(r.status).toBe('clean');
    expect(r.detail).toContain('deadbeef');
  });

  it('reports unavailable when the command is not found (bash exits 127)', async () => {
    const r = await runCommandReviewer(
      { ...rev('clean.mjs'), run: 'definitely-not-a-real-binary-xyz' },
      { repoRoot: process.cwd(), headSha: HEAD },
    );
    expect(r.status).toBe('unavailable');
  });

  it('reports unavailable when the command cannot be SPAWNED at all', async () => {
    // Distinct from a missing binary, which spawns bash successfully and
    // exits 127 into the unparseable branch. An unspawnable cwd is the only
    // way to reach `run.spawnError`.
    const r = await runCommandReviewer(rev('clean.mjs'), {
      repoRoot: '/nonexistent-directory-for-rloop-reviewer-test',
      headSha: HEAD,
    });
    expect(r.status).toBe('unavailable');
    expect(r.detail).toMatch(/could not start/);
  });

  it('reports unavailable when the command crashes without a document', async () => {
    expect((await go('crash.mjs')).status).toBe('unavailable');
  });

  it('reports MALFORMED, not unavailable, when it exits 0 with junk', async () => {
    // The distinction is the point: a reviewer you broke is a different
    // problem from one you never had.
    expect((await go('junk-exit-zero.mjs')).status).toBe('malformed');
  });

  it('reports malformed when valid JSON fails the schema', async () => {
    expect((await go('bad-schema.mjs')).status).toBe('malformed');
  });

  it('reports stale when the echoed sha is not the head', async () => {
    const r = await go('wrong-sha.mjs');
    expect(r.status).toBe('stale');
    expect(r.detail).toContain('c'.repeat(7));
  });

  it('prefers stale over findings when the provider reviewed another commit', async () => {
    // Order dependence, and it is real: findings against a non-head tree
    // must not be reported as findings against head.
    const r = await go('wrong-sha-with-findings.mjs');
    expect(r.status).toBe('stale');
  });

  it('times out into unavailable', async () => {
    const r = await runCommandReviewer(
      { ...rev('hang.mjs'), timeout_seconds: 1 },
      { repoRoot: process.cwd(), headSha: HEAD },
    );
    expect(r.status).toBe('unavailable');
    expect(r.detail).toMatch(/timed out/i);
  }, 20_000);

  it('a dismissed blocking finding is reported but does not block', async () => {
    const first = await go('findings.mjs');
    const critical = first.findings.find((f) => f.severity === 'critical')!;
    const r = await go('findings.mjs', [
      { fingerprint: critical.fingerprint, reason: 'guard is in the caller' },
    ]);
    expect(r.status).toBe('clean');
    expect(r.findings.find((f) => f.fingerprint === critical.fingerprint)?.dismissed).toBe(true);
  });
});
