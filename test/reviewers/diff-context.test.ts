import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadConfig } from '../../src/config.js';
import { collectReviewerReports } from '../../src/reviewers/collect.js';
import { HERMETIC_GIT_ENV } from '../support/git.js';

/**
 * What rloop hands a `kind: command` reviewer, and what it refuses to conclude
 * when it could not hand over a whole one.
 *
 * These run against a REAL clone of a REAL bare origin, not a mock. The
 * properties under test are all about git's actual behaviour — whether a fetch
 * updates a tracking ref, what a three-dot diff contains after the base moves
 * on — and a fake git would let every one of them pass while the shipped code
 * did the wrong thing against the real one.
 */
const FIX = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/reviewers');

let origin: string;
let clone: string;
let headSha: string;

const git = (args: string[], cwd: string) =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...HERMETIC_GIT_ENV },
  }).trim();

const cfgFor = (body: string) =>
  loadConfig(`
version: 1
gates:
  - name: build
    run: 'true'
    require: ["^ok$"]
reviewers:
${body}
`);

const collect = (cfg: ReturnType<typeof loadConfig>, repoRoot = clone, baseBranch = 'main') =>
  collectReviewerReports(cfg, { repoRoot, headSha, reviews: [], baseBranch });

/** Finding titles from the diff-echo fixture, as a lookup. */
const echoed = (titles: string[]) =>
  Object.fromEntries(titles.map((t) => t.split('=') as [string, string]));

beforeAll(() => {
  origin = mkdtempSync(path.join(tmpdir(), 'rloop-diffctx-origin-'));
  git(['init', '--bare', '-q', '-b', 'main', '.'], origin);

  const seed = mkdtempSync(path.join(tmpdir(), 'rloop-diffctx-seed-'));
  git(['init', '-q', '-b', 'main', '.'], seed);
  writeFileSync(path.join(seed, 'seed.txt'), 'seed\n');
  git(['add', '-A'], seed);
  git(['commit', '-qm', 'seed'], seed);
  git(['remote', 'add', 'origin', origin], seed);
  git(['push', '-q', 'origin', 'main'], seed);

  clone = mkdtempSync(path.join(tmpdir(), 'rloop-diffctx-clone-'));
  git(['clone', '-q', origin, clone], tmpdir());

  // The base moves on AFTER the clone. This is the whole point: the clone's
  // `origin/main` is now stale, so any code path that skips the fetch reviews
  // a base that no longer exists upstream — silently, because the diff it
  // produces is perfectly well-formed.
  writeFileSync(path.join(seed, 'added-on-base.txt'), 'landed upstream\n');
  git(['add', '-A'], seed);
  git(['commit', '-qm', 'work that landed on the base'], seed);
  git(['push', '-q', 'origin', 'main'], seed);
  rmSync(seed, { recursive: true, force: true });

  // A branch commit in the clone, which is what the reviewer should see.
  git(['checkout', '-q', '-b', 'feature'], clone);
  writeFileSync(path.join(clone, 'added-on-branch.txt'), 'x'.repeat(4096) + '\n');
  git(['add', '-A'], clone);
  git(['commit', '-qm', 'work under review'], clone);
  headSha = git(['rev-parse', 'HEAD'], clone);
});

afterAll(() => {
  for (const d of [origin, clone]) if (d) rmSync(d, { recursive: true, force: true });
});

describe('the diff rloop hands a command reviewer', () => {
  const echoCfg = cfgFor(`  - name: echo
    kind: command
    needs_diff: true
    run: node ${path.join(FIX, 'diff-echo.mjs')}
    timeout_seconds: 30`);

  it('sets RLOOP_BASE_REF and writes a readable RLOOP_DIFF_FILE', async () => {
    const r = (await collect(echoCfg))[0];
    const seen = echoed(r.findings.map((f) => f.title));
    expect(seen.base).toBe('origin/main');
    expect(seen['diff-read-failed']).toBeUndefined();
    // Asserted against the byte count rloop advertised, so a file that exists
    // but was never written cannot pass.
    expect(Number(seen['diff-bytes'])).toBeGreaterThan(4000);
    expect(seen.bytes).toBe(seen['diff-bytes']);
    expect(seen.truncated).toBe('0');
  });

  it('shows the branch commit and NOT work that landed on the base', async () => {
    // Two failures in one assertion, both silent in the wild. A missing fetch
    // leaves origin/main behind and the three-dot diff still succeeds; a
    // two-dot diff against a base that moved presents the base's own new file
    // as a deletion by this branch. Either way the reviewer is confidently
    // wrong about what changed.
    const seen = echoed((await collect(echoCfg))[0].findings.map((f) => f.title));
    expect(seen['mentions-added-file']).toBe('true');
    expect(seen['mentions-base-only-file']).toBe('false');
  });

  it('leaves the worktree clean, so it cannot poison the next run', async () => {
    await collect(echoCfg);
    expect(git(['status', '--porcelain', '--untracked-files=all'], clone)).toBe('');
  });

  it('does not fetch or set the variables when needs_diff is not opted into', async () => {
    // The 0.3.x path, preserved exactly: a reviewer that never reads a diff
    // must not acquire a new way to fail.
    const cfg = cfgFor(`  - name: echo
    kind: command
    run: node ${path.join(FIX, 'diff-echo.mjs')}
    timeout_seconds: 30`);
    const seen = echoed((await collect(cfg))[0].findings.map((f) => f.title));
    expect(seen.base).toBe('UNSET');
    expect(seen['diff-read-failed']).toBeDefined();
  });
});

