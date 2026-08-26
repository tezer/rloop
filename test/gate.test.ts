import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { loadConfig } from '../src/config.js';
import { runGates } from '../src/gate.js';
import { HERMETIC_GIT_ENV } from './support/git.js';

const repos: string[] = [];
afterEach(() => {
  for (const r of repos.splice(0)) rmSync(r, { recursive: true, force: true });
});

/** A throwaway git repo with one committed file. */
function makeRepo(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'rloop-test-'));
  repos.push(dir);
  writeFileSync(path.join(dir, 'seed.txt'), 'seed');
  for (const [rel, body] of Object.entries(files)) {
    const full = path.join(dir, rel);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, body);
  }
  const git = (...args: string[]) =>
    execFileSync('git', args, {
      cwd: dir,
      stdio: 'pipe',
      env: { ...process.env, ...HERMETIC_GIT_ENV },
    });
  git('init', '-q');
  git('add', '-A');
  git('commit', '-qm', 'init');
  return dir;
}

const cfgWith = (gates: string) => loadConfig(`version: 1\ngates:\n${gates}`);

describe('runGates', () => {
  it('passes when the required marker prints', async () => {
    const repo = makeRepo();
    const run = await runGates(
      cfgWith(`  - name: ok\n    run: echo DONE_MARKER\n    require: ["^DONE_MARKER$"]\n`),
      { repoRoot: repo },
    );
    expect(run.green).toBe(true);
    expect(run.gates[0].status).toBe('pass');
  });

  it('fails a command that exits 0 but printed a forbidden string', async () => {
    // The whole premise, in miniature.
    const repo = makeRepo();
    const run = await runGates(
      cfgWith(
        `  - name: masked\n    run: 'echo "npm ERR! broken"; exit 0'\n    forbid: ["npm ERR!"]\n`,
      ),
      { repoRoot: repo },
    );
    expect(run.gates[0].exitCode).toBe(0);
    expect(run.gates[0].status).toBe('fail');
    expect(run.gates[0].reason).toBe('forbidden_match');
    expect(run.green).toBe(false);
  });

  it('fails when the command succeeded but never printed proof of work', async () => {
    const repo = makeRepo();
    const run = await runGates(
      cfgWith(
        `  - name: silent\n    run: echo "No test files found, exiting with code 0"\n    require: ["Tests [1-9]"]\n`,
      ),
      { repoRoot: repo },
    );
    expect(run.gates[0].status).toBe('fail');
    expect(run.gates[0].reason).toBe('required_missing');
  });

  it('fails on a bad exit code even when markers look clean', async () => {
    const repo = makeRepo();
    const run = await runGates(
      cfgWith(`  - name: e\n    run: 'echo DONE_MARKER; exit 4'\n    require: ["^DONE_MARKER$"]\n`),
      { repoRoot: repo },
    );
    expect(run.gates[0].status).toBe('fail');
    expect(run.gates[0].reason).toBe('exit_code');
  });

  it('marks a timeout as error, never as skipped or fail', async () => {
    const repo = makeRepo();
    const run = await runGates(
      cfgWith(
        `  - name: hang\n    run: sleep 30\n    require: ["never"]\n    timeout_seconds: 1\n`,
      ),
      { repoRoot: repo },
    );
    expect(run.gates[0].status).toBe('error');
    expect(run.gates[0].reason).toBe('timeout');
    expect(run.green).toBe(false);
  });

  it('voids the verdict when the worktree is dirty', async () => {
    const repo = makeRepo();
    writeFileSync(path.join(repo, 'seed.txt'), 'modified after commit');
    const run = await runGates(
      cfgWith(`  - name: ok\n    run: echo DONE_MARKER\n    require: ["^DONE_MARKER$"]\n`),
      { repoRoot: repo },
    );
    expect(run.gates[0].status).toBe('pass'); // the gate itself was fine
    expect(run.invalidatedBy).toBe('dirty_worktree');
    expect(run.green).toBe(false); // ...but it proved nothing about HEAD
  });

  it('skips a conditional gate when the diff misses its paths', async () => {
    const repo = makeRepo();
    const run = await runGates(
      cfgWith(
        `  - name: cond\n    run: echo DONE_MARKER\n    require: ["^DONE_MARKER$"]\n    when_paths: ["tools/**"]\n`,
      ),
      { repoRoot: repo, changedPaths: ['src/app.ts'] },
    );
    expect(run.gates[0].status).toBe('skipped');
    expect(run.green).toBe(false); // nothing actually ran
  });

  it('runs a conditional gate when the diff matches', async () => {
    const repo = makeRepo();
    const run = await runGates(
      cfgWith(
        `  - name: cond\n    run: echo DONE_MARKER\n    require: ["^DONE_MARKER$"]\n    when_paths: ["tools/**"]\n`,
      ),
      { repoRoot: repo, changedPaths: ['tools/authoring/x.ts'] },
    );
    expect(run.gates[0].status).toBe('pass');
  });

  it('runs a conditional gate when the diff is unknown — fail safe toward checking', async () => {
    const repo = makeRepo();
    const run = await runGates(
      cfgWith(
        `  - name: cond\n    run: echo DONE_MARKER\n    require: ["^DONE_MARKER$"]\n    when_paths: ["tools/**"]\n`,
      ),
      { repoRoot: repo },
    );
    expect(run.gates[0].status).toBe('pass');
  });

  it('never grants green to a partial run, however well it went', async () => {
    const repo = makeRepo();
    const cfg = cfgWith(
      `  - name: a\n    run: echo DONE_MARKER\n    require: ["^DONE_MARKER$"]\n` +
        `  - name: b\n    run: echo DONE_MARKER\n    require: ["^DONE_MARKER$"]\n`,
    );
    const run = await runGates(cfg, { repoRoot: repo, only: ['a'] });
    expect(run.gates).toHaveLength(1);
    expect(run.gates[0].status).toBe('pass');
    expect(run.partial).toBe(true);
    expect(run.green).toBe(false);
  });

  it('flags a gate that passed on negative evidence alone', async () => {
    const repo = makeRepo();
    const run = await runGates(
      cfgWith(`  - name: quiet\n    run: 'true'\n    forbid: ["npm ERR!"]\n`),
      { repoRoot: repo },
    );
    expect(run.gates[0].status).toBe('pass');
    expect(run.gates[0].negativeEvidenceOnly).toBe(true);
  });

  it('runs gates sequentially by default', async () => {
    const repo = makeRepo();
    const marker = path.join(repo, 'order.txt');
    const run = await runGates(
      cfgWith(
        `  - name: first\n    run: 'echo first >> ${marker}; sleep 0.3; echo DONE_MARKER'\n    require: ["^DONE_MARKER$"]\n` +
          `  - name: second\n    run: 'echo second >> ${marker}; echo DONE_MARKER'\n    require: ["^DONE_MARKER$"]\n`,
      ),
      { repoRoot: repo },
    );
    expect(run.green).toBe(true);
    const order = execFileSync('cat', [marker], { encoding: 'utf8' }).trim().split('\n');
    expect(order).toEqual(['first', 'second']);
  });
});
