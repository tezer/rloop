import { describe, expect, it } from 'vitest';

import { loadConfig, type RloopConfig } from '../src/config.js';
import { matchesReviewer, type PullRequest, type ReviewThread, type ReviewVerdict } from '../src/forge/types.js';
import { evaluateMergeGate, type BlockerCode } from '../src/merge-gate.js';
import type { GateRunResult } from '../src/types.js';

const HEAD = 'a'.repeat(40);
const OLD = 'b'.repeat(40);

const cfg = (extra = ''): RloopConfig =>
  loadConfig(`
version: 1
gates:
  - name: build
    run: npm run build
    require: ["^Route \\\\("]
merge:
  enabled: true
  allowed_base_branches: [staging]
  required_reviewers: [copilot-pull-request-reviewer]
${extra}
`);

const pr = (over: Partial<PullRequest> = {}): PullRequest => ({
  number: 42,
  baseRef: 'staging',
  headSha: HEAD,
  state: 'OPEN',
  isDraft: false,
  title: 'feat: thing',
  url: 'https://github.com/o/r/pull/42',
  ...over,
});

const greenRun = (over: Partial<GateRunResult> = {}): GateRunResult => ({
  green: true,
  partial: false,
  sha: HEAD,
  invalidatedBy: null,
  gates: [],
  durationMs: 1,
  logDir: '/tmp',
  ...over,
});

const review = (over: Partial<ReviewVerdict> = {}): ReviewVerdict => ({
  author: 'copilot-pull-request-reviewer',
  state: 'APPROVED',
  sha: HEAD,
  submittedAt: '2026-08-12T10:00:00Z',
  ...over,
});

const thread = (over: Partial<ReviewThread> = {}): ReviewThread => ({
  id: 'PRRT_1',
  isResolved: true,
  isOutdated: false,
  path: 'src/a.ts',
  firstCommentId: 1,
  firstCommentAuthor: 'Copilot',
  firstCommentBody: 'nit',
  ...over,
});

const codes = (d: { blockers: { code: BlockerCode }[] }) => d.blockers.map((b) => b.code);

