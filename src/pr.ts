import type { RloopConfig } from './config.js';
import { GitHubForge } from './forge/github.js';
import type { Forge, PullRequest, ReviewThread, ReviewVerdict } from './forge/types.js';
import { matchesReviewer } from './forge/types.js';
import { runGates } from './gate.js';
import { changedPaths } from './git.js';
import { evaluateMergeGate, type MergeDecision } from './merge-gate.js';
import { collectReviewerReports, degradationOf, type Degradation } from './reviewers/collect.js';
import type { ReviewerReport } from './reviewers/types.js';
import type { GateRunResult } from './types.js';

export function forgeFor(cfg: RloopConfig): Forge {
  if (!cfg.forge) {
    throw new Error(
      'no `forge` block in config. PR commands need `forge: { provider: github, slug: owner/name }`.',
    );
  }
  return new GitHubForge(cfg.forge.slug);
}

export interface PrStatus {
  pr: PullRequest;
  gateRun: GateRunResult;
  reviews: ReviewVerdict[];
  threads: ReviewThread[];
  reviewerReports: ReviewerReport[];
  degradation: Degradation | null;
  decision: MergeDecision;
}

/**
 * Gather every input the merge gate needs and evaluate it. Read-only.
 *
 * Gates run against the local checkout, so the SHA comparison in the decision
 * is what catches a local tree that has drifted from the PR head — the case a
 * human eyeballing "tests passed" reliably misses.
 */
export async function prStatus(
  cfg: RloopConfig,
  opts: { repoRoot: string; prNumber: number; forge?: Forge; skipGates?: boolean },
): Promise<PrStatus> {
  const forge = opts.forge ?? forgeFor(cfg);
  const pr = await forge.getPullRequest(opts.prNumber);

  const [reviews, threads] = await Promise.all([
    forge.listReviews(opts.prNumber),
    forge.listReviewThreads(opts.prNumber),
  ]);

  let gateRun: GateRunResult;
  if (opts.skipGates) {
    // Explicitly-absent gate evidence. Modelled as a VOID run so the decision
    // blocks — "I didn't check" must never read the same as "it passed".
    //
    // `invalidatedBy` rather than `partial` alone. Both block, but the blocker
    // SENTENCE differs: merge-gate reads `partial` as "run was partial
    // (--only), which is never a merge verdict", and no `--only` was passed —
    // sending an operator to look for a flag they never used. This path is
    // newly user-facing, so it gets its own reason.
    gateRun = {
      green: false,
      partial: true,
      sha: '0'.repeat(40),
      invalidatedBy: 'gates_skipped',
      gates: [],
      durationMs: 0,
      logDir: '',
    };
  } else {
    let diff: string[] | undefined;
    try {
      diff = await changedPaths(`origin/${pr.baseRef}`, opts.repoRoot);
    } catch {
      // Unknown diff → conditional gates all run. Fail safe toward checking.
      diff = undefined;
    }
    gateRun = await runGates(cfg, { repoRoot: opts.repoRoot, changedPaths: diff });
  }

  const reviewerReports = await collectReviewerReports(cfg, {
    repoRoot: opts.repoRoot,
    headSha: pr.headSha,
    reviews,
  });
  const degradation = degradationOf(reviewerReports, cfg);

  const decision = evaluateMergeGate({
    cfg,
    pr,
    gateRun,
    reviewerReports,
    degradation,
    threads,
  });
  return { pr, gateRun, reviews, threads, reviewerReports, degradation, decision };
}

/**
 * Merge, but only after re-deriving the decision here.
 *
 * This deliberately does not accept a caller-supplied "it's fine" flag. An
 * agent driving this tool may hold a stale verdict from three tool calls ago;
 * re-checking costs two API round trips and removes that entire failure class.
 */
export async function mergeIfAllowed(
  cfg: RloopConfig,
  opts: { repoRoot: string; prNumber: number; forge?: Forge },
): Promise<{ merged: boolean; decision: MergeDecision; status: PrStatus }> {
  const forge = opts.forge ?? forgeFor(cfg);
  const status = await prStatus(cfg, { ...opts, forge });

  if (!status.decision.allowed) {
    return { merged: false, decision: status.decision, status };
  }

  await forge.merge(opts.prNumber, {
    method: cfg.merge.method,
    deleteBranch: cfg.merge.delete_branch,
  });

  return { merged: true, decision: status.decision, status };
}

/**
 * Request a reviewer and verify the request actually landed.
 *
 * An unchecked 4xx here is indistinguishable from "the reviewer is just slow"
 * ten minutes later, so the result is read back rather than assumed. A review
 * that already exists for the current head makes the request moot — the
 * reviewer beat us to it, and a landed review drains the pending list.
 */
export async function requestReviewerVerified(
  cfg: RloopConfig,
  opts: { prNumber: number; login: string; headSha: string; forge?: Forge },
): Promise<{ ok: boolean; moot: boolean; requested: string[] }> {
  const forge = opts.forge ?? forgeFor(cfg);
  const requested = await forge.requestReviewer(opts.prNumber, opts.login).catch(() => [] as string[]);

  if (requested.some((r) => matchesReviewer(opts.login, r))) {
    return { ok: true, moot: false, requested };
  }

  const reviews = await forge.listReviews(opts.prNumber);
  const landed = reviews.some(
    (r) => matchesReviewer(opts.login, r.author) && r.sha === opts.headSha,
  );
  return { ok: landed, moot: landed, requested };
}
