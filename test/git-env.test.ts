import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runCommand } from '../src/exec.js';
import { assertRepoRoot, headSha, isDirty } from '../src/git.js';

/**
 * `GIT_DIR` outranks `cwd`. With it exported, `git -C /repo/a rev-parse HEAD`
 * answers about repo B — so every signal rloop uses to bind a verdict to a
 * commit can be redirected at once, and they all agree, on the wrong repo.
 *
 * This is not a contrived environment. Git exports `GIT_DIR` to every hook it
 * runs, so an rloop invoked from a hook inherits it, and agents routinely work
 * from `git worktree` checkouts beside a shared clone.
 *
 * Reproduced live before the fix: a gate script certified one repository's
 * version against another's history and exited 0.
 */
let repoA: string;
let repoB: string;

function git(args: string[], cwd: string, env?: Record<string, string>) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: env ? { ...process.env, ...env } : process.env,
  }).trim();
}

function makeRepo(marker: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'rloop-gitenv-'));
  git(['init', '-q', '.'], dir);
  git(['config', 'user.email', 't@e.st'], dir);
  git(['config', 'user.name', 'tester'], dir);
  writeFileSync(path.join(dir, 'marker.txt'), marker);
  git(['add', '-A'], dir);
  git(['commit', '-qm', `commit for ${marker}`], dir);
  return dir;
}

beforeAll(() => {
  repoA = makeRepo('repo-a');
  repoB = makeRepo('repo-b');
});

afterAll(() => {
  for (const d of [repoA, repoB]) if (d) rmSync(d, { recursive: true, force: true });
});

describe('git calls under a leaked GIT_DIR', () => {
  it('reads HEAD from the requested repo, not the one GIT_DIR points at', async () => {
    const trueA = git(['rev-parse', 'HEAD'], repoA);
    const trueB = git(['rev-parse', 'HEAD'], repoB);
    expect(trueA).not.toBe(trueB); // distinct repos, or the test proves nothing

    // Demonstrate the hazard is real with an unscrubbed call...
    expect(git(['rev-parse', 'HEAD'], repoA, { GIT_DIR: path.join(repoB, '.git') })).toBe(trueB);

    // ...then that rloop is immune to it.
    process.env.GIT_DIR = path.join(repoB, '.git');
    try {
      expect(await headSha(repoA)).toBe(trueA);
    } finally {
      delete process.env.GIT_DIR;
    }
  });

  it('reports dirtiness of the requested repo, not the redirected one', async () => {
    // Dirty B only. An unscrubbed isDirty(repoA) would report B's dirt and
    // void a verdict for the wrong reason — or, with the repos swapped, miss
    // real dirt entirely.
    writeFileSync(path.join(repoB, 'marker.txt'), 'changed');
    process.env.GIT_DIR = path.join(repoB, '.git');
    process.env.GIT_WORK_TREE = repoB;
    try {
      expect(await isDirty(repoA)).toBe(false);
    } finally {
      delete process.env.GIT_DIR;
      delete process.env.GIT_WORK_TREE;
      git(['checkout', '--', 'marker.txt'], repoB);
    }
  });

  it('does not pass the leak through to gate subprocesses', async () => {
    // Scrubbing rloop's own calls is not enough: gates run scripts that read
    // git themselves. This is the exact path that produced the forged green —
    // the gate script, not rloop, was the thing reading the wrong repo.
    //
    // Capture the expectation BEFORE poisoning the environment. Computing it
    // afterwards runs the helper under the same leak and yields repoB's sha,
    // so the test would compare two wrong answers and fail on a correct fix.
    const trueA = git(['rev-parse', 'HEAD'], repoA);
    process.env.GIT_DIR = path.join(repoB, '.git');
    try {
      const out = await runCommand('git rev-parse HEAD', { cwd: repoA, timeoutMs: 15_000 });
      expect(out.output.trim()).toBe(trueA);
    } finally {
      delete process.env.GIT_DIR;
    }
  });

  it('still lets a gate set GIT_* deliberately via its own env block', async () => {
    // The scrub must not become a cage: `env:` is applied after the overrides
    // precisely so an unusual gate can opt back in.
    const out = await runCommand('git rev-parse HEAD', {
      cwd: repoA,
      timeoutMs: 15_000,
      env: { GIT_DIR: path.join(repoB, '.git') },
    });
    expect(out.output.trim()).toBe(git(['rev-parse', 'HEAD'], repoB));
  });
});

describe('assertRepoRoot', () => {
  it('accepts the repository root', async () => {
    await expect(assertRepoRoot(repoA)).resolves.toBeUndefined();
  });

  it('rejects a subdirectory, where HEAD would silently describe an ancestor', async () => {
    const sub = path.join(repoA, 'packages', 'thing');
    mkdirSync(sub, { recursive: true });
    await expect(assertRepoRoot(sub)).rejects.toThrow(/repo root mismatch/);
  });

  it('rejects a path that is not a repository at all', async () => {
    const plain = mkdtempSync(path.join(tmpdir(), 'rloop-norepo-'));
    try {
      await expect(assertRepoRoot(plain)).rejects.toThrow(/not a git repository|repo root mismatch/);
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });
});
