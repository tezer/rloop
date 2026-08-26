import { describe, expect, it } from 'vitest';

import { loadConfig, type RloopConfig } from '../src/config.js';
import { matchesReviewer, type PullRequest, type ReviewThread, type ReviewVerdict } from '../src/forge/types.js';
import { evaluateMergeGate, type BlockerCode } from '../src/merge-gate.js';
import { collectReviewerReports, degradationOf } from '../src/reviewers/collect.js';
import { assertReasonCoupling, type Finding, type ReviewerReport, type ReviewerStatus } from '../src/reviewers/types.js';
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

const finding = (over: Partial<Finding> = {}): Finding => ({
  id: null,
  severity: 'minor',
  path: 'src/a.ts',
  line: null,
  title: 'a finding',
  body: null,
  fingerprint: '00000000',
  dismissed: false,
  ...over,
});

/**
 * Builds a `ReviewerReport` for `evaluateMergeGate` tests.
 *
 * Defaults `findingsReason` (and `unavailableReason`) from `status`, so a
 * test that only cares about, say, `reviewer_findings_open` does not also
 * have to remember the findingsReason/status coupling. The result is then
 * run through `assertReasonCoupling` — the same invariant check
 * `command.ts` and `collect.ts` apply at their own construction sites — so
 * this helper is a real call site of the assertion, not just a plain object
 * literal that could drift out of sync with it unnoticed. Previously this
 * helper set `findingsReason: null` unconditionally and never ran the
 * assertion, so `report({ status: 'findings' })` silently built an
 * inconsistent report and fed it straight to evaluateMergeGate — the exact
 * gap the assertion exists to close.
 *
 * A test that deliberately WANTS an inconsistent report to reach
 * evaluateMergeGate (bypassing this helper's own check) must construct the
 * `ReviewerReport` object literal itself instead of calling this helper.
 */
