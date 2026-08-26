#!/usr/bin/env node
import { createRequire } from 'node:module';
import { realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { collectWarnings } from '../config.js';
import { runGates } from '../gate.js';
import { changedPaths } from '../git.js';
import { locateForServer, type LocatedConfig } from '../locate.js';
import { STUCK_REVIEWER_ADVICE } from '../merge-gate.js';
import { forgeFor, mergeIfAllowed, prStatus, requestReviewerVerified } from '../pr.js';
import { runPreflight } from '../preflight.js';
import { replyAndResolve } from '../threads.js';

/**
 * The version an MCP host displays for this server, taken from package.json so
 * it cannot drift from the published one. A hardcoded literal here already
 * disagreed with a release once, which is worse than useless: a host reporting
 * a stale version sends people to read the wrong changelog.
 *
 * Both entry points sit two directories below the package root
 * (`src/mcp/server.ts` and `dist/mcp/server.js`), so one path serves dev and
 * published alike. npm always ships package.json regardless of `files`.
 */
const PACKAGE_VERSION: string = createRequire(import.meta.url)('../../package.json').version;

/**
 * MCP wrapper around the rloop core.
 *
 * This file is deliberately thin: it parses arguments, calls a core function,
 * and serializes the result. Every rule that matters — reply-before-resolve,
 * absence-is-not-approval, the base-branch allowlist, SHA agreement — lives in
 * the core and is unit-tested there. Duplicating any of it here would create a
 * second implementation to keep in sync, and the copy that drifts is always the
 * one enforcing the safety property.
 */

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * Every tool accepts these, so one server can serve many repositories.
 *
 * When the server was launched with RLOOP_CONFIG it is pinned to that project
 * and a differing configPath is refused — see `locateForServer`.
 */
const projectArgs = {
  configPath: z
    .string()
    .optional()
    .describe(
      "Absolute path to this project's rloop.yaml. Required unless the server was launched " +
        'with RLOOP_CONFIG, in which case it is pinned and this must match or be omitted.',
    ),
  repoRoot: z
    .string()
    .optional()
    .describe("Absolute path to the repository root. Defaults to the config file's directory."),
};

interface ProjectArgs {
  configPath?: string;
  repoRoot?: string;
}

/** Config is resolved per call, so editing rloop.yaml does not need a restart. */
async function ctx(args: ProjectArgs): Promise<LocatedConfig> {
  return locateForServer(args);
}

function ok(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] };
}

/** Shared body for both the pinned resource and the by-path template. */
function configBody(uri: string, located: LocatedConfig) {
  return {
    contents: [
      {
        uri,
        mimeType: 'application/json',
        text: JSON.stringify(
          {
            configPath: located.configPath,
            repoRoot: located.repoRoot,
            config: located.cfg,
            warnings: collectWarnings(located.cfg),
          },
          null,
          2,
        ),
      },
    ],
  };
}

function fail(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return {
    isError: true,
    content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: message }, null, 2) }],
  };
}

/**
 * Build the server without connecting it.
 *
 * Kept separate from the stdio wiring so tests can drive it over an in-memory
 * transport. A module that connects to stdio as an import side effect cannot be
 * imported by anything else, including its own tests.
 */
