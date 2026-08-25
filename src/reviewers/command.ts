import { parseProviderDocument } from './document.js';
import { fingerprint } from './fingerprint.js';
import { readProviderJson } from './read-json.js';
import { BLOCKING_SEVERITIES, type Finding, type ReviewerReport } from './types.js';

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
 *   spawn failed / timed out          -> unavailable  (never ran)
 *   unparseable AND exit != 0         -> unavailable  (crashed mid-review)
 *   unparseable AND exit == 0         -> malformed    (ran fine, printed junk)
 *   parsed but fails the schema       -> malformed
 *   echoed sha != head                -> stale
 *   blocking findings present         -> findings
 *   otherwise                         -> clean
 *
 * Nothing here returns clean on a path where the review did not happen.
 */
export async function runCommandReviewer(
  rev: CommandReviewer,
  opts: { repoRoot: string; headSha: string },
): Promise<ReviewerReport> {
  const base = { name: rev.name, kind: 'command' as const, sha: null, findings: [], findingsReason: null };

  const run = await readProviderJson(rev.run, {
    cwd: opts.repoRoot,
    timeoutMs: rev.timeout_seconds * 1000,
    env: { RLOOP_HEAD_SHA: opts.headSha },
  });

  if (run.spawnError) {
    return { ...base, status: 'unavailable', detail: `could not start: ${run.spawnError.message}` };
  }
  if (run.timedOut) {
    return { ...base, status: 'unavailable', detail: `timed out after ${rev.timeout_seconds}s` };
  }

  const parsed = parseProviderDocument(run.stdout);
  if (!parsed.ok) {
    if (run.exitCode !== 0) {
      return {
        ...base,
        status: 'unavailable',
        detail: `exited ${run.exitCode} without a usable document: ${run.stderr.slice(0, 200)}`,
      };
    }
    return { ...base, status: 'malformed', detail: parsed.error };
  }

  if (parsed.doc.sha !== opts.headSha) {
    return {
      ...base,
      status: 'stale',
      sha: parsed.doc.sha,
      detail:
        `reviewed ${short(parsed.doc.sha)} but head is ${short(opts.headSha)} — ` +
        `a cached or stale run`,
    };
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

  const blocking = findings.filter(
    (f) => !f.dismissed && BLOCKING_SEVERITIES.includes(f.severity),
  );

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

  return {
    ...base,
    status: blocking.length > 0 ? 'findings' : 'clean',
    sha: parsed.doc.sha,
    findings,
    detail,
    findingsReason: blocking.length > 0 ? 'provider_findings' : null,
  };
}