const report = (over: Partial<ReviewerReport> = {}): ReviewerReport => {
  const status = over.status ?? 'clean';
  return assertReasonCoupling({
    name: 'copilot',
    kind: 'forge',
    status: 'clean',
    sha: HEAD,
    findings: [],
    detail: null,
    findingsReason: status === 'findings' ? 'provider_findings' : null,
    unavailableReason: status === 'unavailable' ? 'never_ran' : null,
    ...over,
  });
};

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

  describe('unavailable wording, per cause (I1)', () => {
    // `unavailable` collapses three causes into one status (see
    // UnavailableReason in src/reviewers/types.ts). Only the first is
    // actually true to say "could not run" — the other two describe a
    // process that DID run and even produced a document. Each case here
    // pins the wording rloop actually shows for that cause.
    const messageFor = (unavailableReason: ReviewerReport['unavailableReason'], detail: string) =>
      evaluateMergeGate({
        cfg: cfg(),
        pr: pr(),
        gateRun: greenRun(),
        reviewerReports: [report({ status: 'unavailable', unavailableReason, detail })],
        degradation: null,
        threads: [],
      }).blockers.find((b) => b.code === 'reviewer_unavailable')?.message;

    it('never_ran (spawn failure or timeout): says "could not run"', () => {
      const message = messageFor('never_ran', 'could not start: ENOENT');
      expect(message).toContain('could not run');
      expect(message).toContain('ENOENT');
    });

    it('crashed (unusable output, non-zero exit): ran but crashed, not "could not run"', () => {
      const message = messageFor('crashed', 'exited 1 without a usable document: boom');
      expect(message).not.toContain('could not run');
      expect(message).toContain('crashed');
      expect(message).toContain('exited 1 without a usable document');
    });

    it('contradicted (clean document, non-zero exit): does not claim "could not run" — it ran and produced a document', () => {
      const message = messageFor(
        'contradicted',
        'exited 1 but its document reports no blocking findings — the provider\'s own signals contradict each other',
      );
      expect(message).not.toContain('could not run');
      expect(message).toContain('contradict');
      expect(message).toContain('produced a document');
    });
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

  it('does not claim "has open findings" for a forge reviewer that requested changes — it has none, they are review threads', () => {
    const d = evaluateMergeGate({
      cfg: cfg(),
      pr: pr(),
      gateRun: greenRun(),
      reviewerReports: [
        report({
          name: 'copilot-pull-request-reviewer',
          status: 'findings',
          findingsReason: 'changes_requested',
          detail: 'changes requested',
        }),
      ],
      degradation: null,
      threads: [],
    });
    const blocker = d.blockers.find((b) => b.code === 'reviewer_changes_requested');
    expect(blocker?.message).not.toContain('has open findings');
    expect(blocker?.message).toContain('requested changes');
  });

  it('names required_state, not "has open findings", for a forge reviewer that reviewed without approving', () => {
    const d = evaluateMergeGate({
      cfg: cfg(), // desugars to a `copilot-pull-request-reviewer` entry with required_state: any_verdict
      pr: pr(),
      gateRun: greenRun(),
      reviewerReports: [
        report({
          name: 'copilot-pull-request-reviewer',
          status: 'findings',
          findingsReason: 'not_approved',
          detail: 'left a COMMENTED review, and required_state is "any_verdict"',
        }),
      ],
      degradation: null,
      threads: [],
    });
    const blocker = d.blockers.find((b) => b.code === 'reviewer_not_approved');
    expect(blocker?.message).not.toContain('has open findings');
    expect(blocker?.message).toContain('reviewed without approving');
    expect(blocker?.message).toContain('required_state: "any_verdict"');
  });

  it('keeps the "has open findings" wording for provider_findings — a command reviewer really does have findings', () => {
    const d = evaluateMergeGate({
      cfg: cfg(),
      pr: pr(),
      gateRun: greenRun(),
      reviewerReports: [
        report({
          kind: 'command',
          status: 'findings',
          findingsReason: 'provider_findings',
          findings: [finding({ severity: 'critical', title: 'Unchecked null' })],
        }),
      ],
      degradation: null,
      threads: [],
    });
    const blocker = d.blockers.find((b) => b.code === 'reviewer_findings_open');
    expect(blocker?.message).toContain('has open findings');
    expect(blocker?.message).toContain('Unchecked null');
  });

  it('blocks a stale reviewer', () => {
    expect(blockerCodes({ reviewerReports: [report({ status: 'stale', sha: OLD })] })).toContain('reviewer_stale');
  });

  it('names the command that exits a stale forge reviewer, and tells a command reviewer to re-run', () => {
    // Two properties, and the second is why the first is worded as it is.
    //
    // The advice must branch on kind: "re-request review" is meaningless for a
    // `kind: command` reviewer — there is no review to request, only a re-run.
    //
    // And for a forge reviewer it must name a command that EXISTS. It used to
    // say "re-request review on the current commit", which sent the reader at
    // an API that answers 200 and adds nobody, with no rloop command to run.
    // Asserting the runnable form pins the message to a real escape.
    const forgeStale = evaluateMergeGate({
      cfg: cfg(),
      pr: pr(),
      gateRun: greenRun(),
      reviewerReports: [report({ kind: 'forge', status: 'stale', sha: OLD })],
      degradation: null,
      threads: [],
    }).blockers.find((b) => b.code === 'reviewer_stale');
    // The PR number is interpolated, so this is copy-pasteable rather than a
    // shape the reader still has to fill in.
    expect(forgeStale?.message).toContain(`rloop pr request-review ${pr().number}`);

    const commandStale = evaluateMergeGate({
      cfg: cfg(),
      pr: pr(),
      gateRun: greenRun(),
      reviewerReports: [report({ kind: 'command', status: 'stale', sha: OLD })],
      degradation: null,
      threads: [],
    }).blockers.find((b) => b.code === 'reviewer_stale');
    expect(commandStale?.message).not.toContain('request-review');
    expect(commandStale?.message).toContain('re-run');
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

  it('samples only blocking findings, not minors that never blocked', () => {
    // Four minors and one important: a sample drawn from "not dismissed"
    // alone names three minors and buries the only real blocker under
    // "(+2 more)". The sample must be drawn from findings where isBlocking().
    const minors = ['first minor', 'second minor', 'third minor', 'fourth minor'].map((title, i) =>
      finding({ severity: 'minor', title, fingerprint: `min0000${i}` }),
    );
    const important = finding({
      severity: 'important',
      title: 'the actual blocker',
      fingerprint: 'aabbccdd',
    });
    const d = evaluateMergeGate({
      cfg: cfg(),
      pr: pr(),
      gateRun: greenRun(),
      reviewerReports: [
        report({
          kind: 'command',
          status: 'findings',
          findingsReason: 'provider_findings',
          findings: [...minors, important],
        }),
      ],
      degradation: null,
      threads: [],
    });
    const blocker = d.blockers.find((b) => b.code === 'reviewer_findings_open');
    expect(blocker?.message).toContain('the actual blocker');
    for (const m of minors) {
      expect(blocker?.message).not.toContain(m.title);
    }
  });

  it('fails closed on a status the switch does not recognize', () => {
    // A seventh ReviewerStatus, arriving via a cast (or parsed JSON) rather
    // than a literal the compiler would catch. The fall-through direction
    // for something evaluateMergeGate does not understand must be "block".
    const unknown = report({ status: 'mystery-status' as unknown as ReviewerStatus });
    const d = evaluateMergeGate({
      cfg: cfg(),
      pr: pr(),
      gateRun: greenRun(),
      reviewerReports: [unknown],
      degradation: null,
      threads: [],
    });
    expect(d.allowed).toBe(false);
    expect(d.blockers.map((b) => b.code)).toContain('reviewer_degraded');
  });

  it('blocks when called directly with an empty reviewerReports array and no degradation', () => {
    // evaluateMergeGate is exported from src/index.ts. A caller that skips
    // degradationOf (or gets it wrong) and passes an empty reviewerReports
    // array must not get `allowed: true` — an empty reviewer list is a
    // missing signal exactly like a not-configured reviewer stream is.
    const d = evaluateMergeGate({
      cfg: cfg(),
      pr: pr(),
      gateRun: greenRun(),
      reviewerReports: [],
      degradation: null,
      threads: [],
    });
    expect(d.allowed).toBe(false);
    expect(d.blockers.map((b) => b.code)).toContain('reviewer_degraded');
  });

  it('the report() helper itself enforces the findingsReason/status coupling (I2)', () => {
    // This file's own `report()` helper used to default findingsReason to
    // `null` unconditionally and never call assertReasonCoupling, so
    // `report({ status: 'findings' })` (see 'blocks open findings' above)
    // silently built an inconsistent ReviewerReport and fed it straight to
    // evaluateMergeGate — bypassing the exact invariant
    // assertReasonCoupling exists to enforce. Now the helper routes
    // every report it builds through that assertion, so a deliberately
    // inconsistent override (findingsReason forced back to null on a
    // 'findings' status) throws here, at the test's own construction site,
    // instead of reaching evaluateMergeGate unchecked.
    expect(() => report({ status: 'findings', findingsReason: null })).toThrow(/findingsReason/);
  });
});
