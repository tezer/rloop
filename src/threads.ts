import type { Forge, ReviewThread } from './forge/types.js';

export interface ReplyAndResolveResult {
  threadId: string;
  replyId: string;
  resolved: boolean;
}

/**
 * Reply to a review thread, then resolve it — in that order, never the reverse,
 * and never the second without the first.
 *
 * A resolved thread with no reply is worse than an open one: it looks handled
 * in the UI, so nobody re-reads it, and whatever the reviewer raised is gone
 * from the checklist without an answer. Making this one function is what turns
 * "always reply before resolving" from a rule someone has to remember into a
 * thing the code cannot do wrong.
 *
 * If the reply throws, the thread is left unresolved on purpose. That is the
 * safe direction: a merge is blocked rather than a comment silently buried.
 */
export async function replyAndResolve(
  forge: Forge,
  prNumber: number,
  thread: ReviewThread,
  body: string,
): Promise<ReplyAndResolveResult> {
  if (thread.isResolved) {
    throw new Error(`thread ${thread.id} is already resolved — nothing to reply to`);
  }
  if (thread.firstCommentId === null) {
    throw new Error(
      `thread ${thread.id} has no REST comment id, so no reply can be posted. ` +
        `Refusing to resolve it — an unanswered thread must keep blocking.`,
    );
  }
  if (body.trim().length === 0) {
    throw new Error('reply body is empty — an empty reply is not an answer');
  }

  // Throws unless the API confirmed a reply id.
  const replyId = await forge.replyToThread(prNumber, thread.firstCommentId, body);

  const resolved = await forge.resolveThread(thread.id);
  if (!resolved) {
    throw new Error(
      `reply ${replyId} posted, but resolveReviewThread reported isResolved=false for ${thread.id}`,
    );
  }

  return { threadId: thread.id, replyId, resolved };
}

/** Threads still blocking a merge. */
export function unresolvedThreads(threads: ReviewThread[]): ReviewThread[] {
  return threads.filter((t) => !t.isResolved);
}