describe('a diff that could not be prepared', () => {
  it('blocks the reviewer instead of reviewing an unknown base', async () => {
    // A repo with no `origin` at all. The tempting alternative — carry on and
    // diff against whatever ref happens to be local — is exactly the silent
    // failure this feature exists to remove, so it must be `unavailable`.
    const lonely = mkdtempSync(path.join(tmpdir(), 'rloop-diffctx-lonely-'));
    try {
      git(['init', '-q', '-b', 'main', '.'], lonely);
      writeFileSync(path.join(lonely, 'f.txt'), 'x');
      git(['add', '-A'], lonely);
      git(['commit', '-qm', 'one'], lonely);

      const cfg = cfgFor(`  - name: echo
    kind: command
    needs_diff: true
    run: node ${path.join(FIX, 'clean.mjs')}
    timeout_seconds: 30`);
      const r = (await collect(cfg, lonely))[0];
      expect(r.status).toBe('unavailable');
      expect(r.unavailableReason).toBe('never_ran');
      expect(r.detail).toMatch(/could not fetch origin\/main/);
      // One line, not git's five lines of remote-repository advice.
      expect(r.detail?.split('\n')).toHaveLength(1);
    } finally {
      rmSync(lonely, { recursive: true, force: true });
    }
  });
});

describe('a truncated diff', () => {
  const cap = (file: string, dismiss = '') =>
    cfgFor(`  - name: capped
    kind: command
    needs_diff: true
    diff_max_bytes: 512
    run: node ${path.join(FIX, file)}
    timeout_seconds: 30${dismiss}`);

  it('is advertised to the provider', async () => {
    const seen = echoed((await collect(cap('diff-echo.mjs')))[0].findings.map((f) => f.title));
    expect(seen.truncated).toBe('1');
    expect(seen['diff-bytes']).toBe('512');
  });

  it('may NEVER be reported clean', async () => {
    // The provider here is `clean.mjs`: exits 0, valid document, no findings.
    // Every signal rloop has from the provider says pass. Only rloop knows the
    // review covered 512 bytes of a 4KB change.
    const r = (await collect(cap('clean.mjs')))[0];
    expect(r.status).toBe('unavailable');
    expect(r.unavailableReason).toBe('incomplete');
    expect(r.detail).toMatch(/truncated at 512 bytes/);
  });

  it('still reports findings when it found something blocking', async () => {
    // An incomplete review that found a blocker has still found a blocker;
    // sending the author to fix it is right. It is only the merge-permitting
    // direction that gets withheld.
    const r = (await collect(cap('one-critical-with-id.mjs')))[0];
    expect(r.status).toBe('findings');
    expect(r.findingsReason).toBe('provider_findings');
  });

  /**
   * The sharpest case, and the reason this check is rloop's job.
   *
   * A provider guarding its own truncation counts findings BEFORE `dismiss:`
   * is applied; rloop decides AFTER. So a truncated diff yielding one critical
   * finding that a dismissal then removes leaves the provider exiting 0 (it
   * found something, its guard was satisfied) and rloop seeing nothing
   * blocking. Two pieces of individually-correct logic, one partial review
   * reported as `clean`.
   *
   * Move the truncation check above the dismissal filter in command.ts and
   * this test goes green while the hole reopens — so it asserts the STATUS,
   * not the presence of the guard.
   */
  it('is not laundered into clean by a dismissal removing the only finding', async () => {
    const probe = (await collect(cap('one-critical-with-id.mjs')))[0];
    const fp = probe.findings[0].fingerprint;

    const r = (
      await collect(
        cap(
          'one-critical-with-id.mjs',
          `\n    dismiss:\n      - fingerprint: ${fp}\n        reason: "handled in the caller"`,
        ),
      )
    )[0];
    expect(r.findings[0].dismissed).toBe(true);
    expect(r.status).not.toBe('clean');
    expect(r.unavailableReason).toBe('incomplete');
  });
});
