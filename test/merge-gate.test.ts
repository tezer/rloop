import { describe, expect, it } from 'vitest';

import { loadConfig, type RloopConfig } from '../src/config.js';
import { matchesReviewer, type PullRequest, type ReviewThread, type ReviewVerdict } from '../src/forge/types.js';
import { evaluateMergeGate, type BlockerCode } from '../src/merge-gate.js';
import { collectReviewerReports, degradationOf } from '../src/reviewers/collect.js';
import type { ReviewerReport } from '../src/reviewers/types.js';
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
  required_reviewer_state: any_verdict
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

/**
 * Realistic conversion from raw forge reviews to what `evaluateMergeGate` now
 * consumes — exactly the wiring `prStatus` in src/pr.ts does. The old tests
 * below build `reviews:` because that is the input the forge API gives you;
 * running it through the real `collectReviewerReports` / `degradationOf`
 * pair (rather than hand-rolling a `ReviewerReport`) keeps those tests
 * honest about what the pipeline actually produces.
 */
async function reviewerInputs(c: RloopConfig, headSha: string, reviews: ReviewVerdict[]) {
  const reviewerReports = await collectReviewerReports(c, { repoRoot: '.', headSha, reviews });
  const degradation = degradationOf(reviewerReports, c);
  return { reviewerReports, degradation };
}

