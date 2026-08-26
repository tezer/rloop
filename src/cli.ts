#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { collectWarnings, loadConfig, type RloopConfig } from './config.js';
import type { Forge } from './forge/types.js';
import { runGates, unknownGateNames } from './gate.js';
import { changedPaths } from './git.js';
import { STUCK_REVIEWER_ADVICE } from './merge-gate.js';
import { forgeFor, mergeIfAllowed, prStatus, requestReviewerVerified } from './pr.js';
import { runPreflight } from './preflight.js';
import { formatPreflight, formatPrStatus, formatRun, formatWarnings } from './report.js';
import { replyAndResolve, unresolvedThreads } from './threads.js';

/**
 * Exit codes are the contract for anything wrapping this CLI:
 *   0  every gate that ran passed
 *   1  a gate failed — the code under test is broken
 *   2  the run could not render a verdict — bad config, preflight blocker,
 *      timeout, dirty tree. The SETUP is broken, not necessarily the code.
 *
 * 1 and 2 are kept apart on purpose: a caller retries neither, but a human
 * fixes very different things.
 */
const EXIT = { pass: 0, fail: 1, unresolved: 2 } as const;

const CONFIG_NAMES = ['rloop.yaml', 'rloop.yml', '.rloop.yaml', '.rloop.yml'];

/**
 * Read from package.json rather than hardcoded, so it cannot drift from what
 * npm actually shipped. The MCP server already does this; a pinned version is
 * load-bearing (`.mcp.json` pins an exact package, config shapes are
 * version-gated) and a binary that cannot state its own version leaves the
 * operator inferring it from which warnings happen to appear.
 */
const PACKAGE_VERSION: string = createRequire(import.meta.url)('../package.json').version;

const USAGE = `rloop — evidence-based merge gate

Usage:
  rloop check                 Validate config and print warnings. Runs nothing.
  rloop preflight             Run environment checks only.
  rloop gate                  Run preflight, then the gates. Prints a verdict.

  rloop pr status <N>         Evaluate every merge condition. Read-only.
  rloop pr request-review <N> Ask every configured forge reviewer to review the
                              current head, and verify the request landed.
                              This is the way out of \`reviewer_stale\`.
  rloop pr threads <N>        List review threads and their resolved state.
  rloop pr reply <N>          Reply to a thread, then resolve it. Never one
                              without the other. Needs --thread and --body.
  rloop pr merge <N>          Re-check every condition, then merge if all hold.

Options:
  -c, --config <path>   Config file. Default: nearest rloop.yaml searching upward.
  -C, --repo <path>     Repo root. Default: the config file's directory.
      --base <ref>      Base ref for when_paths, e.g. origin/staging.
                        Omitted: conditional gates all run.
      --only <name>     Run one gate. Repeatable. Never yields a merge verdict.
      --json            Emit JSON instead of text.
      --no-preflight    Skip preflight (gate only). Use when debugging a gate.
      --allow-dirty     Do not treat a dirty worktree as a preflight blocker.
                        The run is still marked VOID — this only changes where
                        it stops.
      --skip-gates      pr commands only: evaluate review state without running
                        gates. Always BLOCKED — "I didn't check" is not "green".
      --thread <id>     pr reply: GraphQL thread id from \`rloop pr threads\`.
      --body <text>     pr reply: the reply text. Required, non-empty.
  -V, --version         Print the rloop version and exit.
  -h, --help            This.

Exit: 0 pass · 1 gate failed · 2 no verdict (config/preflight/timeout/void)
`;

