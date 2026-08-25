import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path, { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import type { ReviewVerdict } from '../../src/forge/types.js';
import { collectReviewerReports, degradationOf } from '../../src/reviewers/collect.js';

const HEAD = 'a'.repeat(40);
const OLD = 'b'.repeat(40);
const base = `
version: 1
gates:
  - name: build
    run: npm run build
    require: ["^ok$"]
`;
const forgeCfg = loadConfig(`${base}
reviewers:
  - name: copilot
    kind: forge
    login: copilot-pull-request-reviewer
    required_state: any_verdict
`);
const review = (over: Partial<ReviewVerdict> = {}): ReviewVerdict => ({
  author: 'copilot-pull-request-reviewer',
  state: 'COMMENTED',
  sha: HEAD,
  submittedAt: '2026-08-25T10:00:00Z',
  ...over,
});
const collect = (cfg = forgeCfg, reviews: ReviewVerdict[] = []) =>
  collectReviewerReports(cfg, { repoRoot: process.cwd(), headSha: HEAD, reviews });

describe('collectReviewerReports — forge', () => {
  it('reports absent when the reviewer has not reviewed', async () => {
    expect((await collect()).at(0)!.status).toBe('absent');
  });

  it('reports clean for a COMMENTED review under any_verdict', async () => {
    expect((await collect(forgeCfg, [review()])).at(0)!.status).toBe('clean');
  });

  it('reports findings for a COMMENTED review under approved', async () => {
    const cfg = loadConfig(`${base}
reviewers:
  - name: copilot
    kind: forge
    login: copilot-pull-request-reviewer
    required_state: approved
`);
    expect((await collect(cfg, [review()])).at(0)!.status).toBe('findings');
  });

  it('reports stale when the latest review is against another sha', async () => {
    expect((await collect(forgeCfg, [review({ sha: OLD })])).at(0)!.status).toBe('stale');
  });

  it('uses the LATEST review, not the first', async () => {
    const reports = await collect(forgeCfg, [
      review({ state: 'CHANGES_REQUESTED', submittedAt: '2026-08-25T09:00:00Z' }),
      review({ state: 'APPROVED', submittedAt: '2026-08-25T11:00:00Z' }),
    ]);
    expect(reports.at(0)!.status).toBe('clean');
  });

  it('leaves findings empty for a forge reviewer', async () => {
    expect((await collect(forgeCfg, [review()])).at(0)!.findings).toEqual([]);
  });

  it('prefers stale over CHANGES_REQUESTED when the review is against another commit', async () => {
    // Order dependence, and it is real: a rejection of a DIFFERENT commit is
    // not a rejection of this one. Swapping the two checks leaves every other
    // test green, so this is the only thing pinning it.
    const r = await collect(forgeCfg, [review({ state: 'CHANGES_REQUESTED', sha: OLD })]);
    expect(r.at(0)!.status).toBe('stale');
  });
});

describe('collectReviewerReports — command dispatch', () => {
  const FIX = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/reviewers');
  const commandCfg = (script: string) =>
    loadConfig(`${base}
reviewers:
  - name: codex
    kind: command
    run: node ${path.join(FIX, script)}
`);

  it('dispatches a command reviewer through the same entry point', async () => {
    const r = await collectReviewerReports(commandCfg('clean.mjs'), {
      repoRoot: process.cwd(), headSha: HEAD, reviews: [],
    });
    expect(r.at(0)!.kind).toBe('command');
    expect(r.at(0)!.status).toBe('clean');
  });

  it('an unavailable command reviewer becomes degradation', async () => {
    const cfg = loadConfig(`${base}
reviewers:
  - name: codex
    kind: command
    run: definitely-not-a-real-binary-xyz
`);
    const reports = await collectReviewerReports(cfg, {
      repoRoot: process.cwd(), headSha: HEAD, reviews: [],
    });
    expect(reports.at(0)!.status).toBe('unavailable');
    expect(degradationOf(reports, cfg)?.reason).toBe('unavailable');
  });

  it('a malformed command reviewer becomes degradation, distinctly from unavailable', async () => {
    // malformed and unavailable both block, and both must arrive here with
    // their own reason: a reviewer you broke is a different problem from one
    // you never had, and the operator needs to be told which.
    const cfg = commandCfg('bad-schema.mjs');
    const reports = await collectReviewerReports(cfg, {
      repoRoot: process.cwd(), headSha: HEAD, reviews: [],
    });
    expect(reports.at(0)!.status).toBe('malformed');
    expect(degradationOf(reports, cfg)?.reason).toBe('malformed');
  });

  it('runs reviewers sequentially, not concurrently', async () => {
    // Result ORDER would not catch this — Promise.all preserves it. Only
    // execution overlap distinguishes the two, so the fixtures record when
    // they start and finish. Under Promise.all the fast reviewer finishes
    // inside the slow one's 400ms delay and the markers interleave.
    const log = join(tmpdir(), `rloop-seq-${process.pid}.log`);
    writeFileSync(log, '');
    try {
      const cfg = loadConfig(`${base}
reviewers:
  - name: slow
    kind: command
    run: RLOOP_MARKER_LOG=${log} node ${join(FIX, 'slow-marker.mjs')}
  - name: fast
    kind: command
    run: RLOOP_MARKER_LOG=${log} node ${join(FIX, 'fast-marker.mjs')}
`);
      await collectReviewerReports(cfg, { repoRoot: process.cwd(), headSha: HEAD, reviews: [] });
      expect(readFileSync(log, 'utf8').trim().split('\n')).toEqual([
        'slow-start', 'slow-end', 'fast-start', 'fast-end',
      ]);
    } finally {
      rmSync(log, { force: true });
    }
  }, 20_000);
});

describe('degradationOf', () => {
  it('is not_configured when no reviewers are declared', async () => {
    const cfg = loadConfig(base);
    const d = degradationOf(await collectReviewerReports(cfg, {
      repoRoot: process.cwd(), headSha: HEAD, reviews: [],
    }), cfg);
    expect(d?.reason).toBe('not_configured');
  });

  it('is null when a reviewer reported, even with findings', async () => {
    expect(degradationOf(await collect(forgeCfg, [review()]), forgeCfg)).toBeNull();
  });

  it('is NOT degraded merely because a forge reviewer is absent', async () => {
    // Absence is already a merge blocker with its own code. Calling it
    // degradation would report "no provider available" when one is configured
    // and simply has not answered yet.
    expect(degradationOf(await collect(), forgeCfg)).toBeNull();
  });

  it('not_configured wins over an unavailable report', async () => {
    // This combination cannot arise from collectReviewerReports, which derives
    // reports FROM cfg.reviewers. Pinned anyway: the precedence is deliberate,
    // and an unpinned deliberate choice is indistinguishable from an accident.
    const cfg = loadConfig(base);
    const d = degradationOf(
      [{ name: 'x', kind: 'command', status: 'unavailable', sha: null, findings: [], detail: 'ENOENT' }],
      cfg,
    );
    expect(d?.reason).toBe('not_configured');
  });
});