export function createServer(): McpServer {
  const server = new McpServer({ name: 'rloop', version: PACKAGE_VERSION });

  // ── read-only ────────────────────────────────────────────────────────────────

  server.registerTool(
    'check',
    {
      title: 'Validate rloop config',
      description:
        'Parse and validate the rloop config. Returns the gate names, merge posture, and any ' +
        'warnings (notably gates that pass on absence-of-errors alone). Runs no commands.',
      inputSchema: { ...projectArgs },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ configPath: cp, repoRoot: rr }) => {
      try {
        const { cfg, configPath, repoRoot } = await ctx({ configPath: cp, repoRoot: rr });
        return ok({
          configPath,
          repoRoot,
          gates: cfg.gates.map((g) => ({ name: g.name, conditional: Boolean(g.when_paths) })),
          merge: { enabled: cfg.merge.enabled, allowedBaseBranches: cfg.merge.allowed_base_branches },
          warnings: collectWarnings(cfg),
        });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    'preflight',
    {
      title: 'Run environment checks',
      description:
        'Run the configured environment checks plus the committer-identity and clean-worktree ' +
        'checks. Use this to distinguish "the code is broken" from "the gates cannot run at all".',
      inputSchema: {
        ...projectArgs,
        allowDirty: z
          .boolean()
          .optional()
          .describe('Do not treat a dirty worktree as a blocker. The gate verdict is still void.'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ allowDirty, configPath, repoRoot: rr }) => {
      try {
        const { cfg, repoRoot } = await ctx({ configPath, repoRoot: rr });
        return ok(await runPreflight(cfg, { repoRoot, requireCleanWorktree: !allowDirty }));
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    'gate_run',
    {
      title: 'Run the verification gates',
      description:
        'Run the configured build/test gates and return a verdict with EVIDENCE — which patterns ' +
        'matched on which log lines. Exit codes are not trusted: a gate can fail with exit 0. ' +
        'The verdict is bound to one commit and is void if the worktree is dirty or HEAD moves. ' +
        'A run with `only` set is never a merge verdict.',
      inputSchema: {
        ...projectArgs,
        only: z.array(z.string()).optional().describe('Run just these gates. Forces a partial (non-merge) verdict.'),
        base: z.string().optional().describe('Base ref for path-conditional gates, e.g. origin/staging.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ only, base, configPath, repoRoot: rr }) => {
      try {
        const { cfg, repoRoot } = await ctx({ configPath, repoRoot: rr });
        let diff: string[] | undefined;
        if (base) diff = await changedPaths(base, repoRoot);
        const run = await runGates(cfg, { repoRoot, changedPaths: diff, only });
        return ok(run);
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    'pr_status',
    {
      title: 'Evaluate every merge condition',
      description:
        'Fetch the PR, its reviews and its review threads, run the gates, and evaluate all merge ' +
        'conditions at once. Read-only. Returns every blocker, not just the first. A missing ' +
        'review is reported as a blocker — absence of a verdict is never approval.',
      inputSchema: {
        ...projectArgs,
        pr: z.number().int().positive(),
        skipGates: z
          .boolean()
          .optional()
          .describe('Evaluate review state without running gates. Always blocked: not checking is not passing.'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    async ({ pr, skipGates, configPath, repoRoot: rr }) => {
      try {
        const { cfg, repoRoot } = await ctx({ configPath, repoRoot: rr });
        const status = await prStatus(cfg, { repoRoot, prNumber: pr, skipGates });
        return ok({ ...status, degraded: status.degradation });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    'pr_threads',
    {
      title: 'List review threads',
      description:
        'List every review thread on a PR with its resolved state, paged to exhaustion. Use the ' +
        'returned thread id with pr_reply_and_resolve.',
      inputSchema: { ...projectArgs, pr: z.number().int().positive() },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    async ({ pr, configPath, repoRoot }) => {
      try {
        const { cfg } = await ctx({ configPath, repoRoot });
        const threads = await forgeFor(cfg).listReviewThreads(pr);
        return ok({
          threads,
          unresolved: threads.filter((t) => !t.isResolved).length,
        });
      } catch (err) {
        return fail(err);
      }
    },
  );

  // ── writes ───────────────────────────────────────────────────────────────────

  /**
   * The way out of `reviewer_stale` — and the reason the loop prompt can say
   * "re-request the external reviewer" and mean a tool call.
   *
   * Without this the loop leaves rloop on every single fix-and-push cycle: the
   * merge gate voids the old verdict (correctly), tells the operator to
   * re-request, and offers nothing that does it. The forge alias normalisation
   * this needs already lives in `forge/types.ts`.
   *
   * It reports failure rather than papering over it. See STUCK_REVIEWER_ADVICE.
   */
  server.registerTool(
    'pr_request_review',
    {
      title: 'Request a review at the current head, and verify it landed',
      description:
        'Ask every configured `kind: forge` reviewer to review the PR head, then READ BACK ' +
        'whether the request actually landed — the endpoint answers 200 without adding the ' +
        'reviewer, so an unchecked call is indistinguishable from a slow reviewer ten minutes ' +
        'later. Call this after every push. `moot: true` means that reviewer has already ' +
        'reviewed the current head, which is success. `ok: false` means the reviewer will not ' +
        'review again and the next move is an operator decision, not a retry.',
      inputSchema: { ...projectArgs, pr: z.number().int().positive() },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ pr, configPath, repoRoot }) => {
      try {
        const { cfg } = await ctx({ configPath, repoRoot });
        const forge = forgeFor(cfg);
        const logins = cfg.reviewers.filter((r) => r.kind === 'forge').map((r) => r.login);
        if (logins.length === 0) {
          return fail(
            new Error(
              'no `kind: forge` reviewers configured, so there is nobody to request. A ' +
                '`kind: command` reviewer is re-run by pr_status, not requested.',
            ),
          );
        }
        const { headSha } = await forge.getPullRequest(pr);
        const results = [];
        for (const login of logins) {
          results.push({
            login,
            ...(await requestReviewerVerified(cfg, { prNumber: pr, login, headSha, forge })),
          });
        }
        const stuck = results.filter((r) => !r.ok).map((r) => r.login);
        return ok({
          headSha,
          results,
          allRequested: stuck.length === 0,
          ...(stuck.length ? { stuck, advice: STUCK_REVIEWER_ADVICE } : {}),
        });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    'pr_reply_and_resolve',
    {
      title: 'Reply to a review thread, then resolve it',
      description:
        'Post a reply to a review thread and resolve it — in that order, never one without the ' +
        'other. If the reply does not land, the thread is deliberately left unresolved so it keeps ' +
        'blocking the merge. Say what changed and in which commit, or rebut with evidence.',
      inputSchema: {
        ...projectArgs,
        pr: z.number().int().positive(),
        threadId: z.string().min(1).describe('GraphQL thread id from pr_threads.'),
        body: z.string().min(1).describe('The reply text. An empty reply is not an answer.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ pr, threadId, body, configPath, repoRoot }) => {
      try {
        const { cfg } = await ctx({ configPath, repoRoot });
        const forge = forgeFor(cfg);
        const thread = (await forge.listReviewThreads(pr)).find((t) => t.id === threadId);
        if (!thread) throw new Error(`no thread ${threadId} on PR #${pr}`);
        return ok(await replyAndResolve(forge, pr, thread, body));
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    'pr_merge',
    {
      title: 'Merge the PR, but only if every condition holds',
      description:
        'Re-derive every merge condition from scratch, then merge only if all of them pass. ' +
        'Takes no override or force flag by design — a caller may be holding a stale verdict. ' +
        'Refuses unless the base branch is on the configured allowlist and merging is enabled. ' +
        'Verifies via the API that the merge actually landed. IRREVERSIBLE when it succeeds.',
      inputSchema: { ...projectArgs, pr: z.number().int().positive() },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ pr, configPath, repoRoot: rr }) => {
      try {
        const { cfg, repoRoot } = await ctx({ configPath, repoRoot: rr });
        const result = await mergeIfAllowed(cfg, { repoRoot, prNumber: pr });
        return ok({
          merged: result.merged,
          blockers: result.decision.blockers,
          sha: result.decision.sha,
          degraded: result.status.degradation,
        });
      } catch (err) {
        return fail(err);
      }
    },
  );

  // ── resources ────────────────────────────────────────────────────────────────

  // Registered only when a project is pinned. In multi-project mode this URI
  // could never resolve, and advertising a resource that always errors is
  // worse than not offering it — a client browsing the list would try it.
  if (process.env.RLOOP_CONFIG) {
    server.registerResource(
      'config',
      'rloop://config',
      {
        title: 'Effective rloop config (pinned project)',
        description:
          'The resolved config for the PINNED project, so the agent can read the rules it is ' +
          'being held to. This URI carries no arguments; to name a project explicitly use ' +
          'rloop://config{/absolute/path/to/rloop.yaml} instead.',
        mimeType: 'application/json',
      },
      async (uri) => configBody(uri.href, await ctx({})),
    );
  }

  /**
   * Read any project's config by path: `rloop://config/abs/path/to/rloop.yaml`.
   *
   * `{+configPath}` uses reserved expansion so the variable may contain the
   * slashes of an absolute path — a plain `{configPath}` stops at the first
   * one and never matches.
   *
   * Reads route through the same `locateForServer` as the tools, so a pinned
   * server refuses to serve another project's config here too. A resource is
   * not a side door around the pin.
   */
  server.registerResource(
    'config-by-path',
    new ResourceTemplate('rloop://config{+configPath}', {
      list: async () => {
        // Arbitrary repositories cannot be enumerated, so this lists the pinned
        // config when there is one and nothing otherwise. An empty list is
        // honest here: the server genuinely does not know what projects exist.
        const pinned = process.env.RLOOP_CONFIG;
        if (!pinned) return { resources: [] };
        return {
          resources: [
            {
              uri: `rloop://config${path.resolve(pinned)}`,
              name: path.basename(path.dirname(path.resolve(pinned))),
              mimeType: 'application/json',
            },
          ],
        };
      },
      complete: {
        configPath: async (value) => {
          const pinned = process.env.RLOOP_CONFIG;
          if (!pinned) return [];
          const resolved = path.resolve(pinned);
          return resolved.startsWith(value) ? [resolved] : [];
        },
      },
    }),
    {
      title: 'rloop config by path',
      description:
        "Read a specific project's resolved config and warnings. The path variable is the " +
        'absolute path to that project\'s rloop.yaml. On a pinned server, only the pinned ' +
        'config is served; any other path is refused.',
      mimeType: 'application/json',
    },
    async (uri, variables) => {
      const raw = variables.configPath;
      const configPath = Array.isArray(raw) ? raw[0] : raw;
      if (!configPath) throw new Error(`no config path in ${uri.href}`);
      return configBody(uri.href, await ctx({ configPath }));
    },
  );

  // ── prompts ──────────────────────────────────────────────────────────────────

  /**
   * The judgment half, shipped as an MCP prompt rather than a host-specific
   * skill file. Every MCP host can surface this, so the procedure lives in one
   * place instead of being re-authored per harness.
   */
  server.registerPrompt(
    'loop',
    {
      title: 'Run the review-fix-merge loop',
      description:
        'The procedure for driving a PR from pushed to merged-or-blocked: parallel review streams, ' +
        'severity classification, the fix loop, thread resolution, and when to stop and ask.',
      argsSchema: { pr: z.string().optional().describe('PR number, if you already know it.') },
    },
    async ({ pr }) => {
      const body = await readFile(path.join(PKG_ROOT, 'prompts', 'loop.md'), 'utf8');
      const header = pr ? `Drive PR #${pr} through the loop below.\n\n` : '';
      return {
        messages: [{ role: 'user' as const, content: { type: 'text' as const, text: header + body } }],
      };
    },
  );

  return server;
}

/**
 * Was this file executed directly, rather than imported?
 *
 * The obvious implementation — `path.resolve(argv[1]) === fileURLToPath(url)`
 * — is wrong the moment the package is installed, and wrong in the silent
 * direction. `npm install` writes every `bin` entry as a SYMLINK:
 *
 *     node_modules/.bin/rloop-mcp -> ../rloop/dist/mcp/server.js
 *
 * `argv[1]` is then the symlink path while `import.meta.url` is the real file
 * (Node resolves module specifiers through symlinks by default). `path.resolve`
 * normalizes `..` and makes paths absolute; it does not touch symlinks. So the
 * comparison fails, the transport is never connected, and the server exits 0
 * having spoken to nobody — an MCP host reports only that the process died.
 *
 * Comparing real paths is what the check meant all along. Caught by installing
 * the packed tarball and running the binary, which is the only way this
 * surfaces: it works perfectly from a clone.
 */
function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  const self = fileURLToPath(import.meta.url);
  try {
    return realpathSync(entry) === realpathSync(self);
  } catch {
    // A deleted or unreadable entry path is not a reason to start serving.
    return path.resolve(entry) === self;
  }
}

/** Connect over stdio only when executed directly, never on import. */
if (isMainModule()) {
  await createServer().connect(new StdioServerTransport());
}