describe('evaluateMergeGate', () => {
  it('allows a merge when every condition holds on one SHA', async () => {
    const c = cfg();
    const { reviewerReports, degradation } = await reviewerInputs(c, HEAD, [review()]);
    const d = evaluateMergeGate({
      cfg: c,
      pr: pr(),
      gateRun: greenRun(),
      reviewerReports,
      degradation,
      threads: [thread()],
    });
    expect(d.blockers).toEqual([]);
    expect(d.allowed).toBe(true);
  });

  it('blocks when merge is disabled — the default posture', async () => {
    const disabled = loadConfig(`
version: 1
gates:
  - name: build
    run: x
    forbid: ["npm ERR!"]
`);
    const { reviewerReports, degradation } = await reviewerInputs(disabled, HEAD, []);
    const d = evaluateMergeGate({
      cfg: disabled,
      pr: pr(),
      gateRun: greenRun(),
      reviewerReports,
      degradation,
      threads: [],
    });
    expect(codes(d)).toContain('merge_disabled');
  });

  it('blocks a base branch that is not on the allowlist', async () => {
    const c = cfg();
    const { reviewerReports, degradation } = await reviewerInputs(c, HEAD, [review()]);
    const d = evaluateMergeGate({
      cfg: c,
      pr: pr({ baseRef: 'main' }),
      gateRun: greenRun(),
      reviewerReports,
      degradation,
      threads: [],
    });
    expect(codes(d)).toContain('base_not_allowed');
  });

  it('treats a MISSING review as a blocker, never as approval', async () => {
    const c = cfg();
    const { reviewerReports, degradation } = await reviewerInputs(c, HEAD, []); // nobody has reviewed yet
    const d = evaluateMergeGate({
      cfg: c,
      pr: pr(),
      gateRun: greenRun(),
      reviewerReports,
      degradation,
      threads: [],
    });
    expect(codes(d)).toContain('reviewer_no_verdict');
    expect(d.allowed).toBe(false);
  });

  it('blocks a review submitted against an older commit', async () => {
    const c = cfg();
    const { reviewerReports, degradation } = await reviewerInputs(c, HEAD, [review({ sha: OLD })]);
    const d = evaluateMergeGate({
      cfg: c,
      pr: pr(),
      gateRun: greenRun(),
      reviewerReports,
      degradation,
      threads: [],
    });
    expect(codes(d)).toContain('reviewer_stale');
  });

  it('uses the LATEST review, so an old approval cannot outvote new changes', async () => {
    const c = cfg();
    const { reviewerReports, degradation } = await reviewerInputs(c, HEAD, [
      review({ state: 'APPROVED', submittedAt: '2026-08-12T09:00:00Z' }),
      review({ state: 'CHANGES_REQUESTED', submittedAt: '2026-08-12T11:00:00Z' }),
    ]);
    const d = evaluateMergeGate({
      cfg: c,
      pr: pr(),
      gateRun: greenRun(),
      reviewerReports,
      degradation,
      threads: [],
    });
    expect(codes(d)).toContain('reviewer_changes_requested');
  });

  it('matches a reviewer across GitHub’s three login spellings', async () => {
    const c = cfg();
    for (const spelling of ['Copilot', 'copilot-pull-request-reviewer', 'copilot-pull-request-reviewer[bot]']) {
      const { reviewerReports, degradation } = await reviewerInputs(c, HEAD, [review({ author: spelling })]);
      const d = evaluateMergeGate({
        cfg: c,
        pr: pr(),
        gateRun: greenRun(),
        reviewerReports,
        degradation,
        threads: [],
      });
      expect(codes(d), `spelling: ${spelling}`).not.toContain('reviewer_no_verdict');
    }
  });

  it('blocks when gates ran on a different commit than the PR head', async () => {
    const c = cfg();
    const { reviewerReports, degradation } = await reviewerInputs(c, HEAD, [review()]);
    const d = evaluateMergeGate({
      cfg: c,
      pr: pr(),
      gateRun: greenRun({ sha: OLD }),
      reviewerReports,
      degradation,
      threads: [],
    });
    expect(codes(d)).toContain('sha_mismatch_gates');
  });

  it('blocks a partial gate run even though every selected gate passed', async () => {
    const c = cfg();
    const { reviewerReports, degradation } = await reviewerInputs(c, HEAD, [review()]);
    const d = evaluateMergeGate({
      cfg: c,
      pr: pr(),
      gateRun: greenRun({ green: false, partial: true }),
      reviewerReports,
      degradation,
      threads: [],
    });
    expect(codes(d)).toContain('gates_not_green');
  });

  it('blocks a void gate run (dirty worktree)', async () => {
    const c = cfg();
    const { reviewerReports, degradation } = await reviewerInputs(c, HEAD, [review()]);
    const d = evaluateMergeGate({
      cfg: c,
      pr: pr(),
      gateRun: greenRun({ green: false, invalidatedBy: 'dirty_worktree' }),
      reviewerReports,
      degradation,
      threads: [],
    });
    expect(d.blockers.find((b) => b.code === 'gates_not_green')?.message).toMatch(/dirty_worktree/);
  });

  it('blocks on unresolved threads', async () => {
    const c = cfg();
    const { reviewerReports, degradation } = await reviewerInputs(c, HEAD, [review()]);
    const d = evaluateMergeGate({
      cfg: c,
      pr: pr(),
      gateRun: greenRun(),
      reviewerReports,
      degradation,
      threads: [thread({ isResolved: true }), thread({ id: 'PRRT_2', isResolved: false })],
    });
    expect(codes(d)).toContain('threads_unresolved');
  });

  it('allows an outdated thread as long as it is resolved', async () => {
    const c = cfg();
    const { reviewerReports, degradation } = await reviewerInputs(c, HEAD, [review()]);
    const d = evaluateMergeGate({
      cfg: c,
      pr: pr(),
      gateRun: greenRun(),
      reviewerReports,
      degradation,
      threads: [thread({ isOutdated: true, isResolved: true })],
    });
    expect(d.allowed).toBe(true);
  });

  it('reports EVERY blocker at once, not just the first', async () => {
    const c = cfg();
    const { reviewerReports, degradation } = await reviewerInputs(c, HEAD, []);
    const d = evaluateMergeGate({
      cfg: c,
      pr: pr({ baseRef: 'main', isDraft: true }),
      gateRun: greenRun({ green: false, sha: OLD }),
      reviewerReports,
      degradation,
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

describe('required_reviewer_state', () => {
  /**
   * The hole this closes: GitHub review states are APPROVED,
   * CHANGES_REQUESTED and COMMENTED, and blocking only on CHANGES_REQUESTED
   * means a COMMENTED review clears the gate — whether the reviewer found
   * nothing or found ten things. Copilot files findings as COMMENTED and never
   * submits APPROVED, so "the reviewer was happy" silently meant "the reviewer
   * turned up". Caught on rloop's own PR, by a review that was itself
   * COMMENTED-with-a-real-finding.
   */
  const commented: ReviewVerdict = {
    author: 'copilot-pull-request-reviewer',
    state: 'COMMENTED',
    sha: HEAD,
    submittedAt: '2026-08-14T10:00:00Z',
  };
  const approved: ReviewVerdict = { ...commented, state: 'APPROVED' };

  /** Same shape as `cfg()`, but demanding a real APPROVED verdict. */
  const strictCfg = (): RloopConfig =>
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
  required_reviewer_state: approved
`);

  it('under `approved`, a COMMENTED review blocks', async () => {
    const c = strictCfg();
    const { reviewerReports, degradation } = await reviewerInputs(c, HEAD, [commented]);
    const d = evaluateMergeGate({
      cfg: c,
      pr: pr(),
      gateRun: greenRun(),
      reviewerReports,
      degradation,
      threads: [],
    });
    expect(d.allowed).toBe(false);
    // A COMMENTED review under required_state: approved is "nobody has said
    // yes yet", not "somebody said no" — its own code, distinct from
    // reviewer_changes_requested.
    expect(codes(d)).toContain('reviewer_not_approved');
  });

  it('under `approved`, an APPROVED review clears it', async () => {
    const c = strictCfg();
    const { reviewerReports, degradation } = await reviewerInputs(c, HEAD, [approved]);
    const d = evaluateMergeGate({
      cfg: c,
      pr: pr(),
      gateRun: greenRun(),
      reviewerReports,
      degradation,
      threads: [],
    });
    expect(d.allowed).toBe(true);
  });

  it('under `any_verdict`, a COMMENTED review clears it — the documented trade', async () => {
    const c = cfg();
    const { reviewerReports, degradation } = await reviewerInputs(c, HEAD, [commented]);
    const d = evaluateMergeGate({
      cfg: c,
      pr: pr(),
      gateRun: greenRun(),
      reviewerReports,
      degradation,
      threads: [],
    });
    expect(d.allowed).toBe(true);
  });

  it('CHANGES_REQUESTED still blocks under `any_verdict`, and reports that reason', async () => {
    const c = cfg();
    const { reviewerReports, degradation } = await reviewerInputs(c, HEAD, [
      { ...commented, state: 'CHANGES_REQUESTED' },
    ]);
    const d = evaluateMergeGate({
      cfg: c,
      pr: pr(),
      gateRun: greenRun(),
      reviewerReports,
      degradation,
      threads: [],
    });
    const blockerCodes = d.blockers.map((b) => b.code);
    expect(blockerCodes).toContain('reviewer_changes_requested');
    // Not double-reported as "not approved" — one cause, one blocker.
    expect(blockerCodes).not.toContain('reviewer_not_approved');
    expect(blockerCodes).not.toContain('reviewer_findings_open');
  });

  it('is REQUIRED when merge is enabled with reviewers — no silent default', () => {
    expect(() =>
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
`),
    ).toThrow(/required_reviewer_state/);
  });
});

const report = (over: Partial<ReviewerReport> = {}): ReviewerReport => ({
  name: 'copilot',
  kind: 'forge',
  status: 'clean',
  sha: HEAD,
  findings: [],
  detail: null,
  findingsReason: null,
  ...over,
});

// Named `blockerCodes`, not `codes` — this file already has a top-level
// `codes` helper with a different signature (it takes an already-evaluated
// decision, not a partial input).
const blockerCodes = (over: Partial<Parameters<typeof evaluateMergeGate>[0]> = {}): BlockerCode[] =>
  evaluateMergeGate({
    cfg: cfg(),
    pr: pr(),
    gateRun: greenRun(),
    reviewerReports: [report()],
    degradation: null,
    threads: [],
    ...over,
  }).blockers.map((b) => b.code);

describe('reviewer reports', () => {
  it('allows a merge when every reviewer is clean', () => {
    expect(blockerCodes()).toEqual([]);
  });

  it('blocks on degradation, whatever else is green', () => {
    expect(
      blockerCodes({
        degradation: { reason: 'not_configured', provider: null, message: 'none configured' },
        reviewerReports: [],
      }),
    ).toContain('reviewer_degraded');
  });

  it('blocks an unavailable reviewer with its own code', () => {
    expect(blockerCodes({ reviewerReports: [report({ status: 'unavailable', detail: 'ENOENT' })] })).toContain(
      'reviewer_unavailable',
    );
  });

  it('blocks a malformed reviewer separately from an unavailable one', () => {
    expect(blockerCodes({ reviewerReports: [report({ status: 'malformed', detail: 'bad json' })] })).toContain(
      'reviewer_malformed',
    );
  });

  it('blocks open findings', () => {
    expect(blockerCodes({ reviewerReports: [report({ status: 'findings' })] })).toContain('reviewer_findings_open');
  });

  it('blocks a CHANGES_REQUESTED forge reviewer with its own code', () => {
    const c = blockerCodes({
      reviewerReports: [report({ status: 'findings', findingsReason: 'changes_requested' })],
    });
    expect(c).toContain('reviewer_changes_requested');
    expect(c).not.toContain('reviewer_findings_open');
  });

  it('blocks a not-yet-approved forge reviewer with its own code, distinct from a rejection', () => {
    const c = blockerCodes({
      reviewerReports: [report({ status: 'findings', findingsReason: 'not_approved' })],
    });
    expect(c).toContain('reviewer_not_approved');
    expect(c).not.toContain('reviewer_changes_requested');
    expect(c).not.toContain('reviewer_findings_open');
  });

  it('blocks a command reviewer with provider-reported findings under the generic code', () => {
    // Neither "changes requested" nor "not approved" makes sense for a local
    // command provider — those are forge review-state concepts. Its findings
    // are its own, so it falls back to the generic code.
    const c = blockerCodes({
      reviewerReports: [
        report({ kind: 'command', status: 'findings', findingsReason: 'provider_findings' }),
      ],
    });
    expect(c).toContain('reviewer_findings_open');
    expect(c).not.toContain('reviewer_changes_requested');
    expect(c).not.toContain('reviewer_not_approved');
  });

  it('blocks a stale reviewer', () => {
    expect(blockerCodes({ reviewerReports: [report({ status: 'stale', sha: OLD })] })).toContain('reviewer_stale');
  });

  it('blocks an absent reviewer', () => {
    expect(blockerCodes({ reviewerReports: [report({ status: 'absent', sha: null })] })).toContain(
      'reviewer_no_verdict',
    );
  });

  it('reports EVERY blocker, not just the first', () => {
    const c = blockerCodes({
      pr: pr({ isDraft: true }),
      reviewerReports: [report({ status: 'unavailable' })],
    });
    expect(c).toContain('pr_draft');
    expect(c).toContain('reviewer_unavailable');
  });

  it('blocks a merge with zero reviewers configured — the previously-silent hole', () => {
    // Before this task, `merge.enabled: true` with an empty
    // required_reviewers list added no blocker at all: evaluateMergeGate
    // looped over cfg.merge.required_reviewers, and an empty list adds
    // nothing. collectWarnings() in src/config.ts already told operators
    // that rloop "will not merge on gates alone" in this situation — this
    // test is what makes that claim true.
    const noReviewers = loadConfig(`
version: 1
gates:
  - name: build
    run: npm run build
    require: ["^Route \\\\("]
merge:
  enabled: true
  allowed_base_branches: [staging]
`);
    expect(noReviewers.reviewers).toEqual([]);
    const degradation = degradationOf([], noReviewers);
    const d = evaluateMergeGate({
      cfg: noReviewers,
      pr: pr(),
      gateRun: greenRun(),
      reviewerReports: [],
      degradation,
      threads: [],
    });
    expect(d.blockers.map((b) => b.code)).toContain('reviewer_degraded');
    expect(d.allowed).toBe(false);
  });
});
