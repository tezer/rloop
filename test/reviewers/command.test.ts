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
    // bash itself spawned fine and exited 127 with unparseable output — it
    // ran, unlike an unspawnable cwd, so this is 'crashed', not 'never_ran'.
    expect(r.unavailableReason).toBe('crashed');
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
    // Never ran at all — this is the one cause "could not run" is true of.
    expect(r.unavailableReason).toBe('never_ran');
  });

  it('reports unavailable when the command crashes without a document', async () => {
    const r = await go('crash.mjs');
    expect(r.status).toBe('unavailable');
    // The process ran and exited non-zero without usable output — distinct
    // from never having run at all (see I1: merge-gate.ts must not say
    // "could not run" for this cause, since it did run).
    expect(r.unavailableReason).toBe('crashed');
  });

  it('reports MALFORMED, not unavailable, when it exits 0 with junk', async () => {
    // The distinction is the point: a reviewer you broke is a different
    // problem from one you never had.
    expect((await go('junk-exit-zero.mjs')).status).toBe('malformed');
  });

  it('reports malformed when valid JSON fails the schema', async () => {
    expect((await go('bad-schema.mjs')).status).toBe('malformed');
  });

  it('reports unavailable, not malformed, when schema-invalid output is paired with a non-zero exit', async () => {
    // The exit code is the provider's own verdict on whether it ran. rloop
    // trusts that over the shape of whatever it printed: a non-zero exit
    // beats a schema failure, same as it beats an unparseable document.
    const r = await go('bad-schema-exit-1.mjs');
    expect(r.status).toBe('unavailable');
    expect(r.unavailableReason).toBe('crashed');
  });

  it('reports findings, not clean or unavailable, when a parsed document has blocking findings and a non-zero exit', async () => {
    // Linters conventionally exit non-zero BECAUSE they found something. A
    // non-zero exit may never produce `clean`, but it must not override a
    // document that already reports blocking findings either — the document
    // is trusted here, same as the timeout-vs-schema precedence above.
    const r = await go('findings-exit-1.mjs');
    expect(r.status).toBe('findings');
    expect(r.findingsReason).toBe('provider_findings');
    expect(r.findings).toHaveLength(1);
  });

  it('reports unavailable, not clean, when a parsed document reports nothing blocking but the exit is non-zero', async () => {
    // The rule this test pins: a non-zero exit may NEVER result in `clean`.
    // A well-formed, schema-valid document with no blocking findings would
    // otherwise be `clean` — but exiting non-zero means the provider's own
    // signals contradict each other, and rloop does not resolve that
    // contradiction in the merge-permitting direction.
    const r = await go('clean-exit-1.mjs');
    expect(r.status).toBe('unavailable');
    expect(r.findingsReason).toBeNull();
    expect(r.detail).toMatch(/contradict/i);
    // It ran and produced a valid document — merge-gate.ts must not render
    // this as "could not run" (I1). unavailableReason is how it knows not to.
    expect(r.unavailableReason).toBe('contradicted');
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
    expect(r.unavailableReason).toBe('never_ran');
  }, 20_000);

  it('does not truncate a several-hundred-KB document round-tripped through parsing (large-payload regression guard)', async () => {
    const r = await go('large-payload.mjs');
    expect(r.status).toBe('clean'); // minor-only
    const size = 400 * 1024;
    expect(r.findings[0].body).toHaveLength(size);
    expect(r.findings[0].body?.endsWith('END-OF-BODY')).toBe(true);
  });

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