async function findConfig(explicit: string | undefined): Promise<string> {
  if (explicit) {
    const resolved = path.resolve(explicit);
    if (!existsSync(resolved)) throw new Error(`config not found: ${resolved}`);
    return resolved;
  }
  let dir = process.cwd();
  for (;;) {
    for (const name of CONFIG_NAMES) {
      const candidate = path.join(dir, name);
      if (existsSync(candidate)) return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    `no config found. Looked for ${CONFIG_NAMES.join(', ')} from ${process.cwd()} upward.\n` +
      `Start from an example: https://github.com/tezer/rloop/tree/main/examples`,
  );
}

async function load(explicit: string | undefined): Promise<{
  cfg: RloopConfig;
  configPath: string;
}> {
  const configPath = await findConfig(explicit);
  const cfg = loadConfig(await readFile(configPath, 'utf8'), configPath);
  return { cfg, configPath };
}

const short = (sha: string) => sha.slice(0, 7);

function emitJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

interface PrCommandArgs {
  cfg: RloopConfig;
  repoRoot: string;
  positionals: string[];
  flags: {
    json?: boolean;
    'skip-gates'?: boolean;
    thread?: string;
    body?: string;
  };
}

async function runPrCommand({ cfg, repoRoot, positionals, flags }: PrCommandArgs): Promise<number> {
  const sub = positionals[1];
  const prNumber = Number(positionals[2]);

  if (!['status', 'threads', 'reply', 'merge', 'request-review'].includes(sub ?? '')) {
    process.stderr.write(
      `rloop pr: expected status|threads|reply|merge|request-review, got "${sub ?? ''}"\n`,
    );
    return EXIT.unresolved;
  }
  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    process.stderr.write(`rloop pr ${sub}: expected a PR number, got "${positionals[2] ?? ''}"\n`);
    return EXIT.unresolved;
  }

  let forge: Forge;
  try {
    forge = forgeFor(cfg);
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`);
    return EXIT.unresolved;
  }

  if (sub === 'request-review') {
    const logins = cfg.reviewers.filter((r) => r.kind === 'forge').map((r) => r.login);
    if (logins.length === 0) {
      process.stderr.write(
        'no `kind: forge` reviewers configured, so there is nobody to request. ' +
          'A `kind: command` reviewer is re-run by `rloop pr status`, not requested.\n',
      );
      return EXIT.unresolved;
    }

    const pr = await forge.getPullRequest(prNumber);
    const results = [];
    for (const login of logins) {
      const res = await requestReviewerVerified(cfg, {
        prNumber,
        login,
        headSha: pr.headSha,
        forge,
      });
      results.push({ login, ...res });
    }

    if (flags.json) emitJson({ headSha: pr.headSha, results });
    else {
      for (const r of results) {
        if (r.moot) process.stdout.write(`= ${r.login}: already reviewed ${short(pr.headSha)}\n`);
        else if (r.ok) process.stdout.write(`✓ ${r.login}: request pending\n`);
        else process.stderr.write(`✗ ${r.login}: ${STUCK_REVIEWER_ADVICE}\n`);
      }
    }
    // Anything short of "landed or moot" is a failure. The endpoint answers 200
    // and adds nobody, so an unchecked call here is the exact shape of bug
    // `requestReviewerVerified` exists to catch — do not soften it to 0.
    return results.every((r) => r.ok) ? EXIT.pass : EXIT.fail;
  }

  if (sub === 'threads') {
    const threads = await forge.listReviewThreads(prNumber);
    if (flags.json) emitJson({ threads });
    else {
      const open = unresolvedThreads(threads);
      for (const t of threads) {
        process.stdout.write(
          `${t.isResolved ? '✓' : '✗'} ${t.id}  ${t.path ?? '(no path)'}  by ${t.firstCommentAuthor}` +
            `${t.isOutdated ? '  (outdated)' : ''}\n    ${t.firstCommentBody.split('\n')[0].slice(0, 100)}\n`,
        );
      }
      process.stdout.write(`\n${open.length} unresolved of ${threads.length}\n`);
    }
    return EXIT.pass;
  }

  if (sub === 'reply') {
    if (!flags.thread || !flags.body) {
      process.stderr.write('rloop pr reply needs --thread <id> and --body <text>\n');
      return EXIT.unresolved;
    }
    const threads = await forge.listReviewThreads(prNumber);
    const target = threads.find((t) => t.id === flags.thread);
    if (!target) {
      process.stderr.write(`no thread ${flags.thread} on PR #${prNumber}\n`);
      return EXIT.unresolved;
    }
    try {
      const res = await replyAndResolve(forge, prNumber, target, flags.body);
      if (flags.json) emitJson(res);
      else process.stdout.write(`replied (${res.replyId}) and resolved ${res.threadId}\n`);
      return EXIT.pass;
    } catch (err) {
      // The thread is deliberately left unresolved on any failure here.
      if (flags.json) emitJson({ ok: false, error: (err as Error).message });
      else process.stderr.write(`${(err as Error).message}\n`);
      return EXIT.unresolved;
    }
  }

  if (sub === 'status') {
    const status = await prStatus(cfg, {
      repoRoot,
      prNumber,
      forge,
      skipGates: flags['skip-gates'],
    });
    if (flags.json) emitJson(status);
    else process.stdout.write(`${formatPrStatus(status)}\n`);
    return status.decision.allowed ? EXIT.pass : EXIT.fail;
  }

  // merge
  const result = await mergeIfAllowed(cfg, { repoRoot, prNumber, forge });
  if (flags.json) emitJson(result);
  else if (result.merged) {
    process.stdout.write(`merged PR #${prNumber} (verified MERGED via API)\n`);
  } else {
    process.stdout.write(`${formatPrStatus(result.status)}\n\nNOT MERGED.\n`);
  }
  return result.merged ? EXIT.pass : EXIT.fail;
}

