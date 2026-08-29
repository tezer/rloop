import type { RloopConfig } from './config.js';
import type { PullRequest, ReviewThread } from './forge/types.js';
import type { Degradation } from './reviewers/collect.js';
import { isBlocking } from './reviewers/types.js';
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
 * What to tell an operator when a review request does not land.
 *
 * Worth spelling out, because "re-request review" on its own sends the reader
 * at an API that can answer 200 and do nothing. Observed against GitHub
 * Copilot, on one repository, across three occasions spanning five days:
 *
 *   - 2026-08-25 — three successful requests on PR #4, each followed by a
 *     review. The `review_requested` events are in the timeline.
 *   - 2026-08-26 — four attempts on PR #5 (REST with the bare login, REST with
 *     the `[bot]` suffix, REST as `Copilot`, and the GraphQL `requestReviews`
 *     mutation with the bot's node id and `union: true`). Every one returned
 *     success. NONE produced a timeline event, a pending request, or a review
 *     within five minutes.
 *   - 2026-08-29 — the same on PR #6, three days later, on a fresh branch with
 *     no prior review of any kind. Recorded because on 2026-08-26 waiting it
 *     out as an outage was the reasonable read, and this says it is not one.
 *
 * Same repo, same account, same calls. So the cause is not a spelling or an
 * endpoint choice, and this deliberately does not name one — a first draft of
 * this string asserted "a reviewer that has already reviewed may refuse to
 * review again", which PR #5 falsifies: it had no review at all.
 *
 * What is known is the observable, and it is enough to act on: the request did
 * not land, and repeating it is not a plan. The moves left are the operator's.
 * rloop will not merge past this by itself, and should not.
 *
 * Kept next to the blocker that fires so the two cannot drift apart.
 */
