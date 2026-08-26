import { execFileSync, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { HERMETIC_GIT_ENV } from './support/git.js';

/**
 * How the binary behaves before it does any work: what a bare invocation does,
 * and whether it can state its own version.
 *
 * Spawned against the BUILT `dist/cli.js` rather than importing `src/cli.ts`,
 * for a reason particular to this file: the module runs `main()` at import
 * time, so an in-process test cannot observe argv handling without executing
 * the tool. Exit codes and stream routing are also part of what is asserted
 * here, and those exist only in a real process.
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(root, 'dist', 'cli.js');
const PKG_VERSION: string = createRequire(import.meta.url)('../package.json').version;

/**
 * Whether the gate ran is observed through a FILE the gate touches, not through
 * rloop's output.
 *
 * The obvious version of this test greps stdout for a marker the gate echoes.
 * It does not work, and it fails open: rloop captures gate output into its log
 * directory, so the marker is absent from stdout whether the gate ran or not,
 * and the assertion passes with the bug restored.
 *
 * The sentinel lives OUTSIDE the repo on purpose — creating a file inside it
 * would dirty the worktree, and rloop's preflight then blocks the next run
 * before any gate executes, which would break the test for an unrelated reason.
 */
const GATE_MARKER = 'RLOOP_GATE_ACTUALLY_RAN';

let dir: string;
let cfg: string;
let sentinelDir: string;
let sentinel: string;

beforeAll(() => {
  if (!existsSync(cli)) {
    execFileSync('npx', ['tsc', '-p', 'tsconfig.json'], { cwd: root, stdio: 'inherit' });
  }
  dir = mkdtempSync(path.join(tmpdir(), 'rloop-cli-'));
  sentinelDir = mkdtempSync(path.join(tmpdir(), 'rloop-cli-sentinel-'));
  sentinel = path.join(sentinelDir, 'ran');
  cfg = path.join(dir, 'rloop.yaml');
  writeFileSync(
    cfg,
    `version: 1\ngates:\n  - name: loud\n` +
      `    run: sh -c 'echo "${GATE_MARKER}" > "${sentinel}"; echo "${GATE_MARKER}"'\n` +
      `    require: ["^${GATE_MARKER}$"]\n`,
  );
  writeFileSync(path.join(dir, 'seed.txt'), 'seed');
  const env = { ...process.env, ...HERMETIC_GIT_ENV };
  for (const args of [['init', '-q'], ['add', '-A'], ['commit', '-qm', 'init']]) {
    execFileSync('git', args, { cwd: dir, stdio: 'pipe', env });
  }
}, 120_000);

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  if (sentinelDir) rmSync(sentinelDir, { recursive: true, force: true });
});

beforeEach(() => rmSync(sentinel, { force: true }));

const run = (args: string[]) =>
  spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', cwd: root });

describe('bare invocation', () => {
  /**
   * The regression this exists for: `rloop` with no subcommand used to mean
   * `rloop gate`. Someone typed `rloop 2>&1 | head -60` expecting usage text
   * and spent 208 seconds building a shared checkout other agents were using.
   *
   * `gate` runs arbitrary commands from the config and `-C` defaults to the
   * CONFIG FILE's directory, not the cwd — so the wrong shell is enough.
   *
   * Asserting the sentinel, not just the exit code: a gate that ran and failed
   * would also exit non-zero, so an exit-code-only test would pass with the
   * default restored. This one cannot.
   */
  it('does not run the gate, and says so on stderr with exit 2', () => {
    const r = run(['-c', cfg, '-C', dir]);
    expect(existsSync(sentinel)).toBe(false);
    expect(r.stderr).toContain('Usage:');
    expect(r.status).toBe(2);
  });

  /**
   * The other half of the same property. `rloop gate` must still run the gate —
   * a fix that made a bare call safe by breaking the subcommand would satisfy
   * the test above on its own.
   */
  it('still runs the gate when `gate` is named explicitly', () => {
    const r = run(['gate', '-c', cfg, '-C', dir]);
    expect(existsSync(sentinel)).toBe(true);
    expect(r.status).toBe(0);
  });

  /** Usage on request is not an error, and goes to stdout so it can be piped. */
  it('prints usage to stdout with exit 0 for --help', () => {
    const r = run(['--help']);
    expect(r.stdout).toContain('Usage:');
    expect(r.status).toBe(0);
  });
});

describe('--version', () => {
  /**
   * A pinned version is load-bearing here — `.mcp.json` pins an exact package,
   * and config shapes are version-gated — yet the binary used to reject both
   * `--version` and `version`, leaving an operator to infer which build was
   * running from which deprecation warnings happened to appear.
   *
   * Compared against package.json rather than a literal, so it cannot drift
   * from what npm shipped and cannot be satisfied by a hardcoded string.
   */
  it.each([['--version'], ['-V'], ['version']])('%s prints the package version', (flag) => {
    const r = run([flag]);
    expect(r.stdout.trim()).toBe(PKG_VERSION);
    expect(r.status).toBe(0);
  });

  /** Answered before config resolution: an unconfigured dir must still work. */
  it('answers from a directory with no config anywhere above it', () => {
    const r = spawnSync(process.execPath, [cli, '--version'], { encoding: 'utf8', cwd: tmpdir() });
    expect(r.stdout.trim()).toBe(PKG_VERSION);
    expect(r.status).toBe(0);
  });
});
