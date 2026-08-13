/**
 * Result types for the gate engine.
 *
 * Every result carries EVIDENCE, not just a boolean. A caller that only
 * learns "red" has to retry blindly; a caller that learns *which pattern
 * matched on which line* can fix the cause.
 */

/** A single pattern hit inside a captured log. */
export interface MarkerMatch {
  /** The configured pattern source, verbatim, so callers can map back to config. */
  pattern: string;
  /** 1-indexed line number within the captured log. */
  line: number;
  /** The matching line, trimmed and truncated to `MAX_EVIDENCE_CHARS`. */
  text: string;
}

/** Outcome of matching one gate's `require`/`forbid` patterns against a log. */
export interface EvidenceResult {
  /** True when every `require` pattern matched and no `forbid` pattern did. */
  satisfied: boolean;
  requiredMatched: MarkerMatch[];
  /** `require` patterns with zero matches — the "it never actually ran" signal. */
  requiredMissing: string[];
  forbiddenMatched: MarkerMatch[];
}

export type GateStatus =
  /** Ran, and the evidence proves success. */
  | 'pass'
  /** Ran, and the evidence proves failure (or fails to prove success). */
  | 'fail'
  /** Deliberately not run — `when_paths` did not match the diff. */
  | 'skipped'
  /**
   * Could not be run to a conclusion: timeout, spawn failure, killed.
   * Distinct from `fail` on purpose — an unrunnable gate is an operator
   * problem to surface, never something to quietly treat as skipped.
   */
  | 'error';

export interface GateResult {
  name: string;
  status: GateStatus;
  /** Short machine-readable cause. `null` when the gate passed. */
  reason:
    | null
    | 'forbidden_match'
    | 'required_missing'
    | 'exit_code'
    | 'timeout'
    | 'spawn_failed'
    | 'paths_unmatched';
  /** Human-readable one-liner, safe to surface directly. */
  summary: string;
  /** Process exit code, or null when the gate never produced one. */
  exitCode: number | null;
  durationMs: number;
  /** Absolute path to the captured combined stdout+stderr log. */
  logPath: string | null;
  /** Null for `skipped`/`spawn_failed` gates. */
  evidence: EvidenceResult | null;
  /**
   * True when this gate has no `require` patterns, so "pass" rests entirely on
   * the absence of failure strings. Surfaced in the report because it is the
   * exact shape that produces a false green.
   */
  negativeEvidenceOnly: boolean;
}

export interface GateRunResult {
  /**
   * The MERGE verdict. True only when every configured gate was considered,
   * every non-skipped one passed, and the working tree was clean and unchanged
   * for the whole run. Always false for a `partial` run.
   */
  green: boolean;
  /**
   * True when only a subset of gates was selected. A partial run is a
   * development aid — it can be useful and still never authorise a merge.
   */
  partial: boolean;
  /** HEAD at the moment the run started. The SHA a verdict is bound to. */
  sha: string;
  /**
   * Populated when the run cannot be trusted regardless of gate outcomes:
   * a dirty worktree, or HEAD moving mid-run. Forces `green: false`.
   */
  invalidatedBy: null | 'dirty_worktree' | 'head_moved';
  gates: GateResult[];
  durationMs: number;
  /** Directory holding every captured gate log. */
  logDir: string;
}
