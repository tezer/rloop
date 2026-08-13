import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * Characterisation tests for the bug this whole tool exists to defeat.
 *
 * These assert what the LOCAL npm actually does, so the claims in the README
 * and the example configs stay honest. If a future npm fixes the masking,
 * these fail loudly and the docs get corrected — rather than the project
 * shipping folklore about a bug that no longer exists.
 *
 * Measured on npm 9.2.0: exit codes propagate from a standalone package, and
 * are masked to 0 for ANY package that is a workspace member — including a
 * bare `npm run` executed from inside the member's own directory. That last
 * case is the one people get wrong; `cd`-ing in does not escape the masking.
 */

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function scratch(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'rloop-npm-'));
  dirs.push(dir);
  return dir;
}

/** Exit code of a shell command, without throwing. */
function exitCodeOf(command: string, cwd: string): number {
  try {
    execFileSync('bash', ['-c', command], { cwd, stdio: 'pipe' });
    return 0;
  } catch (err) {
    return (err as { status?: number }).status ?? -1;
  }
}

const npmVersion = execFileSync('npm', ['-v'], { encoding: 'utf8' }).trim();
const npmMajor = Number(npmVersion.split('.')[0]);

function standalonePkg(): string {
  const dir = scratch();
  writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: 'solo', version: '1.0.0', scripts: { boom: 'exit 7' } }),
  );
  return dir;
}

function workspaceRepo(): string {
  const dir = scratch();
  writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: 'root', private: true, workspaces: ['child'] }),
  );
  mkdirSync(path.join(dir, 'child'));
  writeFileSync(
    path.join(dir, 'child', 'package.json'),
    JSON.stringify({ name: 'child', version: '1.0.0', scripts: { boom: 'exit 7' } }),
  );
  return dir;
}

describe(`npm ${npmVersion} exit-code propagation`, () => {
  it('propagates from a standalone package', () => {
    expect(exitCodeOf('npm run boom', standalonePkg())).toBe(7);
  });

  it.skipIf(npmMajor !== 9)('masks a --workspace invocation (npm 9)', () => {
    expect(exitCodeOf('npm run boom --workspace=child', workspaceRepo())).toBe(0);
  });

  it.skipIf(npmMajor !== 9)(
    'masks a bare npm run from inside the workspace member — cd does not escape it (npm 9)',
    () => {
      const repo = workspaceRepo();
      expect(exitCodeOf('npm run boom', path.join(repo, 'child'))).toBe(0);
    },
  );

  it.skipIf(npmMajor !== 9)('makes `cmd && echo MARKER` unsafe inside a workspace (npm 9)', () => {
    const repo = workspaceRepo();
    // The marker prints even though the script failed — which is exactly why
    // examples/next-vitest.yaml invokes tsc directly instead of through npm.
    const out = execFileSync(
      'bash',
      ['-c', 'npm run boom --workspace=child >/dev/null 2>&1 && echo MARKER || true'],
      { cwd: repo, encoding: 'utf8' },
    );
    expect(out).toContain('MARKER');
  });
});
