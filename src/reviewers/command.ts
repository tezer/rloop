import { parseProviderDocument } from './document.js';
import { fingerprint } from './fingerprint.js';
import { readProviderJson } from './read-json.js';
import { assertFindingsReasonCoupling, isBlocking, type Finding, type ReviewerReport } from './types.js';

export interface CommandReviewer {
  name: string;
  run: string;
  timeout_seconds: number;
  dismiss: Array<{ fingerprint: string; reason: string }>;
}

const short = (sha: string) => sha.slice(0, 7);

/**
 * Run one command reviewer and classify the outcome.
 *
 * Classification order matters and is the whole contract:
 *
 *   spawn failed / timed out                     -> unavailable  (never ran)
 *   output unusable (unparseable OR fails the
 *     document schema) AND exit != 0             -> unavailable  (crashed mid-review)
 *   output unusable (unparseable OR fails the
 *     document schema) AND exit == 0             -> malformed    (ran fine, printed junk)
 *   echoed sha != head                           -> stale
 *   blocking findings present                    -> findings     (exit code irrelevant)
 *   no blocking findings AND exit != 0            -> unavailable  (signals contradict)
 *   no blocking findings AND exit == 0            -> clean
 *
 * A non-zero exit may NEVER produce `clean` — that is the rule this table
 * exists to enforce. It splits in two directions once the document parses:
 * linters conventionally exit non-zero BECAUSE they found something, so when
 * the document also reports blocking findings, the exit code is redundant
 * and the document wins (`findings`, trusting the document over the code
 * that wraps it). But when the document reports nothing blocking despite a
 * non-zero exit, the provider is telling two different stories about the
 * same run — its exit code says it failed, its document says it is clean —
 * and neither half can be trusted over the other. That is `unavailable`, not
 * `clean`.
 *
 * Nothing here returns clean on a path where the review did not happen.
 */
export async function runCommandReviewer(
  rev: CommandReviewer,
  opts: { repoRoot: string; headSha: string },
): Promise<ReviewerReport> {
  const base = {
    name: rev.name,
    kind: 'command' as const,
    sha: null,
    findings: [],
    findingsReason: null,
    unavailableReason: null,
  };

  const run = await readProviderJson(rev.run, {
    cwd: opts.repoRoot,
    timeoutMs: rev.timeout_seconds * 1000,
    env: { RLOOP_HEAD_SHA: opts.headSha },
  });

  if (run.spawnError) {
    return assertFindingsReasonCoupling({
      ...base,
      status: 'unavailable',
      unavailableReason: 'never_ran',
      detail: `could not start: ${run.spawnError.message}`,
    });
  }
  if (run.timedOut) {
    return assertFindingsReasonCoupling({
      ...base,
      status: 'unavailable',
      unavailableReason: 'never_ran',
      detail: `timed out after ${rev.timeout_seconds}s`,
    });
  }

  const parsed = parseProviderDocument(run.stdout);
  if (!parsed.ok) {
    if (run.exitCode !== 0) {
      return assertFindingsReasonCoupling({
        ...base,
        status: 'unavailable',
        unavailableReason: 'crashed',
        detail: `exited ${run.exitCode} without a usable document: ${run.stderr.slice(0, 200)}`,
      });
    }
    return assertFindingsReasonCoupling({ ...base, status: 'malformed', detail: parsed.error });
  }

  if (parsed.doc.sha !== opts.headSha) {
    return assertFindingsReasonCoupling({
      ...base,
      status: 'stale',
      sha: parsed.doc.sha,
      detail:
        `reviewed ${short(parsed.doc.sha)} but head is ${short(opts.headSha)} — ` +
        `a cached or stale run`,
    });
  }

  const dismissed = new Set(rev.dismiss.map((d) => d.fingerprint));
  const findings: Finding[] = parsed.doc.findings.map((f) => {
    const fp = fingerprint({ id: f.id, path: f.path, title: f.title });
    return {
      id: f.id ?? null,
      severity: f.severity,
      path: f.path ?? null,
      line: f.line ?? null,
      title: f.title,
      body: f.body ?? null,
      fingerprint: fp,
      dismissed: dismissed.has(fp),
    };
  });

  const blocking = findings.filter((f) => !f.dismissed && isBlocking(f.severity));

  // A non-zero exit may never result in `clean`. Blocking findings already
  // keep this run out of `clean` regardless of the exit code (a linter
  // exiting non-zero because it found something is normal and the document
  // is trusted). But an exit code that fails while the document reports
  // nothing blocking is the provider contradicting itself — its own signals
  // disagree, so `clean` would be trusting a document a reviewer that just
  // reported failure produced. That is `unavailable`, not a pass.
  if (blocking.length === 0 && run.exitCode !== 0) {
    return assertFindingsReasonCoupling({
      ...base,
      status: 'unavailable',
      unavailableReason: 'contradicted',
      sha: parsed.doc.sha,
      findings,
      detail:
        `exited ${run.exitCode} but its document reports no blocking findings — the ` +
        `provider's own signals contradict each other: the exit code says it failed, the ` +
        `document says it is clean`,
    });
  }

  // A dismissal that matches nothing is usually a finding that was genuinely
  // fixed, so this is a warning rather than an error — erroring would punish
  // the good outcome. It is never SILENT: an accumulating dismissal list is
  // how a future real finding gets pre-suppressed by accident.
  const seen = new Set(findings.map((f) => f.fingerprint));
  const unmatched = rev.dismiss.filter((d) => !seen.has(d.fingerprint)).map((d) => d.fingerprint);
  const detail =
    unmatched.length > 0
      ? `dismissals matching nothing at head (delete them): ${unmatched.join(', ')}`
      : null;

  return assertFindingsReasonCoupling({
    ...base,
    status: blocking.length > 0 ? 'findings' : 'clean',
    sha: parsed.doc.sha,
    findings,
    detail,
    findingsReason: blocking.length > 0 ? 'provider_findings' : null,
  });
}
