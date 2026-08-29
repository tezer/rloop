import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { writeDiff } from '../git.js';

/**
 * The diff a command reviewer reviews, on disk, with the facts about it that
 * decide whether its verdict can be trusted.
 */
export interface DiffContext {
  /** The ref the diff was taken against, e.g. `origin/staging`. */
  baseRef: string;
  /** Absolute path to a file holding `git diff <baseRef>...HEAD`. */
  file: string;
  bytes: number;
  /** True when a `diff_max_bytes` cap cut it short. See `command.ts`. */
  truncated: boolean;
  /** Remove the temp directory. Safe to call twice. */
  cleanup(): void;
}

/**
 * Write the diff a reviewer will read, and describe it.
 *
 * This exists because the four steps between "a model that reviews code" and
 * "a document rloop accepts" are not equally dangerous, and the dangerous
 * ones are the ones rloop is uniquely able to get right. rloop knows the base
 * branch (it is the PR's) and it knows the head; a provider re-deriving
 * either has to guess, and a wrong guess is silent — the diff still parses,
 * the review still completes, the verdict is confidently about the wrong
 * code.
 *
 * Assumes the base ref is already up to date. `collectReviewerReports` runs
 * `fetchBranch` once for the whole invocation before calling this, so the
 * fetch is not repeated per reviewer; see there for why its failure is fatal
 * rather than degrading.
 *
 * THROWS rather than returning a partial context. The caller turns that into
 * `unavailable`, which blocks — never into a review of an unknown base.
 *
 * The diff is written to a fresh temp directory rather than into the repo.
 * Anything written inside the worktree would make it dirty, and rloop refuses
 * to run against a dirty worktree — so a reviewer would poison the very next
 * invocation.
 */
export async function prepareDiff(opts: {
  repoRoot: string;
  /** Branch name without the remote prefix, e.g. `staging`. */
  baseBranch: string;
  remote?: string;
  maxBytes?: number | null;
}): Promise<DiffContext> {
  const remote = opts.remote ?? 'origin';
  const baseRef = `${remote}/${opts.baseBranch}`;

  const dir = mkdtempSync(path.join(tmpdir(), 'rloop-diff-'));
  const file = path.join(dir, 'diff.patch');
  let removed = false;
  const cleanup = () => {
    if (removed) return;
    removed = true;
    rmSync(dir, { recursive: true, force: true });
  };

  try {
    const { bytes, truncated } = await writeDiff(
      baseRef,
      opts.repoRoot,
      file,
      opts.maxBytes ?? null,
    );
    return { baseRef, file, bytes, truncated, cleanup };
  } catch (err) {
    cleanup();
    throw err;
  }
}