describe('evaluateMergeGate', () => {
  it('allows a merge when every condition holds on one SHA', () => {
    const d = evaluateMergeGate({
      cfg: cfg(),
      pr: pr(),
      gateRun: greenRun(),
      reviews: [review()],
      threads: [thread()],
    });
    expect(d.blockers).toEqual([]);
    expect(d.allowed).toBe(true);
  });

  it('blocks when merge is disabled — the default posture', () => {
    const disabled = loadConfig(`
version: 1
gates:
  - name: build
    run: x
    forbid: ["npm ERR!"]
`);
    const d = evaluateMergeGate({
      cfg: disabled,
      pr: pr(),
      gateRun: greenRun(),
      reviews: [],
      threads: [],
    });
    expect(codes(d)).toContain('merge_disabled');
  });

  it('blocks a base branch that is not on the allowlist', () => {
    const d = evaluateMergeGate({
      cfg: cfg(),
      pr: pr({ baseRef: 'main' }),
      gateRun: greenRun(),
      reviews: [review()],
      threads: [],
    });
    expect(codes(d)).toContain('base_not_allowed');
  });

  it('treats a MISSING review as a blocker, never as approval', () => {
    const d = evaluateMergeGate({
      cfg: cfg(),
      pr: pr(),
      gateRun: greenRun(),
      reviews: [], // nobody has reviewed yet
      threads: [],
    });
    expect(codes(d)).toContain('reviewer_no_verdict');
    expect(d.allowed).toBe(false);
  });

  it('blocks a review submitted against an older commit', () => {
    const d = evaluateMergeGate({
      cfg: cfg(),
      pr: pr(),
      gateRun: greenRun(),
      reviews: [review({ sha: OLD })],
      threads: [],
    });
    expect(codes(d)).toContain('reviewer_stale');
  });

  it('uses the LATEST review, so an old approval cannot outvote new changes', () => {
    const d = evaluateMergeGate({
      cfg: cfg(),
      pr: pr(),
      gateRun: greenRun(),
      reviews: [
        review({ state: 'APPROVED', submittedAt: '2026-08-12T09:00:00Z' }),
        review({ state: 'CHANGES_REQUESTED', submittedAt: '2026-08-12T11:00:00Z' }),
      ],
      threads: [],
    });
    expect(codes(d)).toContain('reviewer_changes_requested');
  });

  it('matches a reviewer across GitHub’s three login spellings', () => {
    for (const spelling of ['Copilot', 'copilot-pull-request-reviewer', 'copilot-pull-request-reviewer[bot]']) {
      const d = evaluateMergeGate({
        cfg: cfg(),
        pr: pr(),
        gateRun: greenRun(),
        reviews: [review({ author: spelling })],
        threads: [],
      });
      expect(codes(d), `spelling: ${spelling}`).not.toContain('reviewer_no_verdict');
    }
  });

  it('blocks when gates ran on a different commit than the PR head', () => {
    const d = evaluateMergeGate({
      cfg: cfg(),
      pr: pr(),
      gateRun: greenRun({ sha: OLD }),
      reviews: [review()],
      threads: [],
    });
    expect(codes(d)).toContain('sha_mismatch_gates');
  });

  it('blocks a partial gate run even though every selected gate passed', () => {
    const d = evaluateMergeGate({
      cfg: cfg(),
      pr: pr(),
      gateRun: greenRun({ green: false, partial: true }),
      reviews: [review()],
      threads: [],
    });
    expect(codes(d)).toContain('gates_not_green');
  });

  it('blocks a void gate run (dirty worktree)', () => {
    const d = evaluateMergeGate({
      cfg: cfg(),
      pr: pr(),
      gateRun: greenRun({ green: false, invalidatedBy: 'dirty_worktree' }),
      reviews: [review()],
      threads: [],
    });
    expect(d.blockers.find((b) => b.code === 'gates_not_green')?.message).toMatch(/dirty_worktree/);
  });

  it('blocks on unresolved threads', () => {
    const d = evaluateMergeGate({
      cfg: cfg(),
      pr: pr(),
      gateRun: greenRun(),
      reviews: [review()],
      threads: [thread({ isResolved: true }), thread({ id: 'PRRT_2', isResolved: false })],
    });
    expect(codes(d)).toContain('threads_unresolved');
  });

  it('allows an outdated thread as long as it is resolved', () => {
    const d = evaluateMergeGate({
      cfg: cfg(),
      pr: pr(),
      gateRun: greenRun(),
      reviews: [review()],
      threads: [thread({ isOutdated: true, isResolved: true })],
    });
    expect(d.allowed).toBe(true);
  });

  it('reports EVERY blocker at once, not just the first', () => {
    const d = evaluateMergeGate({
      cfg: cfg(),
      pr: pr({ baseRef: 'main', isDraft: true }),
      gateRun: greenRun({ green: false, sha: OLD }),
      reviews: [],
      threads: [thread({ isResolved: false })],
    });
    expect(new Set(codes(d))).toEqual(
      new Set([
        'base_not_allowed',
        'pr_draft',
        'gates_not_green',
        'sha_mismatch_gates',
        'reviewer_no_verdict',
        'threads_unresolved',
      ]),
    );
  });
});

describe('matchesReviewer', () => {
  it('ignores the [bot] suffix in either direction', () => {
    expect(matchesReviewer('dependabot[bot]', 'dependabot')).toBe(true);
    expect(matchesReviewer('dependabot', 'dependabot[bot]')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(matchesReviewer('Copilot', 'copilot')).toBe(true);
  });

  it('does not match unrelated reviewers', () => {
    expect(matchesReviewer('copilot', 'tezer')).toBe(false);
  });
});
