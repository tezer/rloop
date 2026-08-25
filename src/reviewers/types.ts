/** Matches the classification the loop prompt already uses. */
export type Severity = 'critical' | 'important' | 'minor';

/**
 * Severities that block a merge.
 *
 * `minor` is deliberately absent: the loop prompt acts "on any critical or
 * important finding" and leaves minor ones to its convergence rules. A
 * minor-only report is clean, and its findings are still reported so the agent
 * can choose to fix them.
 */
export const BLOCKING_SEVERITIES: readonly Severity[] = ['critical', 'important'];

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
}
