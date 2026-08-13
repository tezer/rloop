import path from 'node:path';

import type { RloopConfig } from './config.js';
import { runCommand } from './exec.js';
import { headSha, isDirty } from './git.js';

export interface PreflightResult {
  name: string;
  ok: boolean;
  /** The configured `message`, shown when the check fails. */
  message: string;
  detail: string;
  exitCode: number | null;
}

export interface PreflightRunResult {
  ok: boolean;
  checks: PreflightResult[];
  /** Committer/worktree problems, which are checked separately from `checks`. */
  blockers: string[];
}

/**
 * Environment checks that must hold before any gate is worth running.
 *
 * These exist to turn a confusing red gate into a clear operator message.
 * Docker being down does not mean the code is broken — it means the gate
 * cannot render a verdict at all, and merging is off the table either way.
 *
 * Preflight uses exit codes deliberately: these are small, direct commands
 * (`docker info`, `git config`), not npm script chains, so nothing is masking
 * anything. The no-trust rule applies to build/test runners, not to every
 * process on earth.
 */
export async function runPreflight(
  cfg: RloopConfig,
  opts: { repoRoot: string; requireCleanWorktree?: boolean },
): Promise<PreflightRunResult> {
  const checks: PreflightResult[] = [];

  for (const check of cfg.preflight) {
    const outcome = await runCommand(check.run, {
      cwd: path.resolve(opts.repoRoot),
      timeoutMs: check.timeout_seconds * 1000,
    });

    const ok = !outcome.timedOut && !outcome.spawnError && outcome.exitCode === 0;
    checks.push({
      name: check.name,
      ok,
      message: check.message,
      detail: outcome.timedOut
        ? `timed out after ${check.timeout_seconds}s`
        : (outcome.spawnError?.message ?? outcome.output.trim().split('\n').slice(-1)[0] ?? ''),
      exitCode: outcome.exitCode,
    });
  }

  const blockers: string[] = [];

  if (cfg.committer) {
    const name = await runCommand('git config user.name', {
      cwd: opts.repoRoot,
      timeoutMs: 10_000,
    });
    const email = await runCommand('git config user.email', {
      cwd: opts.repoRoot,
      timeoutMs: 10_000,
    });
    const actualName = name.output.trim();
    const actualEmail = email.output.trim();
    if (actualName !== cfg.committer.name || actualEmail !== cfg.committer.email) {
      blockers.push(
        `committer identity is "${actualName} <${actualEmail}>", config requires ` +
          `"${cfg.committer.name} <${cfg.committer.email}>". Refusing to proceed — ` +
          `an unattended loop must not author under another identity.`,
      );
    }
  }

  if (opts.requireCleanWorktree && (await isDirty(opts.repoRoot))) {
    blockers.push(
      `worktree is dirty. A gate run against uncommitted changes proves nothing ` +
        `about ${(await headSha(opts.repoRoot)).slice(0, 7)} — the code that passed is not the code that would merge.`,
    );
  }

  return {
    ok: checks.every((c) => c.ok) && blockers.length === 0,
    checks,
    blockers,
  };
}
