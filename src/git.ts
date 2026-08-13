import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, encoding: 'utf8' });
  return stdout.trim();
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
