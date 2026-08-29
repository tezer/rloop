import type { RloopConfig } from '../config.js';
import { matchesReviewer, type ReviewVerdict } from '../forge/types.js';
import { fetchBranch } from '../git.js';
import { runCommandReviewer } from './command.js';
import { prepareDiff, type DiffContext } from './diff.js';
import { assertReasonCoupling, type ReviewerReport } from './types.js';

export type DegradedReason = 'not_configured' | 'unavailable' | 'malformed';

export interface Degradation {
  reason: DegradedReason;
  /** The reviewer that failed, or null for `not_configured`. */
  provider: string | null;
  message: string;
}

const short = (sha: string) => sha.slice(0, 7);

/**
 * git writes multi-line failures ("fatal: 'origin' does not appear…" followed
 * by "fatal: Could not read from remote repository." and three lines of
 * advice). Only the first line diagnoses; the rest would push the actionable
 * part of a blocker message off the end of a terminal.
 */
const firstLine = (s: string) => s.trim().split('\n').find((l) => l.trim().length > 0) ?? s.trim();

/**
 * One report per configured reviewer, in config order.
 *
 * Sequential by design. Parallelism is an optimisation and no measurement
 * yet says it is needed; running unknown third-party commands concurrently
 * also multiplies whatever they do to the working tree.
 *
 * `baseBranch` is what turns on the diff rloop hands to `kind: command`
 * reviewers. It is optional because `evaluateMergeGate` and this function are
 * both exported and can be driven without a PR in hand; when it is absent no
 * `RLOOP_DIFF_FILE` is set and a provider that needs one is on its own. Every
 * in-tree caller (`prStatus`) supplies it.
 */
export async function collectReviewerReports(
  cfg: RloopConfig,
  opts: {
    repoRoot: string;
    headSha: string;
    reviews: ReviewVerdict[];
    baseBranch?: string;
  },
): Promise<ReviewerReport[]> {
  const reports: ReviewerReport[] = [];
  const anyNeedsDiff =
    opts.baseBranch !== undefined &&
    cfg.reviewers.some((r) => r.kind === 'command' && r.needs_diff);

  // ONE fetch for the whole invocation, and its failure is FATAL to every
  // command reviewer rather than something they run through.
  //
  // The diff itself is still per-reviewer, because `diff_max_bytes` is: a
  // single shared file would silently hand every reviewer the smallest cap
  // any of them configured.
  let fetchError: string | null = null;
  if (anyNeedsDiff) {
    try {
      await fetchBranch('origin', opts.baseBranch!, opts.repoRoot);
    } catch (err) {
      fetchError = `could not fetch origin/${opts.baseBranch}: ${firstLine((err as Error).message)}`;
    }
  }

  for (const rev of cfg.reviewers) {
    if (rev.kind !== 'command') {
      reports.push(forgeReport(rev, opts));
      continue;
    }

    // Not opted in, or no PR context to derive a base from: run it exactly as
    // 0.3.x did, with only RLOOP_HEAD_SHA set.
    if (!rev.needs_diff || !opts.baseBranch) {
      reports.push(await runCommandReviewer(rev, opts));
      continue;
    }
    if (fetchError) {
      reports.push(await runCommandReviewer(rev, { ...opts, diffError: fetchError }));
      continue;
    }

    let diff: DiffContext | null = null;
    let diffError: string | null = null;
    try {
      diff = await prepareDiff({
        repoRoot: opts.repoRoot,
        baseBranch: opts.baseBranch,
        maxBytes: rev.diff_max_bytes ?? null,
      });
    } catch (err) {
      diffError = (err as Error).message;
    }
    try {
      reports.push(await runCommandReviewer(rev, { ...opts, diff, diffError }));
    } finally {
      diff?.cleanup();
    }
  }

  return reports;
}

function forgeReport(
  rev: Extract<RloopConfig['reviewers'][number], { kind: 'forge' }>,
  opts: { headSha: string; reviews: ReviewVerdict[] },
): ReviewerReport {
  const base = {
    name: rev.name,
    kind: 'forge' as const,
    findings: [],
    findingsReason: null,
    // A forge reviewer's report never reaches `status: 'unavailable'` — that
    // status is a `kind: command` outcome (see command.ts). Always null here.
    unavailableReason: null,
  };
  const theirs = opts.reviews.filter((r) => matchesReviewer(rev.login, r.author));

  if (theirs.length === 0) {
    return assertReasonCoupling({
      ...base,
      status: 'absent',
      sha: null,
      detail: `no review from "${rev.login}" yet. Absence of a verdict is not approval.`,
    });
  }

  const latest = theirs.reduce((a, b) => ((b.submittedAt ?? '') >= (a.submittedAt ?? '') ? b : a));

  if (latest.sha !== opts.headSha) {
    return assertReasonCoupling({
      ...base,
      status: 'stale',
      sha: latest.sha,
      detail: `reviewed ${short(latest.sha)} but head is ${short(opts.headSha)}`,
    });
  }

  // `findings` stays empty: a forge reviewer's findings are review threads,
  // gated by merge.require_threads_resolved. Two mechanisms for one fact is
  // how they drift apart.
  if (latest.state === 'CHANGES_REQUESTED') {
    return assertReasonCoupling({
      ...base,
      status: 'findings',
      sha: latest.sha,
      detail: 'changes requested',
      findingsReason: 'changes_requested',
    });
  }
  if (rev.required_state === 'approved' && latest.state !== 'APPROVED') {
    return assertReasonCoupling({
      ...base,
      status: 'findings',
      sha: latest.sha,
      detail: `left a ${latest.state} review, and required_state is "approved"`,
      findingsReason: 'not_approved',
    });
  }
  return assertReasonCoupling({ ...base, status: 'clean', sha: latest.sha, detail: null });
}

/**
 * Whether the external review stream is degraded, and why.
 *
 * `absent` is NOT degradation: the reviewer is configured and has simply not
 * answered yet, which the merge gate already blocks on by its own code.
 * Degradation means rloop could not obtain a stream at all.
 */
export function degradationOf(
  reports: ReviewerReport[],
  cfg: RloopConfig,
): Degradation | null {
  if (cfg.reviewers.length === 0) {
    return {
      reason: 'not_configured',
      provider: null,
      message:
        'No reviewers configured. Gates ran, but there is no external review stream — ' +
        'rloop will not merge on gates alone.',
    };
  }

  const broken = reports.find((r) => r.status === 'unavailable' || r.status === 'malformed');
  if (broken) {
    return {
      reason: broken.status as DegradedReason,
      provider: broken.name,
      message: `Reviewer "${broken.name}" is ${broken.status}: ${broken.detail ?? 'no detail'}`,
    };
  }

  return null;
}
