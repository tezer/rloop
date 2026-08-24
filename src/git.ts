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
  // GIT_CONFIG_* is the same hazard one variable over, and was missing from the
  // first version of this list. Demonstrated: GIT_CONFIG_GLOBAL pointing at a
  // config with a `url.<other>.insteadOf` rewrite redirects fetch and ls-remote
  // TOGETHER, so a gate that cross-checks one against the other agrees with
  // itself while reading a foreign remote. KEY_n/VALUE_n need no entry — git
  // reads them only when COUNT is set.
  GIT_CONFIG_COUNT: undefined,
  GIT_CONFIG_GLOBAL: undefined,
  GIT_CONFIG_SYSTEM: undefined,
  // UNPINNED, deliberately: deleting this line leaves the suite green.
  // Its hazard is SUPPRESSION, not redirection — an inherited
  // GIT_CONFIG_NOSYSTEM=1 makes git ignore /etc/gitconfig, dropping whatever an
  // admin put there. The `url.<mirror>.insteadOf` payload the other four cases
  // use cannot express that, and a test cannot write a real system config. It
  // stays in the scrub because it belongs to the family; do not read its
  // presence as evidence anything checks it.
  GIT_CONFIG_NOSYSTEM: undefined,
  // The one a first GIT_CONFIG_* pass misses. GIT_CONFIG_PARAMETERS is what
  // `git -c k=v` propagates to subprocesses, and it is an INDEPENDENT channel
  // that GIT_CONFIG_COUNT does not gate — so "KEY_n/VALUE_n need no entry"
  // covers only part of the family. Demonstrated: a
  // `url.<foreign>.insteadOf=<origin>` payload through this variable redirects
  // fetch and ls-remote together, so a gate cross-checking one against the
  // other agrees with itself against a foreign remote.
  GIT_CONFIG_PARAMETERS: undefined,
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
