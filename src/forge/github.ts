import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type {
  Forge,
  MergeOptions,
  PullRequest,
  ReviewState,
  ReviewThread,
  ReviewVerdict,
} from './types.js';

const execFileAsync = promisify(execFile);

/**
 * GitHub adapter, implemented over the `gh` CLI.
 *
 * Shelling out to `gh` is deliberate: rloop never reads, stores, or forwards a
 * token. Auth is whatever `gh auth status` already established, so a leak in
 * this tool cannot expose a credential it never held.
 *
 * Every call uses execFile with an argv array — never a shell string. Review
 * bodies are arbitrary text that has passed through a model and a diff; putting
 * that through `bash -c` would be a command-injection hole.
 */
export class GitHubForge implements Forge {
  constructor(private readonly slug: string) {
    if (!/^[^/\s]+\/[^/\s]+$/.test(slug)) {
      throw new Error(`invalid repo slug ${JSON.stringify(slug)} — expected "owner/name"`);
    }
  }

  private async gh(args: string[]): Promise<string> {
    try {
      const { stdout } = await execFileAsync('gh', args, {
        encoding: 'utf8',
        maxBuffer: 32 * 1024 * 1024,
      });
      return stdout;
    } catch (err) {
      const e = err as { stderr?: string; message: string };
      const detail = (e.stderr ?? '').trim() || e.message;
      throw new Error(`gh ${args.slice(0, 3).join(' ')} failed: ${detail}`);
    }
  }

  private async ghJson<T>(args: string[]): Promise<T> {
    const out = await this.gh(args);
    try {
      return JSON.parse(out) as T;
    } catch {
      throw new Error(`gh returned non-JSON for ${args.slice(0, 3).join(' ')}: ${out.slice(0, 200)}`);
    }
  }

  async getPullRequest(number: number): Promise<PullRequest> {
    const raw = await this.ghJson<{
      number: number;
      base: { ref: string };
      head: { sha: string };
      state: string;
      merged: boolean;
      draft: boolean;
      title: string;
      html_url: string;
    }>(['api', `repos/${this.slug}/pulls/${number}`]);

    return {
      number: raw.number,
      baseRef: raw.base.ref,
      headSha: raw.head.sha,
      state: raw.merged ? 'MERGED' : raw.state.toUpperCase() === 'OPEN' ? 'OPEN' : 'CLOSED',
      isDraft: raw.draft,
      title: raw.title,
      url: raw.html_url,
    };
  }

  async requestReviewer(number: number, login: string): Promise<string[]> {
    const raw = await this.ghJson<{ requested_reviewers?: { login: string }[] }>([
      'api',
      '-X',
      'POST',
      `repos/${this.slug}/pulls/${number}/requested_reviewers`,
      '-f',
      `reviewers[]=${login}`,
    ]);
    return (raw.requested_reviewers ?? []).map((r) => r.login);
  }

