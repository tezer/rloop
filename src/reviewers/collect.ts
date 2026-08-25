import type { RloopConfig } from '../config.js';
import { matchesReviewer, type ReviewVerdict } from '../forge/types.js';
import { runCommandReviewer } from './command.js';
import type { ReviewerReport } from './types.js';

export type DegradedReason = 'not_configured' | 'unavailable' | 'malformed';

export interface Degradation {
  reason: DegradedReason;
  /** The reviewer that failed, or null for `not_configured`. */
  provider: string | null;
  message: string;
}

const short = (sha: string) => sha.slice(0, 7);

/**
 * One report per configured reviewer, in config order.
 *
 * Sequential by design. Parallelism is an optimisation and no measurement
 * yet says it is needed; running unknown third-party commands concurrently
 * also multiplies whatever they do to the working tree.
 */
export async function collectReviewerReports(
  cfg: RloopConfig,
  opts: { repoRoot: string; headSha: string; reviews: ReviewVerdict[] },
): Promise<ReviewerReport[]> {
  const reports: ReviewerReport[] = [];

  for (const rev of cfg.reviewers) {
    if (rev.kind === 'command') {
      reports.push(await runCommandReviewer(rev, opts));
      continue;
    }
    reports.push(forgeReport(rev, opts));
  }

  return reports;
}

function forgeReport(
  rev: Extract<RloopConfig['reviewers'][number], { kind: 'forge' }>,
  opts: { headSha: string; reviews: ReviewVerdict[] },
): ReviewerReport {
  const base = { name: rev.name, kind: 'forge' as const, findings: [], findingsReason: null };
  const theirs = opts.reviews.filter((r) => matchesReviewer(rev.login, r.author));

  if (theirs.length === 0) {
    return {
      ...base,
      status: 'absent',
      sha: null,
      detail: `no review from "${rev.login}" yet. Absence of a verdict is not approval.`,
    };
  }

  const latest = theirs.reduce((a, b) => ((b.submittedAt ?? '') >= (a.submittedAt ?? '') ? b : a));

  if (latest.sha !== opts.headSha) {
    return {
      ...base,
      status: 'stale',
      sha: latest.sha,
      detail: `reviewed ${short(latest.sha)} but head is ${short(opts.headSha)}`,
    };
  }

  // `findings` stays empty: a forge reviewer's findings are review threads,
  // gated by merge.require_threads_resolved. Two mechanisms for one fact is
  // how they drift apart.
  if (latest.state === 'CHANGES_REQUESTED') {
    return {
      ...base,
      status: 'findings',
      sha: latest.sha,
      detail: 'changes requested',
      findingsReason: 'changes_requested',
    };
  }
  if (rev.required_state === 'approved' && latest.state !== 'APPROVED') {
    return {
      ...base,
      status: 'findings',
      sha: latest.sha,
      detail: `left a ${latest.state} review, and required_state is "approved"`,
      findingsReason: 'not_approved',
    };
  }
  return { ...base, status: 'clean', sha: latest.sha, detail: null };
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
