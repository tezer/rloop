import type { RloopConfig } from './config.js';
import type { PullRequest, ReviewThread } from './forge/types.js';
import type { Degradation } from './reviewers/collect.js';
import type { ReviewerReport } from './reviewers/types.js';
import type { GateRunResult } from './types.js';

export type BlockerCode =
  | 'merge_disabled'
  | 'base_not_allowed'
  | 'pr_not_open'
  | 'pr_draft'
  | 'gates_not_green'
  | 'sha_mismatch_gates'
  | 'reviewer_degraded'
  | 'reviewer_no_verdict'
  | 'reviewer_stale'
  | 'reviewer_unavailable'
  | 'reviewer_malformed'
  | 'reviewer_findings_open'
  | 'reviewer_changes_requested'
  | 'reviewer_not_approved'
  | 'threads_unresolved';

export interface Blocker {
  code: BlockerCode;
  message: string;
}

export interface MergeGateInput {
  cfg: RloopConfig;
  pr: PullRequest;
  gateRun: GateRunResult;
  reviewerReports: ReviewerReport[];
  degradation: Degradation | null;
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
  const { cfg, pr, gateRun, threads } = input;
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

  // Degradation blocks unconditionally. The operator chose: rloop may run
  // everything else without an external reviewer, but it may not MERGE
  // without one. A provider that is merely down is indistinguishable at
  // runtime from one deliberately absent, and merging through the second
  // silently merges through the first.
  if (input.degradation) {
    blockers.push({
      code: 'reviewer_degraded',
      message:
        `External review is degraded (${input.degradation.reason}): ` +
        `${input.degradation.message} Gates still ran; the merge does not.`,
    });
  }

  for (const r of input.reviewerReports) {
    switch (r.status) {
      case 'clean':
        break;
      case 'absent':
        blockers.push({
          code: 'reviewer_no_verdict',
          message: `No review from "${r.name}" at all. Absence of a verdict is NOT approval.`,
        });
        break;
      case 'stale':
        blockers.push({
          code: 'reviewer_stale',
          message:
            `Latest review from "${r.name}" is against ${short(r.sha ?? '')}, but PR head is ` +
            `${short(pr.headSha)}. Stale — re-request review on the current commit.`,
        });
        break;
      case 'unavailable':
        blockers.push({
          code: 'reviewer_unavailable',
          message: `Reviewer "${r.name}" could not run: ${r.detail ?? 'no detail'}`,
        });
        break;
      case 'malformed':
        blockers.push({
          code: 'reviewer_malformed',
          message:
            `Reviewer "${r.name}" ran but its output could not be used: ${r.detail ?? 'no detail'}. ` +
            `A reviewer you broke is a different problem from one you never had — fix the wrapper.`,
        });
        break;
      case 'findings': {
        const open = r.findings.filter((f) => !f.dismissed);
        const sample = open.slice(0, 3).map((f) => `${f.fingerprint} ${f.title}`).join('; ');
        const findingsSummary =
          `"${r.name}" has open findings${sample ? `: ${sample}` : ''}` +
          (open.length > 3 ? ` (+${open.length - 3} more)` : '') +
          (r.detail ? ` — ${r.detail}` : '');

        // `status: findings` alone cannot tell an operator what to DO: a forge
        // reviewer that requested changes and one that merely commented under
        // required_state: approved both land here, but one needs the findings
        // fixed and the other needs an approval nobody has to actually
        // disagree to withhold. findingsReason carries that distinction back
        // out as its own code, each naming the action that clears it.
        if (r.findingsReason === 'changes_requested') {
          blockers.push({
            code: 'reviewer_changes_requested',
            message: `${findingsSummary}. Address the requested changes and re-request review.`,
          });
        } else if (r.findingsReason === 'not_approved') {
          blockers.push({
            code: 'reviewer_not_approved',
            message: `${findingsSummary}. Obtain an APPROVED review before merging.`,
          });
        } else {
          blockers.push({
            code: 'reviewer_findings_open',
            message: `${findingsSummary}. Resolve or dismiss the findings before merging.`,
          });
        }
        break;
      }
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
