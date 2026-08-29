import { parseProviderDocument } from './document.js';
import { fingerprint } from './fingerprint.js';
import { readProviderJson } from './read-json.js';
import { assertReasonCoupling, isBlocking, type Finding, type ReviewerReport } from './types.js';

export interface CommandReviewer {
  name: string;
  run: string;
  timeout_seconds: number;
  dismiss: Array<{ fingerprint: string; reason: string }>;
  /**
   * See the `sha` handling below, and `config.ts`. Required rather than
   * optional: zod defaults it, so every config-derived value carries it, and
   * an optional field here would exist only to let a hand-built caller land on
   * a third state that neither `rev.inject_sha` nor `!rev.inject_sha` reads
   * the way its author meant.
   *
   * UNPINNED by the suite, deliberately: widening this back to `inject_sha?:`
   * leaves all 247 tests green, because every existing caller supplies it. The
   * guard is a COMPILE error for a FUTURE caller that forgets, which no test
   * can express. Do not read its presence as evidence anything checks it.
   */
  inject_sha: boolean;
}

const short = (sha: string) => sha.slice(0, 7);

/**
 * Cap a diagnostic snippet so one enormous message (a zod error listing every
 * offending key, or a stack trace on stderr) can't dominate a `detail` line
 * that is rendered inline in a blocker message and in `pr status` output.
 */
const truncate = (s: string, max = 200) => (s.length > max ? `${s.slice(0, max)}…` : s);

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
 *   no blocking findings AND exit != 0           -> unavailable  (signals contradict)
 *   no blocking findings AND exit == 0           -> clean
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
    return assertReasonCoupling({
      ...base,
      status: 'unavailable',
      unavailableReason: 'never_ran',
      detail: `could not start: ${run.spawnError.message}`,
    });
  }
  if (run.timedOut) {
    return assertReasonCoupling({
      ...base,
      status: 'unavailable',
      unavailableReason: 'never_ran',
      detail: `timed out after ${rev.timeout_seconds}s`,
    });
  }

  const parsed = parseProviderDocument(run.stdout, { shaOptional: rev.inject_sha });
  if (!parsed.ok) {
    if (run.exitCode !== 0) {
      // The parse/schema failure is the precise diagnosis — computed a few
      // lines up, and the one piece of information that actually explains
      // what went wrong. It must not be dropped in favor of the exit code
      // and stderr alone: those two are frequently empty (a schema failure
      // on a well-formed document writes nothing to stderr), which without
      // parsed.error left the operator staring at "exited 1 without a usable
      // document:" followed by nothing.
      const stderrSnippet = run.stderr.trim();
      const detail = stderrSnippet
        ? `exited ${run.exitCode} without a usable document: ${truncate(parsed.error)} ` +
          `(stderr: ${truncate(stderrSnippet)})`
        : `exited ${run.exitCode} without a usable document: ${truncate(parsed.error)}`;
      return assertReasonCoupling({
        ...base,
        status: 'unavailable',
        unavailableReason: 'crashed',
        detail,
      });
    }
    return assertReasonCoupling({ ...base, status: 'malformed', detail: truncate(parsed.error) });
  }

  /**
   * A `null` echo reaches here only when `inject_sha: true` let the schema
   * accept a document without one, so rloop supplies the sha it spawned the
   * process with. Note what that gives up and what it does not: the echo's
   * job was to catch a CACHED document, and a provider rloop launched in this
   * invocation cannot hand back a document from a previous one unless it
   * caches internally — which is precisely the case the config author opts
   * out of checking.
   *
   * BE PRECISE about what remains, because the obvious sentence here is
   * false. "rloop refuses to run against a dirty worktree" is true of a GATE
   * run — `runGates` calls `isDirty` and voids the run — and it is NOT true
   * of this function. `collectReviewerReports` is not behind that check, and
   * under `--skip-gates` no dirtiness check happens at all. So a provider
   * that reads working-tree files rather than committed state can review
   * uncommitted bytes and, with the echo relaxed, get `opts.headSha` stamped
   * on the result. `evaluateMergeGate` still blocks the merge — gates are
   * void or their sha disagrees — but `pr status` will render that reviewer
   * as clean at a commit it did not review.
   *
   * That is the cost of the flag, stated plainly rather than argued away.
   * Leave it off for a provider that inspects the worktree.
   *
   * An echo that is present and WRONG is still stale, injection or not. The
   * relaxation is "you need not copy the sha", never "any sha will do".
   */
  const reviewedSha = parsed.doc.sha ?? opts.headSha;
  if (reviewedSha !== opts.headSha) {
    return assertReasonCoupling({
      ...base,
      status: 'stale',
      sha: reviewedSha,
      detail:
        `reviewed ${short(reviewedSha)} but head is ${short(opts.headSha)} — ` +
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
    return assertReasonCoupling({
      ...base,
      status: 'unavailable',
      unavailableReason: 'contradicted',
      sha: reviewedSha,
      findings,
      detail:
        `exited ${run.exitCode} but its document reports no blocking findings — the ` +
        `provider's own signals contradict each other: the exit code says it failed, the ` +
        `document says it is clean`,
    });
  }

  // A dismissal that matches nothing is usually a finding that was genuinely
  // fixed. It is a warning rather than an error — erroring would punish the
  // good outcome — but never SILENT: an accumulating dismissal list is how a
  // future real finding gets pre-suppressed by accident.
  //
  // NOT phrased as an instruction to delete, which is what it used to say.
  // "(delete them)" is sound advice for a deterministic provider and wrong
  // for a model, whose findings come and go between runs on identical input:
  // a dismissal that missed today may be the only thing standing between the
  // same finding and a blocked merge tomorrow, and a reader who followed the
  // imperative made a change that breaks later.
  const seen = new Set(findings.map((f) => f.fingerprint));
  const unmatched = rev.dismiss.filter((d) => !seen.has(d.fingerprint)).map((d) => d.fingerprint);
  const detail = unmatched.length > 0 ? unmatchedDetail(unmatched, findings) : null;

  return assertReasonCoupling({
    ...base,
    status: blocking.length > 0 ? 'findings' : 'clean',
    sha: reviewedSha,
    findings,
    detail,
    findingsReason: blocking.length > 0 ? 'provider_findings' : null,
  });
}

/**
 * Why a dismissal missed, when rloop can tell.
 *
 * The interesting case is a provider whose findings carry no `id`. Identity
 * then falls back to `path` + normalized `title` (see `fingerprint.ts`), which
 * is stable for a linter with fixed rule text and is NOT stable for a model:
 * one defect reworded across three runs is three fingerprints, so every
 * `dismiss:` entry silently stops matching while the config still looks
 * configured. That is worth naming at the moment of the miss, because it is
 * indistinguishable by inspection from the healthy case where the finding was
 * simply fixed.
 */
function unmatchedDetail(unmatched: string[], findings: Finding[]): string {
  const lead =
    `dismissals matching nothing at head: ${unmatched.join(', ')} — either the finding ` +
    `is fixed, or it did not recur this run`;
  if (findings.length === 0 || findings.some((f) => f.id !== null)) return lead;
  return (
    `${lead}. This provider emitted ${findings.length} finding(s) and none carried an "id", ` +
    `so their fingerprints come from the title text — a provider that rewords a finding ` +
    `between runs cannot be dismissed reliably until it emits stable ids`
  );
}
