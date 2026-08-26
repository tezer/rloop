/**
 * Provider-agnostic view of a pull request and its review state.
 *
 * GitHub is the only implementation today, but nothing above this file knows
 * that. The merge decision is written against these types alone.
 */

export interface PullRequest {
  number: number;
  /** Branch being merged INTO. Checked against the base-branch allowlist. */
  baseRef: string;
  /** Head commit. Every verdict must be bound to this exact SHA. */
  headSha: string;
  state: 'OPEN' | 'MERGED' | 'CLOSED';
  isDraft: boolean;
  title: string;
  url: string;
}

export type ReviewState =
  | 'APPROVED'
  | 'CHANGES_REQUESTED'
  | 'COMMENTED'
  | 'DISMISSED'
  | 'PENDING';

export interface ReviewVerdict {
  /** Login as the API reported it — forms vary, see `matchesReviewer`. */
  author: string;
  state: ReviewState;
  /** Commit the review was submitted against. Stale if it is not the head. */
  sha: string;
  submittedAt: string | null;
}

export interface ReviewThread {
  /** GraphQL node id — what `resolveThread` needs. */
  id: string;
  isResolved: boolean;
  isOutdated: boolean;
  path: string | null;
  /** REST comment id of the first comment — what `replyToThread` needs. */
  firstCommentId: number | null;
  firstCommentAuthor: string;
  firstCommentBody: string;
}

export interface MergeOptions {
  method: 'squash' | 'merge' | 'rebase';
  deleteBranch: boolean;
}

export interface Forge {
  getPullRequest(number: number): Promise<PullRequest>;
  /** Returns the resulting requested-reviewer logins, for verification. */
  requestReviewer(number: number, login: string): Promise<string[]>;
  listReviews(number: number): Promise<ReviewVerdict[]>;
  /** Paginated to exhaustion — a partial listing would understate the work. */
  listReviewThreads(number: number): Promise<ReviewThread[]>;
  /** Returns the created reply's id. Throws if the API did not confirm one. */
  replyToThread(number: number, commentId: number, body: string): Promise<string>;
  resolveThread(threadId: string): Promise<boolean>;
  merge(number: number, opts: MergeOptions): Promise<void>;
}

/**
 * The same bot answers to different logins on different endpoints.
 *
 * Verified against GitHub's API: requesting Copilot as a reviewer requires the
 * `[bot]` suffix (without it the call silently no-ops), the review object's
 * author comes back without it, and `requested_reviewers[].login` uses a third,
 * bare form. Comparing raw strings therefore reports "no verdict" for a review
 * that plainly exists — and "no verdict" blocks a merge, so the failure is at
 * least safe. It is still wrong: it blocks a PR whose reviewer already spoke.
 *
 * This used to end "it wastes a polling window". There is no polling window —
 * rloop asks the forge once. See `merge.reviewer_timeout_seconds` in config.ts
 * for the rest of that fiction.
 */
const ALIASES: readonly (readonly string[])[] = [['copilot', 'copilot-pull-request-reviewer']];

export function normalizeLogin(login: string): string {
  return login.trim().toLowerCase().replace(/\[bot\]$/, '');
}

/** True when `actual` denotes the same reviewer as `configured`. */
export function matchesReviewer(configured: string, actual: string): boolean {
  const a = normalizeLogin(configured);
  const b = normalizeLogin(actual);
  if (a === b) return true;
  return ALIASES.some((group) => group.includes(a) && group.includes(b));
}