  /**
   * Paginated array endpoints, as NDJSON.
   *
   * `--paginate` alone concatenates one JSON array per page (`[...][...]`),
   * which is not parseable. `--slurp` fixes that but only exists in newer gh
   * (absent in 2.45). `--paginate -q '.[]'` emits one object per line on every
   * version, so that is what this uses.
   */
  private async ghPaginated<T>(endpoint: string): Promise<T[]> {
    const out = await this.gh(['api', '--paginate', '-q', '.[]', endpoint]);
    return out
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line, i) => {
        try {
          return JSON.parse(line) as T;
        } catch {
          throw new Error(`gh returned non-JSON on line ${i + 1} of ${endpoint}: ${line.slice(0, 160)}`);
        }
      });
  }

  async listReviews(number: number): Promise<ReviewVerdict[]> {
    const raw = await this.ghPaginated<{
      user: { login: string } | null;
      state: string;
      commit_id: string;
      submitted_at: string | null;
    }>(`repos/${this.slug}/pulls/${number}/reviews`);

    return raw.map((r) => ({
      // Login spelling varies by endpoint — REST returns the `[bot]` suffix
      // here, GraphQL does not. Kept verbatim; `matchesReviewer` normalizes.
      author: r.user?.login ?? '(unknown)',
      state: r.state.toUpperCase() as ReviewState,
      sha: r.commit_id,
      submittedAt: r.submitted_at,
    }));
  }

  async listReviewThreads(number: number): Promise<ReviewThread[]> {
    const threads: ReviewThread[] = [];
    let after: string | null = null;

    // Page to exhaustion. A `first: 100` query that stops at one page silently
    // under-reports unresolved threads — and "zero unresolved" is a merge
    // condition, so an under-report is a false green.
    for (;;) {
      const query = `
        query($owner: String!, $name: String!, $number: Int!, $after: String) {
          repository(owner: $owner, name: $name) {
            pullRequest(number: $number) {
              reviewThreads(first: 100, after: $after) {
                pageInfo { hasNextPage endCursor }
                nodes {
                  id isResolved isOutdated path
                  comments(first: 1) { nodes { databaseId body author { login } } }
                }
              }
            }
          }
        }`;

      const [owner, name] = this.slug.split('/');
      const args = [
        'api',
        'graphql',
        '-f',
        `query=${query}`,
        '-F',
        `owner=${owner}`,
        '-F',
        `name=${name}`,
        '-F',
        `number=${number}`,
      ];
      if (after) args.push('-F', `after=${after}`);

      const res = await this.ghJson<{
        data: {
          repository: {
            pullRequest: {
              reviewThreads: {
                pageInfo: { hasNextPage: boolean; endCursor: string | null };
                nodes: {
                  id: string;
                  isResolved: boolean;
                  isOutdated: boolean;
                  path: string | null;
                  comments: { nodes: { databaseId: number | null; body: string; author: { login: string } | null }[] };
                }[];
              };
            };
          };
        };
      }>(args);

      const page = res.data.repository.pullRequest.reviewThreads;
      for (const node of page.nodes) {
        const first = node.comments.nodes[0];
        threads.push({
          id: node.id,
          isResolved: node.isResolved,
          isOutdated: node.isOutdated,
          path: node.path,
          firstCommentId: first?.databaseId ?? null,
          firstCommentAuthor: first?.author?.login ?? '(unknown)',
          firstCommentBody: first?.body ?? '',
        });
      }

      if (!page.pageInfo.hasNextPage) break;
      after = page.pageInfo.endCursor;
      if (!after) break;
    }

    return threads;
  }

  async replyToThread(number: number, commentId: number, body: string): Promise<string> {
    const raw = await this.ghJson<{ id?: number }>([
      'api',
      '-X',
      'POST',
      `repos/${this.slug}/pulls/${number}/comments/${commentId}/replies`,
      '-f',
      `body=${body}`,
    ]);

    // The returned id IS the proof it posted. Without it, treat the reply as
    // not having happened — never fall through to resolving the thread.
    if (raw.id === undefined || raw.id === null) {
      throw new Error(
        `reply to comment ${commentId} returned no id — treating as NOT posted. Thread left unresolved.`,
      );
    }
    return String(raw.id);
  }

  async resolveThread(threadId: string): Promise<boolean> {
    const res = await this.ghJson<{
      data: { resolveReviewThread: { thread: { isResolved: boolean } } };
    }>([
      'api',
      'graphql',
      '-f',
      `query=mutation($id: ID!) { resolveReviewThread(input: {threadId: $id}) { thread { isResolved } } }`,
      '-F',
      `id=${threadId}`,
    ]);
    return res.data.resolveReviewThread.thread.isResolved;
  }

  async merge(number: number, opts: MergeOptions): Promise<void> {
    const args = ['pr', 'merge', String(number), '--repo', this.slug, `--${opts.method}`];
    if (opts.deleteBranch) args.push('--delete-branch');
    await this.gh(args);

    // `gh pr merge` can exit 0 in situations where the merge did not land
    // (notably when the local checkout blocks the post-merge branch switch).
    // Confirm against the API rather than trusting the exit code.
    const after = await this.getPullRequest(number);
    if (after.state !== 'MERGED') {
      throw new Error(
        `gh pr merge exited cleanly but PR #${number} is ${after.state}, not MERGED. The merge did NOT happen.`,
      );
    }
  }
}