export async function main(argv: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        config: { type: 'string', short: 'c' },
        repo: { type: 'string', short: 'C' },
        base: { type: 'string' },
        only: { type: 'string', multiple: true },
        json: { type: 'boolean', default: false },
        'no-preflight': { type: 'boolean', default: false },
        'allow-dirty': { type: 'boolean', default: false },
        'skip-gates': { type: 'boolean', default: false },
        thread: { type: 'string' },
        body: { type: 'string' },
        version: { type: 'boolean', short: 'V', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
    });
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n\n${USAGE}`);
    return EXIT.unresolved;
  }

  const { values: flags, positionals } = parsed;
  const command = positionals[0];

  if (flags.version || command === 'version') {
    process.stdout.write(`${PACKAGE_VERSION}\n`);
    return EXIT.pass;
  }

  if (flags.help || command === 'help') {
    process.stdout.write(USAGE);
    return EXIT.pass;
  }

  /**
   * No subcommand is NOT `gate`.
   *
   * It used to be, and that is a bad default for this tool specifically: `gate`
   * runs arbitrary commands out of the config, and `-C` defaults to the CONFIG
   * FILE's directory rather than the cwd — so a bare `rloop` typed in the wrong
   * shell does real, slow work against a tree the operator was not thinking
   * about. Reported after exactly that: a bare invocation expecting usage text
   * spent 208 seconds building a shared checkout other agents were using.
   *
   * `check` would be the safe default if one were wanted. Nothing needs one.
   */
  if (!command) {
    process.stderr.write(USAGE);
    return EXIT.unresolved;
  }

  if (!['check', 'preflight', 'gate', 'pr'].includes(command)) {
    process.stderr.write(`unknown command "${command}"\n\n${USAGE}`);
    return EXIT.unresolved;
  }

  let cfg: RloopConfig;
  let configPath: string;
  try {
    ({ cfg, configPath } = await load(flags.config));
  } catch (err) {
    if (flags.json) emitJson({ ok: false, error: (err as Error).message });
    else process.stderr.write(`${(err as Error).message}\n`);
    return EXIT.unresolved;
  }

  const repoRoot = path.resolve(flags.repo ?? path.dirname(configPath));
  const warnings = collectWarnings(cfg);

  if (command === 'check') {
    if (flags.json) {
      emitJson({ ok: true, configPath, gates: cfg.gates.map((g) => g.name), warnings });
    } else {
      process.stdout.write(`config OK: ${configPath}\n`);
      process.stdout.write(`gates: ${cfg.gates.map((g) => g.name).join(', ')}\n`);
      process.stdout.write(
        `merge: ${cfg.merge.enabled ? `enabled → ${cfg.merge.allowed_base_branches.join(', ')}` : 'disabled (dry run)'}\n`,
      );
      if (warnings.length) process.stdout.write(`\n${formatWarnings(warnings)}\n`);
    }
    return EXIT.pass;
  }

  if (command === 'pr') {
    return runPrCommand({ cfg, repoRoot, positionals, flags });
  }

  // Preflight — shared by `preflight` and `gate`.
  if (command === 'preflight' || !flags['no-preflight']) {
    const pre = await runPreflight(cfg, {
      repoRoot,
      requireCleanWorktree: !flags['allow-dirty'],
    });

    if (command === 'preflight') {
      if (flags.json) emitJson(pre);
      else {
        process.stdout.write(`rloop preflight\n\n${formatPreflight(pre)}\n`);
        process.stdout.write(pre.ok ? '\nready\n' : '\nNOT READY — gates cannot render a verdict.\n');
      }
      return pre.ok ? EXIT.pass : EXIT.unresolved;
    }

    if (!pre.ok) {
      if (flags.json) emitJson({ green: false, stage: 'preflight', preflight: pre });
      else {
        process.stderr.write(`rloop preflight\n\n${formatPreflight(pre)}\n`);
        process.stderr.write('\nNOT READY — gates not run. Do not merge.\n');
      }
      return EXIT.unresolved;
    }
  }

  if (flags.only) {
    const unknown = unknownGateNames(cfg, flags.only);
    if (unknown.length) {
      const msg = `--only names no configured gate: ${unknown.join(', ')}. Known: ${cfg.gates
        .map((g) => g.name)
        .join(', ')}`;
      if (flags.json) emitJson({ green: false, error: msg });
      else process.stderr.write(`${msg}\n`);
      return EXIT.unresolved;
    }
  }

  let diff: string[] | undefined;
  if (flags.base) {
    try {
      diff = await changedPaths(flags.base, repoRoot);
    } catch (err) {
      const msg = `could not diff against "${flags.base}": ${(err as Error).message}`;
      if (flags.json) emitJson({ green: false, error: msg });
      else process.stderr.write(`${msg}\n`);
      return EXIT.unresolved;
    }
  }

  const run = await runGates(cfg, {
    repoRoot,
    changedPaths: diff,
    only: flags.only,
    // Stream progress so a 20-minute gate is not a silent terminal.
    onGateSettled: flags.json
      ? undefined
      : (g) => process.stderr.write(`  … ${g.name}: ${g.status}\n`),
  });

  if (flags.json) emitJson({ ...run, warnings });
  else {
    process.stdout.write(`\n${formatRun(run)}\n`);
    if (warnings.length) process.stdout.write(`\n${formatWarnings(warnings)}\n`);
  }

  const errored = run.gates.some((g) => g.status === 'error');
  if (run.invalidatedBy || errored) return EXIT.unresolved;
  if (run.gates.some((g) => g.status === 'fail')) return EXIT.fail;
  if (!run.partial && !run.gates.some((g) => g.status === 'pass')) return EXIT.unresolved;
  return EXIT.pass;
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    // Message, not stack. A stack here reads as a crash even when the cause is
    // an ordinary operator state the code words carefully (a repo with no
    // commits, say), and the frames are rloop's internals either way. The stack
    // is still one env var away for anyone actually debugging rloop.
    const e = err as Error;
    process.stderr.write(
      process.env.RLOOP_DEBUG
        ? `rloop: ${e.stack ?? String(err)}\n`
        : `rloop: ${e.message ?? String(err)}\n  (set RLOOP_DEBUG=1 for a stack trace)\n`,
    );
    process.exitCode = EXIT.unresolved;
  });
