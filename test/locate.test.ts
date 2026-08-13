import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { findConfigPath, locateForServer } from '../src/locate.js';

const CONFIG = `
version: 1
gates:
  - name: build
    run: echo hi
    forbid: ["npm ERR!"]
`;

const dirs: string[] = [];
const savedEnv = { config: process.env.RLOOP_CONFIG, repo: process.env.RLOOP_REPO };

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  if (savedEnv.config === undefined) delete process.env.RLOOP_CONFIG;
  else process.env.RLOOP_CONFIG = savedEnv.config;
  if (savedEnv.repo === undefined) delete process.env.RLOOP_REPO;
  else process.env.RLOOP_REPO = savedEnv.repo;
});

function project(name: string): { dir: string; config: string } {
  const dir = mkdtempSync(path.join(tmpdir(), `rloop-${name}-`));
  dirs.push(dir);
  const config = path.join(dir, 'rloop.yaml');
  writeFileSync(config, CONFIG);
  return { dir, config };
}

describe('findConfigPath', () => {
  it('searches upward for the CLI', () => {
    const { dir, config } = project('cli');
    const nested = path.join(dir, 'a', 'b');
    mkdirSync(nested, { recursive: true });
    expect(findConfigPath({ startDir: nested })).toBe(config);
  });

  it('refuses to search upward when disallowed', () => {
    delete process.env.RLOOP_CONFIG;
    const { dir } = project('noscan');
    expect(() => findConfigPath({ startDir: dir, allowUpwardSearch: false })).toThrow(
      /Refusing to search upward/,
    );
  });

  it('errors on a config path that does not exist', () => {
    expect(() => findConfigPath({ configPath: '/nope/rloop.yaml' })).toThrow(/config not found/);
  });
});

describe('locateForServer — multi-project mode (RLOOP_CONFIG unset)', () => {
  it('serves whichever project the call names', async () => {
    delete process.env.RLOOP_CONFIG;
    delete process.env.RLOOP_REPO;
    const a = project('a');
    const b = project('b');

    const ra = await locateForServer({ configPath: a.config });
    const rb = await locateForServer({ configPath: b.config });

    expect(ra.configPath).toBe(a.config);
    expect(rb.configPath).toBe(b.config);
    expect(ra.repoRoot).not.toBe(rb.repoRoot);
  });

  it('demands configPath rather than guessing from cwd', async () => {
    delete process.env.RLOOP_CONFIG;
    await expect(locateForServer({})).rejects.toThrow(/every call must pass configPath/);
  });

  it('defaults repoRoot to the config directory', async () => {
    delete process.env.RLOOP_CONFIG;
    delete process.env.RLOOP_REPO;
    const a = project('root');
    const res = await locateForServer({ configPath: a.config });
    expect(res.repoRoot).toBe(path.resolve(a.dir));
  });
});

describe('locateForServer — pinned mode (RLOOP_CONFIG set)', () => {
  it('serves the pinned project when no configPath is given', async () => {
    const a = project('pinned');
    process.env.RLOOP_CONFIG = a.config;
    const res = await locateForServer({});
    expect(res.configPath).toBe(a.config);
  });

  it('accepts a configPath that matches the pin', async () => {
    const a = project('pinmatch');
    process.env.RLOOP_CONFIG = a.config;
    const res = await locateForServer({ configPath: a.config });
    expect(res.configPath).toBe(a.config);
  });

  it('REFUSES a configPath that points somewhere else', async () => {
    // The config carries the merge policy, so redirecting it swaps that policy.
    const a = project('pinA');
    const b = project('pinB');
    process.env.RLOOP_CONFIG = a.config;
    await expect(locateForServer({ configPath: b.config })).rejects.toThrow(
      /pinned to .* and will not serve/,
    );
  });

  it('refuses a repoRoot that contradicts RLOOP_REPO', async () => {
    const a = project('pinRepoA');
    const b = project('pinRepoB');
    process.env.RLOOP_CONFIG = a.config;
    process.env.RLOOP_REPO = a.dir;
    await expect(locateForServer({ repoRoot: b.dir })).rejects.toThrow(/pinned to repo/);
  });
});
