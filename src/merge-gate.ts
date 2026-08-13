import type { RloopConfig } from './config.js';
import { matchesReviewer, type PullRequest, type ReviewThread, type ReviewVerdict } from './forge/types.js';
import type { GateRunResult } from './types.js';

export type BlockerCode =
  | 'merge_disabled'
  | 'base_not_allowed'
  | 'pr_not_open'
  | 'pr_draft'
  | 'gates_not_green'
  | 'sha_mismatch_gates'
  | 'reviewer_no_verdict'
  | 'reviewer_stale'
  | 'reviewer_changes_requested'
  | 'threads_unresolved';

export interface Blocker {
  code: BlockerCode;
  message: string;
}

export interface MergeGateInput {
  cfg: RloopConfig;
  pr: PullRequest;
  gateRun: GateRunResult;
  reviews: ReviewVerdict[];
  threads: ReviewThread[];
}

export interface MergeDecision {
  allowed: boolean;
  /** Empty exactly when `allowed` is true. */
  blockers: Blocker[];
  /** The one SHA everything had to agree on. */
  sha: string;
}

const short = (sha: string) => sha.slice(0, 7);

/**
 * Decide whether a PR may be merged. Pure — no I/O, no clock, no network.
 *
 * Every condition is evaluated and reported, rather than short-circuiting on
 * the first failure. An operator fixing three blockers wants to see all three,
 * not discover them one re-run at a time.
 *
 * The design rule throughout: a MISSING signal is a blocker, never a pass.
 * No review yet is not approval. No gate result is not green.
 */
export function evaluateMergeGate(input: MergeGateInput): MergeDecision {
  const { cfg, pr, gateRun, reviews, threads } = input;
  const blockers: Blocker[] = [];

  if (!cfg.merge.enabled) {
    blockers.push({
      code: 'merge_disabled',
      message: 'merge.enabled is false — dry run. Nothing will be merged.',
    });
  }

  if (!cfg.merge.allowed_base_branches.includes(pr.baseRef)) {
    blockers.push({
      code: 'base_not_allowed',
      message:
        `PR #${pr.number} targets "${pr.baseRef}", which is not in ` +
        `merge.allowed_base_branches [${cfg.merge.allowed_base_branches.join(', ')}]. ` +
        `Refusing — a branch absent from the allowlist is protected by default.`,
    });
  }

  if (pr.state !== 'OPEN') {
    blockers.push({ code: 'pr_not_open', message: `PR #${pr.number} is ${pr.state}, not OPEN.` });
  }

  if (pr.isDraft) {
    blockers.push({ code: 'pr_draft', message: `PR #${pr.number} is a draft.` });
  }

  if (!gateRun.green) {
    const why = gateRun.invalidatedBy
      ? `run was void (${gateRun.invalidatedBy})`
      : gateRun.partial
        ? 'run was partial (--only), which is never a merge verdict'
        : 'one or more gates did not pass';
    blockers.push({ code: 'gates_not_green', message: `Local gates are not green: ${why}.` });
  }

  // Three-way SHA agreement, part one: gates vs PR head.
  if (gateRun.sha !== pr.headSha) {
    blockers.push({
      code: 'sha_mismatch_gates',
      message:
        `Gates ran on ${short(gateRun.sha)} but PR head is ${short(pr.headSha)}. ` +
        `The verified code is not the code that would merge.`,
    });
  }

  // Part two: each required reviewer vs PR head.
  for (const required of cfg.merge.required_reviewers) {
    const theirs = reviews.filter((r) => matchesReviewer(required, r.author));

    if (theirs.length === 0) {
      blockers.push({
        code: 'reviewer_no_verdict',
        message: `No review from "${required}" at all. Absence of a verdict is NOT approval.`,
      });
      continue;
    }

    // Latest by submission time; fall back to array order when a review has no
    // timestamp (pending reviews do not).
    const latest = theirs.reduce((a, b) =>
      (b.submittedAt ?? '') >= (a.submittedAt ?? '') ? b : a,
    );

    if (latest.sha !== pr.headSha) {
      blockers.push({
        code: 'reviewer_stale',
        message:
          `Latest review from "${required}" is against ${short(latest.sha)}, but PR head is ` +
          `${short(pr.headSha)}. Stale — re-request review on the current commit.`,
      });
      continue;
    }

    if (latest.state === 'CHANGES_REQUESTED') {
      blockers.push({
        code: 'reviewer_changes_requested',
        message: `"${required}" requested changes on ${short(latest.sha)}.`,
      });
    }
  }

  if (cfg.merge.require_threads_resolved) {
    const unresolved = threads.filter((t) => !t.isResolved);
    if (unresolved.length > 0) {
      const sample = unresolved
        .slice(0, 3)
        .map((t) => `${t.path ?? '(no path)'} by ${t.firstCommentAuthor}`)
        .join('; ');
      blockers.push({
        code: 'threads_unresolved',
        message:
          `${unresolved.length} unresolved review thread(s): ${sample}` +
          (unresolved.length > 3 ? ` (+${unresolved.length - 3} more)` : ''),
      });
    }
  }

  return { allowed: blockers.length === 0, blockers, sha: pr.headSha };
}
