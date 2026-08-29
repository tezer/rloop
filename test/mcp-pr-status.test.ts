import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { HERMETIC_GIT_ENV } from './support/git.js';

/**
 * Exercises the MCP `pr_status` tool's `degraded` field end to end.
 *
 * `test/mcp.test.ts` only enumerates tool names and hints — it never
 * actually invokes `pr_status` or `pr_merge`, so `degraded` (added by this
 * PR) is entirely unexercised through the server. `pr_status` itself
 * (src/pr.ts) accepts a `forge` override for exactly this kind of test —
 * see `test/reviewers/report.test.ts`'s `FakeForge` — but the MCP tool's
 * input schema is JSON-only (a real MCP client can never hand the server a
 * live JS object), so that lever is not reachable through `client.callTool`.
 * `src/pr.ts::forgeFor` constructs the real adapter with
 * `new GitHubForge(cfg.forge.slug)`, so mocking that one constructor is the
 * only place a fake can be substituted while still driving the request
 * through the actual server, actual tool schema, and actual JSON-RPC
 * round-trip — no `gh` CLI, no live GitHub PR required.
 */
vi.mock('../src/forge/github.js', () => {
  class GitHubForge {
    async getPullRequest() {
      return {
        number: 9,
        baseRef: 'main',
        headSha: 'd'.repeat(40),
        state: 'OPEN',
        isDraft: false,
        title: 'Fake PR for pr_status degraded coverage',
        url: 'https://example.invalid/pr/9',
      };
    }
    async listReviews() {
      return [];
    }
    async listReviewThreads() {
      return [];
    }
    async requestReviewer(): Promise<never> {
      throw new Error('not used by pr_status');
    }
    async replyToThread(): Promise<never> {
      throw new Error('not used by pr_status');
    }
    async resolveThread(): Promise<never> {
      throw new Error('not used by pr_status');
    }
    async merge(): Promise<never> {
      throw new Error('not used by pr_status');
    }
  }
  return { GitHubForge };
});

// Imported AFTER the mock so the server's transitive `forgeFor` -> `new
// GitHubForge(...)` resolves to the fake above.
const { createServer } = await import('../src/mcp/server.js');

let client: Client;
const repos: string[] = [];
const saved = { config: process.env.RLOOP_CONFIG, repo: process.env.RLOOP_REPO };

/** A throwaway git repo with an rloop.yaml whose one reviewer is under test's control. */
function project(reviewerRun: string): { dir: string; config: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'rloop-mcp-prstatus-'));
  repos.push(dir);
  const config = path.join(dir, 'rloop.yaml');
  writeFileSync(
    config,
    `
version: 1
forge:
  provider: github
  slug: acme/widgets
gates:
  - name: build
    run: 'true'
    forbid: ["npm ERR!"]
merge:
  enabled: false
  allowed_base_branches: [main]
reviewers:
  - name: local
    kind: command
    run: ${reviewerRun}
`,
  );
  writeFileSync(path.join(dir, 'seed.txt'), 'seed');
  const env = { ...process.env, ...HERMETIC_GIT_ENV };
  for (const args of [['init', '-q'], ['add', '-A'], ['commit', '-qm', 'init']]) {
    execFileSync('git', args, { cwd: dir, stdio: 'pipe', env });
  }
  return { dir, config };
}

let clean: { dir: string; config: string };
let broken: { dir: string; config: string };

beforeAll(async () => {
  delete process.env.RLOOP_CONFIG;
  delete process.env.RLOOP_REPO;

  // Echoes RLOOP_HEAD_SHA back with no findings — a command reviewer that
  // runs clean regardless of what SHA the fake forge's PR carries.
  clean = project(`node -e "process.stdout.write(JSON.stringify({sha:process.env.RLOOP_HEAD_SHA,findings:[]}))"`);
  // A binary that does not exist: the command reviewer cannot even be
  // spawned, so its status is `unavailable` and the review stream degrades.
  broken = project('definitely-not-a-real-binary-xyz');

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

describe('pr_status — degraded field', () => {
  it('is null when nothing is degraded', async () => {
    const out = payload(
      await client.callTool({
        name: 'pr_status',
        arguments: { pr: 9, configPath: clean.config, skipGates: true },
      }),
    );
    expect(out.degraded).toBeNull();
    expect(out.reviewerReports).toHaveLength(1);
    expect(out.reviewerReports[0].status).toBe('clean');
  });

  it('names SKIPPED gates as the reason, not a --only flag nobody passed', async () => {
    // `prStatus` models `skipGates` as a void run so the decision blocks.
    // It used to leave `invalidatedBy: null` and lean on `partial: true`,
    // which merge-gate renders as "run was partial (--only), which is never a
    // merge verdict" — naming a flag the operator never used and sending them
    // to look for it. Driven through the real tool rather than a hand-built
    // GateRunResult, so it pins the WIRING in src/pr.ts and not just the
    // wording in merge-gate.ts.
    const out = payload(
      await client.callTool({
        name: 'pr_status',
        arguments: { pr: 9, configPath: clean.config, skipGates: true },
      }),
    );
    const message = out.decision.blockers.find(
      (b: { code: string }) => b.code === 'gates_not_green',
    )?.message;
    // The FULL sentence, not `/skipped/`. That pattern was vacuous: deleting
    // the special case falls through to `run was void (gates_skipped)`, which
    // interpolates the enum member name and matches `/skipped/` too — so the
    // assertion passed with the behaviour it names removed.
    expect(message).toContain('gates were skipped, so there is no gate evidence at all');
    expect(message).not.toMatch(/--only|run was void/);

    // The SIBLING blocker still fires, and must. A first pass at this
    // SUPPRESSED `sha_mismatch_gates` on the skipped path, which opened a
    // merge-permitting hole for any direct caller of the exported
    // `evaluateMergeGate` (green: true + gates_skipped + mismatched sha →
    // allowed, zero blockers). The fix is to correct the SENTENCE and keep
    // the blocker.
    const codes = out.decision.blockers.map((b: { code: string }) => b.code);
    expect(codes).toContain('gates_not_green');
    expect(codes).toContain('sha_mismatch_gates');
    const mismatch = out.decision.blockers.find(
      (b: { code: string }) => b.code === 'sha_mismatch_gates',
    )?.message;
    expect(mismatch).toContain('Gates were skipped');
    expect(mismatch).not.toMatch(/Gates ran on 0000000/);
  });

  it('is populated when a command reviewer cannot run', async () => {
    const out = payload(
      await client.callTool({
        name: 'pr_status',
        arguments: { pr: 9, configPath: broken.config, skipGates: true },
      }),
    );
    expect(out.degraded).not.toBeNull();
    expect(out.degraded.reason).toBe('unavailable');
    expect(out.degraded.provider).toBe('local');
    expect(out.decision.blockers.map((b: { code: string }) => b.code)).toContain('reviewer_degraded');
  });
});