export const STUCK_REVIEWER_ADVICE =
  'the request did not land — the API reported success and added nobody. Retrying will not ' +
  'change that. Check the reviewer is still installed and entitled on this repository; if it ' +
  'is, dismiss any stale review so it stops being the latest verdict, or decide on the ' +
  'evidence you have. rloop will not merge past this for you.';

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
    const why = gateRun.invalidatedBy === 'gates_skipped'
      ? 'gates were skipped, so there is no gate evidence at all'
      : gateRun.invalidatedBy
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
  } else if (input.reviewerReports.length === 0) {
    // Defends this function's own public contract, independent of any
    // caller. `degradationOf` normally catches "no reviewers configured" and
    // sets `degradation`, but `evaluateMergeGate` is exported from
    // src/index.ts and can be called directly with an empty reviewerReports
    // array and no degradation computed at all. An empty reviewer list is a
    // missing signal exactly like `degradationOf` says it is — it must block
    // here too, not just when the one caller that remembers to call
    // `degradationOf` first happens to be the one invoking this.
    blockers.push({
      code: 'reviewer_degraded',
      message:
        'No reviewer reports were supplied and no degradation was reported: there is no ' +
        'external review stream. A missing signal is a blocker, never a pass.',
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
      case 'stale': {
        // The remedy differs by kind: a forge review can be re-requested; a
        // command reviewer has no review to request, only a re-run. Branch
        // it, as the README's troubleshooting section already does.
        const advice =
          r.kind === 'forge'
            ? `run \`rloop pr request-review ${pr.number}\`. If it reports the request did not ` +
              'land, this reviewer will not review again and the way out is an operator ' +
              'decision, not a retry'
            : 're-run the reviewer against the current commit';
        blockers.push({
          code: 'reviewer_stale',
          message:
            `Latest review from "${r.name}" is against ${short(r.sha ?? '')}, but PR head is ` +
            `${short(pr.headSha)}. Stale — ${advice}.`,
        });
        break;
      }
      case 'unavailable': {
        // `unavailable` collapses three distinct causes (see UnavailableReason
        // in reviewers/types.ts). "Could not run" is only true for the first —
        // the other two describe a process that DID run. Only `contradicted`
        // also produced a usable document; `crashed` is defined by output that
        // could NOT be used, so do not claim a document for it. Asserting
        // "could not run" for either is self-contradictory when `detail` goes
        // on to describe an exit code.
        //
        // NOT exhaustive-checked: a new UnavailableReason silently lands on
        // the `could not run` fallback. See the note on the type.
        const lead =
          r.unavailableReason === 'crashed'
            ? `Reviewer "${r.name}" ran but crashed before producing a usable review`
            : r.unavailableReason === 'contradicted'
              ? `Reviewer "${r.name}" ran and produced a document, but its own signals contradict each other`
              : `Reviewer "${r.name}" could not run`;
        blockers.push({
          code: 'reviewer_unavailable',
          message: `${lead}: ${r.detail ?? 'no detail'}`,
        });
        break;
      }
      case 'malformed':
        blockers.push({
          code: 'reviewer_malformed',
          message:
            `Reviewer "${r.name}" ran but its output could not be used: ${r.detail ?? 'no detail'}. ` +
            `A reviewer you broke is a different problem from one you never had — fix the wrapper.`,
        });
        break;
      case 'findings': {
        // Sample only the findings that actually block. `open` (not dismissed)
        // is not the same set as "blocking" — a report can carry minor
        // findings alongside the one that matters, and a sample drawn from
        // `open` can bury the actual blocker under "(+N more)" while naming
        // only the minors. It also steers the operator toward dismissing
        // findings that were never blocking in the first place, which grows
        // the dismiss list src/reviewers/command.ts warns can pre-suppress
        // real findings.
        const blocking = r.findings.filter((f) => !f.dismissed && isBlocking(f.severity));
        const sample = blocking.slice(0, 3).map((f) => `${f.fingerprint} ${f.title}`).join('; ');
        const findingsList =
          (sample ? `: ${sample}` : '') +
          (blocking.length > 3 ? ` (+${blocking.length - 3} more)` : '');
        const detailSuffix = r.detail ? ` — ${r.detail}` : '';

        // `status: findings` alone cannot tell an operator what to DO: a forge
        // reviewer that requested changes and one that merely commented under
        // required_state: approved both land here, but one needs the findings
        // fixed and the other needs an approval nobody has to actually
        // disagree to withhold. findingsReason carries that distinction back
        // out as its own code, each naming the action that clears it.
        //
        // The wording must branch on it too: forge reviewers ALWAYS carry
        // `findings: []` — their findings live in review threads, not this
        // array — so "has open findings" is simply false for them. Only the
        // `provider_findings` case (a `kind: command` reviewer) actually has
        // findings to list.
        if (r.findingsReason === 'changes_requested') {
          blockers.push({
            code: 'reviewer_changes_requested',
            message:
              `"${r.name}" requested changes${detailSuffix}. Address them, push, then run ` +
              `\`rloop pr request-review ${pr.number}\`.`,
          });
        } else if (r.findingsReason === 'not_approved') {
          const reviewerCfg = cfg.reviewers.find((rv) => rv.name === r.name);
          const requiredState = reviewerCfg?.kind === 'forge' ? reviewerCfg.required_state : null;
          blockers.push({
            code: 'reviewer_not_approved',
            message:
              `"${r.name}" reviewed without approving` +
              (requiredState ? ` (required_state: "${requiredState}")` : '') +
              `${detailSuffix}. Obtain an APPROVED review before merging.`,
          });
        } else {
          blockers.push({
            code: 'reviewer_findings_open',
            message:
              `"${r.name}" has open findings${findingsList}${detailSuffix}. Resolve or dismiss ` +
              `the findings before merging.`,
          });
        }
        break;
      }
      default: {
        // Fails closed, on two levels. First, at compile time: if a seventh
        // ReviewerStatus is ever added and this switch is not updated for it,
        // `r.status` here is no longer assignable to `never` and the build
        // breaks — the fall-through direction for an unhandled status must be
        // "block", never "permit" by omission, for a tool whose entire job is
        // refusing unsafe merges. Second, at runtime: the type system's
        // guarantee doesn't survive a cast (`as unknown as ReviewerStatus`) or
        // a value arriving from parsed JSON, so an unrecognized status still
        // has to produce a blocker rather than silently falling out of the
        // switch with nothing pushed. rloop not understanding its own report
        // IS a degraded review signal.
        const _exhaustive: never = r.status;
        blockers.push({
          code: 'reviewer_degraded',
          message:
            `Reviewer "${r.name}" reported an unrecognized status (${String(_exhaustive)}). ` +
            `rloop cannot evaluate this report, which is itself a degraded review signal.`,
        });
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
