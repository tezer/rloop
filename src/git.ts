import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Git environment variables that override where git looks, unset for every
 * call rloop makes.
 *
 * `cwd` is NOT sufficient. `GIT_DIR` outranks it: with `GIT_DIR` exported,
 * `git -C /repo/a rev-parse HEAD` answers about repo B. That is not exotic —
 * git exports `GIT_DIR` to every hook it runs, so any rloop invocation from a
 * hook inherits it, and agents commonly work from `git worktree` checkouts
 * beside a shared main clone.
 *
 * The consequence is specific and bad. rloop reads HEAD to bind a verdict to a
 * commit, reads `status` to refuse a dirty tree, and runs gates whose own
 * scripts read git. Under a leaked `GIT_DIR` all of them agree — on the wrong
 * repository. The verdict is internally consistent and describes code that is
 * not being merged. Nothing downstream can detect it, because every signal it
 * would check is derived from the same poisoned environment.
 *
 * Setting each to `undefined` removes it from the child's environment rather
 * than setting it empty; an empty `GIT_DIR` is itself a valid override meaning
 * "the current directory".
 */
export const GIT_ENV_OVERRIDES = Object.freeze({
  GIT_DIR: undefined,
  GIT_WORK_TREE: undefined,
  GIT_INDEX_FILE: undefined,
  GIT_COMMON_DIR: undefined,
  GIT_OBJECT_DIRECTORY: undefined,
  GIT_ALTERNATE_OBJECT_DIRECTORIES: undefined,
  GIT_CEILING_DIRECTORIES: undefined,
  GIT_NAMESPACE: undefined,
});

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...GIT_ENV_OVERRIDES },
  });
  return stdout.trim();
}

/**
 * The working tree root git resolves for `cwd`, with the overrides stripped.
 *
 * Exported so callers can assert they are where they think they are. A
 * scrubbed environment stops git being *redirected*; it does not prove `cwd`
 * is inside the repository the caller meant.
 */
export async function toplevel(cwd: string): Promise<string> {
  return git(['rev-parse', '--show-toplevel'], cwd);
}

/**
 * Throw unless `cwd` resolves to the git repository rooted at `cwd`.
 *
 * Called once before a gate run. Catches the case scrubbing cannot: a
 * `repoRoot` that is a subdirectory of a repo, or not a repo at all, where
 * every later `headSha`/`isDirty` would quietly answer about an ancestor.
 * Compares real paths, since a symlinked checkout is otherwise a false alarm.
 */
export async function assertRepoRoot(cwd: string): Promise<void> {
  let root: string;
  try {
    root = await toplevel(cwd);
  } catch (err) {
    throw new Error(
      `not a git repository: ${cwd} (${String((err as Error).message).split('\n')[0]})`,
    );
  }
  const { realpath } = await import('node:fs/promises');
  const [a, b] = await Promise.all([realpath(root), realpath(cwd)]);
  if (path.resolve(a) !== path.resolve(b)) {
    throw new Error(
      `repo root mismatch: git resolves ${cwd} to the repository at ${root}. ` +
        `Point --repo at the repository root — a verdict bound to the wrong tree ` +
        `describes code that is not being merged.`,
    );
  }
}

export async function headSha(cwd: string): Promise<string> {
  return git(['rev-parse', 'HEAD'], cwd);
}

/**
 * True when tracked files are modified or the index is dirty.
 *
 * A gate run against a dirty tree proves nothing about the commit it claims
 * to verify: the code that passed is not the code that would merge.
 */
export async function isDirty(cwd: string): Promise<boolean> {
  const status = await git(['status', '--porcelain', '--untracked-files=no'], cwd);
  return status.length > 0;
}

/**
 * Repo-relative paths changed between `baseRef` and HEAD.
 *
 * Uses three-dot diff against the REMOTE ref by default — a local branch ref
 * can be stale, which would hand every consumer a diff bloated with work that
 * already merged.
 */
export async function changedPaths(baseRef: string, cwd: string): Promise<string[]> {
  const out = await git(['diff', '--name-only', `${baseRef}...HEAD`], cwd);
  return out ? out.split('\n').filter(Boolean) : [];
}
