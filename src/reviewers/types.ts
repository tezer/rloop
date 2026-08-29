/** Matches the classification the loop prompt already uses. */
export type Severity = 'critical' | 'important' | 'minor';

/**
 * Whether each severity blocks a merge.
 *
 * A total map over `Severity`, not a `readonly Severity[]` of the blocking
 * ones: a plain array fails OPEN — adding a fourth severity to the union
 * silently makes it non-blocking (absent from the list) with no compile
 * error, which is the wrong default direction for a tool whose job is
 * refusing unsafe merges. This map forces a decision at every call site that
 * adds a severity, because TypeScript rejects a `Record<Severity, boolean>`
 * that is missing a key.
 *
 * `minor` is deliberately `false`: the loop prompt acts "on any critical or
 * important finding" and leaves minor ones to its convergence rules. A
 * minor-only report is clean, and its findings are still reported so the agent
 * can choose to fix them.
 */
const BLOCKING: Record<Severity, boolean> = {
  critical: true,
  important: true,
  minor: false,
};

/** Whether a finding of this severity blocks a merge. See `BLOCKING`. */
export function isBlocking(severity: Severity): boolean {
  return BLOCKING[severity];
}

/**
 * WHY a reviewer is unhappy, when `status` is `findings`.
 *
 * `status` alone cannot carry this: a forge reviewer that requested changes
 * and one that merely commented under `required_state: approved` are both
 * "findings", but they ask the author for different things — fix the
 * findings, versus obtain an approval. Collapsing them loses the difference
 * exactly where an automated loop needs it.
 */
export type FindingsReason =
  | 'changes_requested'
  | 'not_approved'
  | 'provider_findings';

/**
 * WHY a reviewer is `unavailable`. `command.ts` collapses three distinct
 * causes into that one status — a spawn failure/timeout never even started,
 * unusable output paired with a non-zero exit crashed partway through, and a
 * parseable document reporting nothing blocking paired with a non-zero exit
 * is the provider contradicting itself. All three block a merge identically
 * (hence one status, not three), but "could not run" is only true for the
 * first: the other two describe a process that DID run. This field lets the
 * blocker message say which one happened instead of merge-gate.ts guessing
 * from `detail` text.
 *
 * ADDING A MEMBER: `merge-gate.ts`'s lead-sentence chain has no exhaustive
 * guard, so a new member silently inherits "could not run" — the exact false
 * claim this type exists to prevent. Add the case there in the same commit.
 */
export type UnavailableReason =
  | 'never_ran'
  | 'crashed'
  | 'contradicted';

export interface Finding {
  /** Provider-supplied stable id, when it has one. */
  id: string | null;
  severity: Severity;
  path: string | null;
  line: number | null;
  title: string;
  body: string | null;
  /** Computed by rloop — see `fingerprint.ts`. Never supplied by the provider. */
  fingerprint: string;
  /** True when a config `dismiss` entry matches. Reported, not counted. */
  dismissed: boolean;
}

export type ReviewerStatus =
  /** Reported; nothing blocking. */
  | 'clean'
  /** Reported; blocking findings open. */
  | 'findings'
  /** Reported against a SHA that is not the head. */
  | 'stale'
  /** Forge: no review submitted yet. */
  | 'absent'
  /** Command: could not be run to a conclusion. */
  | 'unavailable'
  /** Command: ran, and its output could not be used. Distinct from unavailable. */
  | 'malformed';

export interface ReviewerReport {
  name: string;
  kind: 'forge' | 'command';
  status: ReviewerStatus;
  sha: string | null;
  /** Always empty for `kind: forge` — their findings are review threads. */
  findings: Finding[];
  /** Why, for unavailable/malformed/stale. Null when there is nothing to say. */
  detail: string | null;
  /** Set exactly when `status` is `findings`; null otherwise. */
  findingsReason: FindingsReason | null;
  /** Set exactly when `status` is `unavailable`; null otherwise. See UnavailableReason. */
  unavailableReason: UnavailableReason | null;
}

/**
 * Enforce the two invariants the type system cannot: `findingsReason` is
 * non-null exactly when `status` is `'findings'`, and `unavailableReason` is
 * non-null exactly when `status` is `'unavailable'`. A discriminated union
 * would say this at the type level, but was deliberately not chosen here —
 * every other field (`sha`, `findings`, `detail`) is shared across statuses,
 * so a union would either duplicate them per-variant or leave the type no
 * more precise than this interface already is, for real added complexity.
 * The two call sites that construct a `ReviewerReport` (`collect.ts`'s
 * `forgeReport`, `command.ts`'s `runCommandReviewer`) each call this at
 * every return point instead, so a factory that drifts — `status: 'clean'`
 * with a stale `findingsReason` left over from a copy-pasted branch, or
 * `status: 'findings'` with none set — fails loudly at the source instead of
 * reaching `evaluateMergeGate`, which trusts both couplings without
 * rechecking them.
 *
 * Named for what it checks now, not for the one field it originally checked:
 * `unavailableReason` was added after this function (and its
 * `findingsReason`-only name) already existed, and every call site happened
 * to already set it correctly — so there was no live bug, just an assertion
 * that had quietly stopped covering everything its neighbour field promised.
 */
export function assertReasonCoupling(report: ReviewerReport): ReviewerReport {
  const hasFindingsReason = report.findingsReason !== null;
  const isFindings = report.status === 'findings';
  if (hasFindingsReason !== isFindings) {
    throw new Error(
      `reviewer "${report.name}": findingsReason (${String(report.findingsReason)}) is ` +
        `inconsistent with status (${report.status}) — findingsReason must be set exactly ` +
        `when status is "findings".`,
    );
  }

  const hasUnavailableReason = report.unavailableReason !== null;
  const isUnavailable = report.status === 'unavailable';
  if (hasUnavailableReason !== isUnavailable) {
    throw new Error(
      `reviewer "${report.name}": unavailableReason (${String(report.unavailableReason)}) is ` +
        `inconsistent with status (${report.status}) — unavailableReason must be set exactly ` +
        `when status is "unavailable".`,
    );
  }

  return report;
}
