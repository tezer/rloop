import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { createServer } from '../src/mcp/server.js';

let repo: string;
let client: Client;

const CONFIG = `
version: 1
forge:
  provider: github
  slug: acme/widgets
gates:
  - name: build
    run: echo "Compiled successfully" && echo "Route (app)"
    require: ["Compiled successfully", "^Route \\\\("]
    forbid: ["npm ERR!"]
  - name: quiet
    run: 'true'
    forbid: ["npm ERR!"]
merge:
  enabled: false
  allowed_base_branches: [staging]
`;

beforeAll(async () => {
  repo = mkdtempSync(path.join(tmpdir(), 'rloop-mcp-'));
  writeFileSync(path.join(repo, 'rloop.yaml'), CONFIG);
  writeFileSync(path.join(repo, 'seed.txt'), 'seed');
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 't',
    GIT_AUTHOR_EMAIL: 't@e',
    GIT_COMMITTER_NAME: 't',
    GIT_COMMITTER_EMAIL: 't@e',
  };
  for (const args of [['init', '-q'], ['add', '-A'], ['commit', '-qm', 'init']]) {
    execFileSync('git', args, { cwd: repo, stdio: 'pipe', env });
  }

  // The server resolves config per call from these env vars — the same path an
  // MCP host uses, since it launches the server with an arbitrary cwd.
  process.env.RLOOP_CONFIG = path.join(repo, 'rloop.yaml');
  process.env.RLOOP_REPO = repo;

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'test', version: '0' });
  await Promise.all([createServer().connect(serverTransport), client.connect(clientTransport)]);
});

afterAll(() => {
  delete process.env.RLOOP_CONFIG;
  delete process.env.RLOOP_REPO;
  if (repo) rmSync(repo, { recursive: true, force: true });
});

const payload = (res: unknown) => {
  const r = res as { content: { type: string; text: string }[] };
  return JSON.parse(r.content[0].text);
};

describe('mcp server', () => {
  it('advertises the expected tools', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'check',
      'gate_run',
      'pr_merge',
      'pr_reply_and_resolve',
      'pr_status',
      'pr_threads',
      'preflight',
    ]);
  });

  it('marks pr_merge destructive and the read tools read-only', async () => {
    const { tools } = await client.listTools();
    const by = Object.fromEntries(tools.map((t) => [t.name, t.annotations ?? {}]));

    // The one irreversible operation must be flagged as such — hosts gate on this.
    expect(by.pr_merge.destructiveHint).toBe(true);
    expect(by.pr_merge.readOnlyHint).toBe(false);

    for (const name of ['check', 'preflight', 'pr_status', 'pr_threads']) {
      expect(by[name].readOnlyHint, name).toBe(true);
      expect(by[name].destructiveHint, name).toBe(false);
    }

    // gate_run executes commands, so it is not read-only — but it does not
    // destroy anything either.
    expect(by.gate_run.readOnlyHint).toBe(false);
    expect(by.gate_run.destructiveHint).toBe(false);
  });

  it('check returns gates, merge posture and warnings', async () => {
    const out = payload(await client.callTool({ name: 'check', arguments: {} }));
    expect(out.gates.map((g: { name: string }) => g.name)).toEqual(['build', 'quiet']);
    expect(out.merge).toEqual({ enabled: false, allowedBaseBranches: ['staging'] });
    // `quiet` has no require patterns, so it should be flagged.
    expect(out.warnings.some((w: { gate?: string }) => w.gate === 'quiet')).toBe(true);
  });

  it('gate_run returns a green verdict with evidence', async () => {
    const out = payload(await client.callTool({ name: 'gate_run', arguments: {} }));
    expect(out.green).toBe(true);
    expect(out.partial).toBe(false);
    expect(out.sha).toMatch(/^[0-9a-f]{40}$/);
    const build = out.gates.find((g: { name: string }) => g.name === 'build');
    expect(build.status).toBe('pass');
    expect(build.evidence.requiredMatched).toHaveLength(2);
  });

  it('gate_run with `only` reports partial and withholds green', async () => {
    const out = payload(await client.callTool({ name: 'gate_run', arguments: { only: ['build'] } }));
    expect(out.gates).toHaveLength(1);
    expect(out.partial).toBe(true);
    expect(out.green).toBe(false);
  });

  it('returns isError with a readable message instead of throwing', async () => {
    const res = (await client.callTool({
      name: 'gate_run',
      arguments: { base: 'refs/definitely-not-a-ref' },
    })) as { isError?: boolean; content: { text: string }[] };
    expect(res.isError).toBe(true);
    expect(JSON.parse(res.content[0].text).error).toMatch(/definitely-not-a-ref|unknown revision|fatal/i);
  });

  it('exposes the effective config as a resource', async () => {
    const { resources } = await client.listResources();
    expect(resources.map((r) => r.uri)).toContain('rloop://config');

    const read = await client.readResource({ uri: 'rloop://config' });
    const body = JSON.parse(read.contents[0].text as string);
    expect(body.config.merge.enabled).toBe(false);
    expect(body.repoRoot).toBe(repo);
  });

  it('lists the pinned config under the template too', async () => {
    const { resources } = await client.listResources();
    expect(resources.map((r) => r.uri)).toContain(
      `rloop://config${path.join(repo, 'rloop.yaml')}`,
    );
  });

  it('serves the pinned config through the template', async () => {
    const uri = `rloop://config${path.join(repo, 'rloop.yaml')}`;
    const body = JSON.parse((await client.readResource({ uri })).contents[0].text as string);
    expect(body.repoRoot).toBe(repo);
  });

  it('REFUSES another project’s config through the template — a resource is not a side door', async () => {
    // The pin exists so a caller cannot swap the merge policy. Reading around
    // it via a resource URI would defeat that.
    await expect(
      client.readResource({ uri: 'rloop://config/somewhere/else/rloop.yaml' }),
    ).rejects.toThrow(/pinned to .* and will not serve/);
  });

  it('serves the loop procedure as a prompt', async () => {
    const { prompts } = await client.listPrompts();
    expect(prompts.map((p) => p.name)).toContain('loop');

    const got = await client.getPrompt({ name: 'loop', arguments: { pr: '812' } });
    const text = (got.messages[0].content as { text: string }).text;
    expect(text).toContain('PR #812');

    // Collapse wrapping — the prompt is hard-wrapped markdown, so these
    // phrases legitimately span line breaks.
    const flat = text.replace(/\s+/g, ' ');
    expect(flat).toContain('Absence of a verdict is never approval');
    expect(flat).toMatch(/classify up/i);
    expect(flat).toContain('Never resolve a thread you have not answered');
  });
});
