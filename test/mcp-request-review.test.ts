import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { HERMETIC_GIT_ENV } from './support/git.js';

/**
 * The `pr_request_review` tool, which is the way out of `reviewer_stale`.
 *
 * Before it existed the merge gate could enter that state and not leave: it
 * voided the old verdict (correctly), told the operator to "re-request review",
 * and shipped nothing that does so. Every fix-and-push cycle in an autonomous
 * loop had to leave rloop entirely.
 *
 * The case that makes this worth testing rather than assuming: **the request
 * endpoint can report success and add nobody.** Measured against GitHub Copilot
 * on tezer/rloop — requests landed three times on PR #4 on 2026-08-25, and on
 * 2026-08-26 four different calls on PR #5 (REST bare, REST `[bot]`, REST
 * `Copilot`, and the GraphQL `requestReviews` mutation) all returned success
 * and produced no timeline event, no pending request, and no review in five
 * minutes. So the tool MUST read the result back. A version that trusts the
 * call would report success forever on exactly the PRs that are stuck.
 *
 * `HEAD_SHA` is what the fake PR reports; `REVIEWED_SHA` is what the fake
 * reviewer has already reviewed. Those being different is the stale case.
 */
const HEAD_SHA = 'd'.repeat(40);
const OTHER_SHA = 'e'.repeat(40);
const LOGIN = 'copilot-pull-request-reviewer';

/** Mutated per test to pick which forge behaviour is being exercised. */
const forgeState = {
  requestLands: true,
  reviewedSha: null as string | null,
};

vi.mock('../src/forge/github.js', () => {
  class GitHubForge {
    async getPullRequest() {
      return {
        number: 9,
        baseRef: 'main',
        headSha: HEAD_SHA,
        state: 'OPEN',
        isDraft: false,
        title: 'Fake PR',
        url: 'https://example.invalid/pr/9',
      };
    }
    async requestReviewer(_n: number, login: string) {
      // The whole point: returning [] IS a successful HTTP call that added
      // nobody. It does not throw, and nothing about the response says "no".
      return forgeState.requestLands ? [login] : [];
    }
    async listReviews() {
      return forgeState.reviewedSha
        ? [{ author: LOGIN, state: 'COMMENTED', sha: forgeState.reviewedSha, submittedAt: '' }]
        : [];
    }
    async listReviewThreads() {
      return [];
    }
    async replyToThread(): Promise<never> {
      throw new Error('not used');
    }
    async resolveThread(): Promise<never> {
      throw new Error('not used');
    }
    async merge(): Promise<never> {
      throw new Error('not used');
    }
  }
  return { GitHubForge };
});

const { createServer } = await import('../src/mcp/server.js');

let client: Client;
const repos: string[] = [];
const saved = { config: process.env.RLOOP_CONFIG, repo: process.env.RLOOP_REPO };
let forgeProject: string;
let commandOnlyProject: string;

function project(reviewersBlock: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'rloop-mcp-reqrev-'));
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
${reviewersBlock}
`,
  );
  writeFileSync(path.join(dir, 'seed.txt'), 'seed');
  const env = { ...process.env, ...HERMETIC_GIT_ENV };
  for (const args of [['init', '-q'], ['add', '-A'], ['commit', '-qm', 'init']]) {
    execFileSync('git', args, { cwd: dir, stdio: 'pipe', env });
  }
  return config;
}

beforeAll(async () => {
  delete process.env.RLOOP_CONFIG;
  delete process.env.RLOOP_REPO;

  forgeProject = project(
    `  - name: copilot\n    kind: forge\n    login: ${LOGIN}\n    required_state: any_verdict`,
  );
  commandOnlyProject = project(`  - name: local\n    kind: command\n    run: 'true'`);

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

beforeEach(() => {
  forgeState.requestLands = true;
  forgeState.reviewedSha = null;
});

const call = (configPath: string) =>
  client.callTool({ name: 'pr_request_review', arguments: { pr: 9, configPath } });

const payload = (res: unknown) =>
  JSON.parse((res as { content: { text: string }[] }).content[0].text);

describe('pr_request_review', () => {
  it('reports the request as landed when the forge actually added the reviewer', async () => {
    const out = payload(await call(forgeProject));
    expect(out.allRequested).toBe(true);
    expect(out.results[0]).toMatchObject({ login: LOGIN, ok: true, moot: false });
    expect(out.headSha).toBe(HEAD_SHA);
    // No advice when nothing is wrong — the advice is a signal, not decoration.
    expect(out.advice).toBeUndefined();
  });

  /**
   * The finding this tool exists for. A success response that adds nobody must
   * not read as success, and the operator must be told the next move is a
   * decision rather than another retry — "re-request review" on its own sends
   * them back to the same endpoint.
   */
  it('reports NOT ok when the request silently no-ops, and names the stuck reviewer', async () => {
    forgeState.requestLands = false;
    const out = payload(await call(forgeProject));
    expect(out.allRequested).toBe(false);
    expect(out.results[0]).toMatchObject({ login: LOGIN, ok: false, moot: false });
    expect(out.stuck).toEqual([LOGIN]);
    expect(out.advice).toMatch(/reported success and added nobody/);
  });

  /**
   * A landed review at the current head drains the pending-request list, so the
   * request "fails" for a reason that is actually success. Distinguished from
   * the case above by `moot`, or a loop retries forever against a reviewer that
   * already answered.
   */
  it('treats a review already at head as success, flagged moot', async () => {
    forgeState.requestLands = false;
    forgeState.reviewedSha = HEAD_SHA;
    const out = payload(await call(forgeProject));
    expect(out.results[0]).toMatchObject({ ok: true, moot: true });
    expect(out.allRequested).toBe(true);
  });

  /**
   * The other side of moot: a review against a DIFFERENT commit is the stale
   * case, and must not count. Without this, `moot` could be implemented as
   * "any review exists" and the suite would not notice.
   */
  it('does not treat a review against another commit as success', async () => {
    forgeState.requestLands = false;
    forgeState.reviewedSha = OTHER_SHA;
    const out = payload(await call(forgeProject));
    expect(out.results[0]).toMatchObject({ ok: false, moot: false });
  });

  /** A `kind: command` reviewer is re-run by pr_status; there is nobody to ask. */
  it('refuses when no forge reviewer is configured, rather than reporting success', async () => {
    const res = (await call(commandOnlyProject)) as { isError?: boolean; content: { text: string }[] };
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/no `kind: forge` reviewers configured/);
  });
});
