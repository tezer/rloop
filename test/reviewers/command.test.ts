import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { runCommandReviewer } from '../../src/reviewers/command.js';

const FIX = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/reviewers');
const HEAD = 'a'.repeat(40);
const rev = (file: string, dismiss: Array<{ fingerprint: string; reason: string }> = []) => ({
  name: 'codex',
  run: `node ${path.join(FIX, file)}`,
  timeout_seconds: 15,
  dismiss,
  inject_sha: false,
});
const go = (file: string, dismiss?: Array<{ fingerprint: string; reason: string }>) =>
  runCommandReviewer(rev(file, dismiss), { repoRoot: process.cwd(), headSha: HEAD });

describe('runCommandReviewer', () => {
  it('reports clean when the document has no findings', async () => {
    expect((await go('clean.mjs')).status).toBe('clean');
  });

  it('reports findings, and computes a fingerprint for each', async () => {
    const r = await go('findings.mjs');
    expect(r.status).toBe('findings');
    expect(r.findings).toHaveLength(2);
    for (const f of r.findings) expect(f.fingerprint).toMatch(/^[0-9a-f]{8}$/);
  });

  it('is clean when only MINOR findings are present', async () => {
    // minor never blocks, but the findings still travel in the report.
    const r = await go('minor-only.mjs');
    expect(r.status).toBe('clean');
    expect(r.findings).toHaveLength(1);
  });

  it('names dismissals that matched nothing', async () => {
    // A dismissal list that quietly accumulates unmatched entries is how a
    // real finding gets pre-suppressed by accident. Warning, not an error:
    // the usual cause is that the finding was genuinely fixed. NOT phrased as
    // "so they can be deleted" — see the sibling test below for why deleting
    // is the wrong advice for a nondeterministic provider.
    const r = await go('clean.mjs', [{ fingerprint: 'deadbeef', reason: 'stale entry' }]);
    expect(r.status).toBe('clean');
    expect(r.detail).toContain('deadbeef');
  });

  it('reports unavailable when the command is not found (bash exits 127)', async () => {
    const r = await runCommandReviewer(
      { ...rev('clean.mjs'), run: 'definitely-not-a-real-binary-xyz' },
      { repoRoot: process.cwd(), headSha: HEAD },
    );
    expect(r.status).toBe('unavailable');
    // bash itself spawned fine and exited 127 with unparseable output — it
    // ran, unlike an unspawnable cwd, so this is 'crashed', not 'never_ran'.
    expect(r.unavailableReason).toBe('crashed');
  });

  it('reports unavailable when the command cannot be SPAWNED at all', async () => {
    // Distinct from a missing binary, which spawns bash successfully and
    // exits 127 into the unparseable branch. An unspawnable cwd is the only
    // way to reach `run.spawnError`.
    const r = await runCommandReviewer(rev('clean.mjs'), {
      repoRoot: '/nonexistent-directory-for-rloop-reviewer-test',
      headSha: HEAD,
    });
    expect(r.status).toBe('unavailable');
    expect(r.detail).toMatch(/could not start/);
    // Never ran at all — this is the one cause "could not run" is true of.
    expect(r.unavailableReason).toBe('never_ran');
  });

  it('reports unavailable when the command crashes without a document', async () => {
    const r = await go('crash.mjs');
    expect(r.status).toBe('unavailable');
    // The process ran and exited non-zero without usable output — distinct
    // from never having run at all (see I1: merge-gate.ts must not say
    // "could not run" for this cause, since it did run).
    expect(r.unavailableReason).toBe('crashed');
  });

  it('reports MALFORMED, not unavailable, when it exits 0 with junk', async () => {
    // The distinction is the point: a reviewer you broke is a different
    // problem from one you never had.
    expect((await go('junk-exit-zero.mjs')).status).toBe('malformed');
  });

  it('reports malformed when valid JSON fails the schema', async () => {
    expect((await go('bad-schema.mjs')).status).toBe('malformed');
  });

  it('reports unavailable, not malformed, when schema-invalid output is paired with a non-zero exit', async () => {
    // The exit code is the provider's own verdict on whether it ran. rloop
    // trusts that over the shape of whatever it printed: a non-zero exit
    // beats a schema failure, same as it beats an unparseable document.
    const r = await go('bad-schema-exit-1.mjs');
    expect(r.status).toBe('unavailable');
    expect(r.unavailableReason).toBe('crashed');
    // The fixture writes NOTHING to stderr — the case the schema failure is
    // hardest to diagnose in, and the one a prior fix silently dropped
    // (`detail` used to be built from just the exit code and an empty
    // stderr slice). The precise schema failure computed a few lines up in
    // command.ts must survive into `detail`, not just the exit code.
    expect(r.detail).toContain("Unrecognized key(s) in object: 'results'");
  });

  it('reports findings, not clean or unavailable, when a parsed document has blocking findings and a non-zero exit', async () => {
    // Linters conventionally exit non-zero BECAUSE they found something. A
    // non-zero exit may never produce `clean`, but it must not override a
    // document that already reports blocking findings either — the document
    // is trusted here, same as the timeout-vs-schema precedence above.
    const r = await go('findings-exit-1.mjs');
    expect(r.status).toBe('findings');
    expect(r.findingsReason).toBe('provider_findings');
    expect(r.findings).toHaveLength(1);
  });

  it('reports unavailable, not clean, when a parsed document reports nothing blocking but the exit is non-zero', async () => {
    // The rule this test pins: a non-zero exit may NEVER result in `clean`.
    // A well-formed, schema-valid document with no blocking findings would
    // otherwise be `clean` — but exiting non-zero means the provider's own
    // signals contradict each other, and rloop does not resolve that
    // contradiction in the merge-permitting direction.
    const r = await go('clean-exit-1.mjs');
    expect(r.status).toBe('unavailable');
    expect(r.findingsReason).toBeNull();
    expect(r.detail).toMatch(/contradict/i);
    // It ran and produced a valid document — merge-gate.ts must not render
    // this as "could not run" (I1). unavailableReason is how it knows not to.
    expect(r.unavailableReason).toBe('contradicted');
  });

  it('reports stale when the echoed sha is not the head', async () => {
    const r = await go('wrong-sha.mjs');
    expect(r.status).toBe('stale');
    expect(r.detail).toContain('c'.repeat(7));
  });

  it('prefers stale over findings when the provider reviewed another commit', async () => {
    // Order dependence, and it is real: findings against a non-head tree
    // must not be reported as findings against head.
    const r = await go('wrong-sha-with-findings.mjs');
    expect(r.status).toBe('stale');
  });

  describe('inject_sha', () => {
    const inject = (file: string) =>
      runCommandReviewer(
        { ...rev(file), inject_sha: true },
        { repoRoot: process.cwd(), headSha: HEAD },
      );

    it('accepts a document with no sha, and binds it to head', async () => {
      // The reason to want this: the alternative is asking a model to copy a
      // 40-character hex string into a JSON field, and a model asked to copy a
      // hex string will eventually not. That failure arrives as `stale`, which
      // sends the operator looking at commits instead of at the prompt.
      const r = await inject('no-sha.mjs');
      expect(r.status).toBe('clean');
      expect(r.sha).toBe(HEAD);
    });

    it('still classifies findings normally without the echo', async () => {
      const r = await inject('no-sha-critical.mjs');
      expect(r.status).toBe('findings');
      expect(r.sha).toBe(HEAD);
    });

    it('does NOT accept a sha that is present and wrong', async () => {
      // The relaxation is "you need not echo it", never "any sha will do". A
      // provider that reviewed another commit and said so is still stale.
      const r = await inject('wrong-sha.mjs');
      expect(r.status).toBe('stale');
    });

    it('is opt-in: without it, a missing sha is malformed', async () => {
      // The other half. A single permissive schema would turn a per-reviewer
      // relaxation into a silent global one.
      expect((await go('no-sha.mjs')).status).toBe('malformed');
    });
  });

  it('times out into unavailable', async () => {
    const r = await runCommandReviewer(
      { ...rev('hang.mjs'), timeout_seconds: 1 },
      { repoRoot: process.cwd(), headSha: HEAD },
    );
    expect(r.status).toBe('unavailable');
    expect(r.detail).toMatch(/timed out/i);
    expect(r.unavailableReason).toBe('never_ran');
  }, 20_000);

  it('does not truncate a several-hundred-KB document round-tripped through parsing (large-payload regression guard)', async () => {
    const r = await go('large-payload.mjs');
    expect(r.status).toBe('clean'); // minor-only
    const size = 400 * 1024;
    expect(r.findings[0].body).toHaveLength(size);
    expect(r.findings[0].body?.endsWith('END-OF-BODY')).toBe(true);
  });

  it('does NOT tell the operator to delete a dismissal that matched nothing', async () => {
    // Sound advice for a deterministic provider; wrong for a model, whose
    // findings come and go between runs on identical input. A reader who
    // follows the old imperative deletes the one thing standing between the
    // same finding and a blocked merge tomorrow.
    const r = await go('clean.mjs', [{ fingerprint: 'deadbeef', reason: 'stale entry' }]);
    expect(r.detail).toContain('deadbeef');
    expect(r.detail).not.toMatch(/delete/i);
    expect(r.detail).toMatch(/did not recur/i);
  });

  it('says WHY a dismissal cannot match when the provider emits no ids', async () => {
    // The failure this names: without `id`, identity is path + normalized
    // title, and a model rewords. Every dismiss entry then stops matching
    // while the config still looks configured.
    const r = await go('one-critical-idless.mjs', [
      { fingerprint: 'deadbeef', reason: 'was fixed' },
    ]);
    expect(r.detail).toMatch(/1 of 1 finding\(s\) carried no "id"/);
  });

  it('warns about id-less findings even when SOME findings carry an id', async () => {
    // The predicate used to be `findings.some((f) => f.id !== null)`, which
    // went quiet the moment one finding had an id — so a model that managed
    // an id for a minor and dropped it for the critical got no warning about
    // the one that matters. Mixed output is the EXPECTED shape from a model,
    // not an edge case, so the homogeneous fixtures above cannot pin this.
    const r = await go('mixed-ids.mjs', [{ fingerprint: 'deadbeef', reason: 'was fixed' }]);
    expect(r.detail).toMatch(/1 of 2 finding\(s\) carried no "id"/);
  });

  describe('a dismissal whose fingerprint matches more than one finding', () => {
    // Fingerprints are not unique by construction: without an `id`, identity
    // is path + normalized title, so two DIFFERENT defects in one file that a
    // model words the same way collapse onto one fingerprint. A dismissal
    // written for the first would otherwise silently suppress the second —
    // and because the fingerprint DID match, the unmatched-dismissal warning
    // cannot fire either. Measured before the fix: `clean`, `detail: null`.
    const fpOf = async () => (await go('two-idless-same-title.mjs')).findings[0].fingerprint;

    it('is REFUSED, so the findings still block', async () => {
      const r = await go('two-idless-same-title.mjs', [
        { fingerprint: await fpOf(), reason: 'checked the first one' },
      ]);
      expect(r.status).toBe('findings');
      expect(r.findings.every((f) => !f.dismissed)).toBe(true);
    });

    it('says so, rather than passing silently', async () => {
      // The pre-fix outcome was merge-permitting with NO output of any kind,
      // which is the worst shape a failure can take in this tool.
      const r = await go('two-idless-same-title.mjs', [
        { fingerprint: await fpOf(), reason: 'checked the first one' },
      ]);
      expect(r.detail).toMatch(/REFUSED/);
      expect(r.detail).toMatch(/more than one finding/);
    });

    it('still lets a dismissal that matches exactly one finding through', async () => {
      // The other half: refusing over-matches must not break the normal case.
      const first = await go('findings.mjs');
      const critical = first.findings.find((f) => f.severity === 'critical')!;
      const r = await go('findings.mjs', [
        { fingerprint: critical.fingerprint, reason: 'guard is in the caller' },
      ]);
      expect(r.status).toBe('clean');
    });
  });

  it('names a dismissal that LANDED on an id-less finding', async () => {
    // The cross-run collision the over-match refusal cannot see: it counts
    // fingerprints within ONE document, and title-derived identity collides
    // across runs too, where rloop has no memory. One id-less finding plus a
    // dismissal written last week for a different defect worded the same way
    // is occurrences === 1 — no refusal, no miss, and before this, no output:
    // `clean` with `detail: null` and zero blockers.
    const probe = await go('one-critical-idless.mjs');
    const fp = probe.findings[0].fingerprint;
    const r = await go('one-critical-idless.mjs', [{ fingerprint: fp, reason: 'checked it' }]);
    expect(r.status).toBe('clean');
    expect(r.detail).not.toBeNull();
    expect(r.detail).toMatch(/NO "id"/);
  });

  it('stays quiet when the dismissed finding carries an id', async () => {
    // The other half: a provider with stable ids must not be lectured.
    const probe = await go('one-critical-with-id.mjs');
    const r = await go('one-critical-with-id.mjs', [
      { fingerprint: probe.findings[0].fingerprint, reason: 'checked it' },
    ]);
    expect(r.status).toBe('clean');
    expect(r.detail).toBeNull();
  });

  it('caps a hostile finding title in the id-less dismissal note', async () => {
    // `truncate`'s second parameter had no fixture over 60 chars, so ignoring
    // it left the suite green — and this note carries provider-controlled
    // text onto the one merge-PERMITTING path any of it reaches.
    const probe = await go('long-title-idless.mjs');
    const r = await go('long-title-idless.mjs', [
      { fingerprint: probe.findings[0].fingerprint, reason: 'checked it' },
    ]);
    expect(r.detail).toMatch(/…/);
    expect(r.detail!.length).toBeLessThan(500);
    // Quoted, for the same reason stderr is: this is a title the provider chose.
    expect(r.detail).toMatch(/"T+…"/);
  });

  it('names the suspect fingerprint, not just the fact that one exists', async () => {
    // Deleting the `fingerprint (title)` listing used to survive: the test
    // asserted only `/NO "id"/`, and the listing is the actionable half.
    const probe = await go('one-critical-idless.mjs');
    const fp = probe.findings[0].fingerprint;
    const r = await go('one-critical-idless.mjs', [{ fingerprint: fp, reason: 'checked it' }]);
    expect(r.detail).toContain(fp);
  });

  it('keeps dismissal notes on the `contradicted` early return', async () => {
    // That return exits before the normal note-building, and the refusal note
    // was threaded through it while its twin — a dismissal landing on an
    // id-less finding — was left behind. Same class of config defect; losing
    // it hides a config problem behind a run problem.
    const probe = await go('contradicted-overmatch.mjs');
    const fp = probe.findings[0].fingerprint;
    const r = await go('contradicted-overmatch.mjs', [{ fingerprint: fp, reason: 'checked one' }]);
    expect(r.unavailableReason).toBe('contradicted');
    expect(r.detail).toMatch(/REFUSED/);
  });

  describe("the provider's stderr", () => {
    // stderr is frequently the ONLY diagnosis of a failed model call, and the
    // shipped example tells providers to narrate there. It used to reach the
    // operator on `crashed` alone — so the two paths a provider is most likely
    // to reach dropped it.
    it('reaches the operator on `contradicted`', async () => {
      // The path `set -o pipefail` exists to produce: a usable document AND a
      // failure. Without the snippet the operator gets a generic contradiction
      // sentence and loses the actual cause.
      const r = await go('clean-exit-1-stderr.mjs');
      expect(r.unavailableReason).toBe('contradicted');
      expect(r.detail).toMatch(/context_length_exceeded/);
    });

    it('keeps the TAIL, because a model reports its fatal error last', async () => {
      // The head of a failed model call is progress narration; the line that
      // explains it arrives after. A head-biased cap — which is right for zod
      // errors and was wrong here — discards exactly the diagnosis this
      // append exists to surface.
      const r = await go('noisy-then-fatal.mjs');
      expect(r.unavailableReason).toBe('contradicted');
      expect(r.detail).toMatch(/context_length_exceeded/);
    });

    it('ESCAPES a quote rather than merely wrapping in one', async () => {
      // The distinction this pins: naive `\`"${snippet}"\`` also satisfies
      // "starts with a quote" and "has no newline" (the whitespace collapse
      // already removes newlines), so an earlier version of the test below
      // passed with `JSON.stringify` replaced by string concatenation. A
      // hostile provider emitting `"` closes a naive wrapper; only real
      // escaping survives it.
      const r = await go('forged-stderr.mjs');
      expect(r.detail).toMatch(/\\"/);
    });

    it('cannot be used to forge structure in a blocker message', async () => {
      // A command reviewer is an arbitrary third-party script and owns its
      // stderr. This string is embedded in messages an agent parses, so a
      // provider closing rloop's parenthesis and adding "VERDICT: MERGEABLE"
      // on its own line is a real vector. Length-capping does not touch
      // structure; collapsing whitespace and quoting does.
      const r = await go('forged-stderr.mjs');
      expect(r.detail).not.toMatch(/\n/);
      expect(r.detail).toMatch(/stderr: "/);
    });

    it('reaches the operator on `malformed`', async () => {
      const r = await go('junk-exit-zero-stderr.mjs');
      expect(r.status).toBe('malformed');
      expect(r.detail).toMatch(/auth token expired/);
    });
  });

  it('stays quiet about ids when the provider does emit them', async () => {
    // The other half. A linter with stable rule codes must not be lectured
    // about a problem it does not have.
    const r = await go('one-critical-with-id.mjs', [
      { fingerprint: 'deadbeef', reason: 'was fixed' },
    ]);
    expect(r.detail).toContain('deadbeef');
    // `carried no "id"` — matching on `carried an "id"` is VACUOUS, because
    // `unmatchedDetail` never emits that phrasing. Confirmed by mutation:
    // forcing the warning on for every report left this test green.
    expect(r.detail).not.toMatch(/carried no "id"/);
  });

  it('a dismissed blocking finding is reported but does not block', async () => {
    const first = await go('findings.mjs');
    const critical = first.findings.find((f) => f.severity === 'critical')!;
    const r = await go('findings.mjs', [
      { fingerprint: critical.fingerprint, reason: 'guard is in the caller' },
    ]);
    expect(r.status).toBe('clean');
    expect(r.findings.find((f) => f.fingerprint === critical.fingerprint)?.dismissed).toBe(true);
  });
});
