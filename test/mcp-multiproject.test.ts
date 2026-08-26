import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { createServer } from '../src/mcp/server.js';
import { HERMETIC_GIT_ENV } from './support/git.js';

/**
 * One server, two repositories, no RLOOP_CONFIG — each call names its project.
 * This is the shape an agent working across several repos in one session hits.
 */

let client: Client;
const repos: string[] = [];
const saved = { config: process.env.RLOOP_CONFIG, repo: process.env.RLOOP_REPO };

/** A git repo whose single gate prints a project-specific marker. */
function project(name: string, marker: string): { dir: string; config: string } {
  const dir = mkdtempSync(path.join(tmpdir(), `rloop-mp-${name}-`));
  repos.push(dir);
  const config = path.join(dir, 'rloop.yaml');
  writeFileSync(
    config,
    `version: 1\ngates:\n  - name: build\n    run: echo "${marker}"\n    require: ["^${marker}$"]\n`,
  );
  writeFileSync(path.join(dir, 'seed.txt'), name);
  const env = { ...process.env, ...HERMETIC_GIT_ENV };
  for (const args of [['init', '-q'], ['add', '-A'], ['commit', '-qm', name]]) {
    execFileSync('git', args, { cwd: dir, stdio: 'pipe', env });
  }
  return { dir, config };
}

let alpha: { dir: string; config: string };
let beta: { dir: string; config: string };

beforeAll(async () => {
  delete process.env.RLOOP_CONFIG;
  delete process.env.RLOOP_REPO;

  alpha = project('alpha', 'ALPHA_OK');
  beta = project('beta', 'BETA_OK');

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'test', version: '0' });
  await Promise.all([createServer().connect(serverTransport), client.connect(clientTransport)]);
});

afterAll(() => {
  for (const r of repos.splice(0)) rmSync(r, { recursive: true, force: true });
  if (saved.config === undefined) delete process.env.RLOOP_CONFIG;
  else process.env.RLOOP_CONFIG = saved.config;
  if (saved.repo === undefined) delete process.env.RLOOP_REPO;
  else process.env.RLOOP_REPO = saved.repo;
});

const payload = (res: unknown) =>
  JSON.parse((res as { content: { text: string }[] }).content[0].text);

describe('mcp multi-project mode', () => {
  it('advertises configPath and repoRoot on every tool', async () => {
    const { tools } = await client.listTools();
    for (const tool of tools) {
      const props = (tool.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
      expect(Object.keys(props), tool.name).toEqual(expect.arrayContaining(['configPath', 'repoRoot']));
    }
  });

  it('runs each project’s own gates from a single server', async () => {
    const a = payload(await client.callTool({ name: 'gate_run', arguments: { configPath: alpha.config } }));
    const b = payload(await client.callTool({ name: 'gate_run', arguments: { configPath: beta.config } }));

    expect(a.green).toBe(true);
    expect(b.green).toBe(true);
    // Different commits, so the verdicts are genuinely bound to different repos.
    expect(a.sha).not.toBe(b.sha);
    expect(a.gates[0].evidence.requiredMatched[0].text).toBe('ALPHA_OK');
    expect(b.gates[0].evidence.requiredMatched[0].text).toBe('BETA_OK');
  });

  it('reports the right project from check', async () => {
    const out = payload(await client.callTool({ name: 'check', arguments: { configPath: beta.config } }));
    expect(out.configPath).toBe(beta.config);
    expect(out.repoRoot).toBe(path.resolve(beta.dir));
  });

  it('refuses a call that names no project, rather than guessing from cwd', async () => {
    const res = (await client.callTool({ name: 'gate_run', arguments: {} })) as {
      isError?: boolean;
      content: { text: string }[];
    };
    expect(res.isError).toBe(true);
    expect(payload(res).error).toMatch(/every call must pass configPath/);
  });

  it('reads any project’s config through the resource template', async () => {
    const { resourceTemplates } = await client.listResourceTemplates();
    expect(resourceTemplates.map((t) => t.uriTemplate)).toContain('rloop://config{+configPath}');

    for (const p of [alpha, beta]) {
      const read = await client.readResource({ uri: `rloop://config${p.config}` });
      const body = JSON.parse((read.contents[0] as { text: string }).text);
      expect(body.configPath).toBe(p.config);
      expect(body.repoRoot).toBe(path.resolve(p.dir));
    }
  });

  it('advertises no resource it could not actually serve', async () => {
    const { resources } = await client.listResources();
    const uris = resources.map((r) => r.uri);
    // Enumerating arbitrary repos is impossible, so nothing concrete is listed…
    expect(uris).not.toContain(`rloop://config${alpha.config}`);
    // …and the pinned-only URI is not offered at all, since it could never resolve.
    expect(uris).not.toContain('rloop://config');
  });

  it('crossing repoRoot and configPath runs gates where told', async () => {
    // Config from alpha, repo root beta: the gate command comes from alpha's
    // config but executes in beta's checkout, so the SHA is beta's.
    const out = payload(
      await client.callTool({
        name: 'gate_run',
        arguments: { configPath: alpha.config, repoRoot: beta.dir },
      }),
    );
    const betaSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: beta.dir, encoding: 'utf8' }).trim();
    expect(out.sha).toBe(betaSha);
  });
});
