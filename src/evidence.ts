import type { EvidenceResult, MarkerMatch } from './types.js';

/** Matched lines are truncated to this length before they enter a result. */
export const MAX_EVIDENCE_CHARS = 240;

/**
 * Patterns are matched PER LINE, never against the whole log as one string.
 *
 * This is what makes `^Route \(` mean "a line starting with Route (" — the
 * same thing it means to `grep -E`, which is where these patterns come from.
 * Matching against the joined log without the `m` flag would silently anchor
 * `^` to the start of the file and quietly stop matching anything.
 */
function compile(pattern: string): RegExp {
  try {
    return new RegExp(pattern);
  } catch (err) {
    throw new Error(
      `Invalid regex in gate config: ${JSON.stringify(pattern)} — ${(err as Error).message}`,
    );
  }
}

function truncate(line: string): string {
  const trimmed = line.trim();
  return trimmed.length > MAX_EVIDENCE_CHARS
    ? `${trimmed.slice(0, MAX_EVIDENCE_CHARS)}…`
    : trimmed;
}

/**
 * Evaluate one gate's markers against its captured log.
 *
 * Semantics:
 *   - `require`: EVERY pattern must match at least one line (AND).
 *   - `forbid`:  NO pattern may match any line.
 *
 * An empty `require` list is vacuously satisfied. That is a legitimate
 * configuration for tools that print nothing on success (`tsc -b`), but the
 * caller is expected to flag it — see `GateResult.negativeEvidenceOnly`.
 */
export function evaluateEvidence(
  log: string,
  require: readonly string[],
  forbid: readonly string[],
): EvidenceResult {
  const lines = log.split(/\r?\n/);

  const requiredRegexes = require.map((p) => [p, compile(p)] as const);
  const forbiddenRegexes = forbid.map((p) => [p, compile(p)] as const);

  const requiredMatched: MarkerMatch[] = [];
  const forbiddenMatched: MarkerMatch[] = [];
  const seenRequired = new Set<string>();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    for (const [pattern, re] of requiredRegexes) {
      // First hit per pattern is enough; later hits add noise, not information.
      if (seenRequired.has(pattern)) continue;
      if (re.test(line)) {
        seenRequired.add(pattern);
        requiredMatched.push({ pattern, line: i + 1, text: truncate(line) });
      }
    }

    for (const [pattern, re] of forbiddenRegexes) {
      if (re.test(line)) {
        forbiddenMatched.push({ pattern, line: i + 1, text: truncate(line) });
      }
    }
  }

  const requiredMissing = require.filter((p) => !seenRequired.has(p));

  return {
    satisfied: requiredMissing.length === 0 && forbiddenMatched.length === 0,
    requiredMatched,
    requiredMissing,
    forbiddenMatched,
  };
}

/** One-line human summary of why a gate landed where it did. */
export function describeEvidence(name: string, ev: EvidenceResult): string {
  if (ev.forbiddenMatched.length > 0) {
    const first = ev.forbiddenMatched[0];
    const more =
      ev.forbiddenMatched.length > 1 ? ` (+${ev.forbiddenMatched.length - 1} more)` : '';
    return `${name}: forbidden pattern ${JSON.stringify(first.pattern)} matched at line ${first.line}${more}`;
  }
  if (ev.requiredMissing.length > 0) {
    return `${name}: required pattern(s) never appeared: ${ev.requiredMissing
      .map((p) => JSON.stringify(p))
      .join(', ')}`;
  }
  return `${name}: all ${ev.requiredMatched.length} required marker(s) present, no forbidden matches`;
}
