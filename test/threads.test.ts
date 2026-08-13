import { describe, expect, it } from 'vitest';

import type { Forge, MergeOptions, PullRequest, ReviewThread, ReviewVerdict } from '../src/forge/types.js';
import { replyAndResolve, unresolvedThreads } from '../src/threads.js';

const thread = (over: Partial<ReviewThread> = {}): ReviewThread => ({
  id: 'PRRT_1',
  isResolved: false,
  isOutdated: false,
  path: 'src/a.ts',
  firstCommentId: 99,
  firstCommentAuthor: 'Copilot',
  firstCommentBody: 'this looks wrong',
  ...over,
});

/** Records the call order so we can assert reply-before-resolve. */
class FakeForge implements Forge {
  calls: string[] = [];
  constructor(
    private readonly opts: { replyFails?: boolean; resolveReturns?: boolean } = {},
  ) {}

  async replyToThread(_n: number, commentId: number, _body: string): Promise<string> {
    this.calls.push(`reply:${commentId}`);
    if (this.opts.replyFails) throw new Error('reply returned no id — treating as NOT posted');
    return '12345';
  }
  async resolveThread(threadId: string): Promise<boolean> {
    this.calls.push(`resolve:${threadId}`);
    return this.opts.resolveReturns ?? true;
  }

  async getPullRequest(): Promise<PullRequest> {
    throw new Error('not used');
  }
  async requestReviewer(): Promise<string[]> {
    throw new Error('not used');
  }
  async listReviews(): Promise<ReviewVerdict[]> {
    throw new Error('not used');
  }
  async listReviewThreads(): Promise<ReviewThread[]> {
    throw new Error('not used');
  }
  async merge(_n: number, _o: MergeOptions): Promise<void> {
    throw new Error('not used');
  }
}

describe('replyAndResolve', () => {
  it('replies first, then resolves', async () => {
    const forge = new FakeForge();
    const res = await replyAndResolve(forge, 42, thread(), 'Fixed in abc123: renamed the field.');
    expect(forge.calls).toEqual(['reply:99', 'resolve:PRRT_1']);
    expect(res.replyId).toBe('12345');
    expect(res.resolved).toBe(true);
  });

  it('does NOT resolve when the reply fails — the thread keeps blocking', async () => {
    const forge = new FakeForge({ replyFails: true });
    await expect(replyAndResolve(forge, 42, thread(), 'Fixed.')).rejects.toThrow(/NOT posted/);
    expect(forge.calls).toEqual(['reply:99']); // resolve was never attempted
  });

  it('refuses a thread with no comment id rather than resolving it unanswered', async () => {
    const forge = new FakeForge();
    await expect(
      replyAndResolve(forge, 42, thread({ firstCommentId: null }), 'Fixed.'),
    ).rejects.toThrow(/Refusing to resolve/);
    expect(forge.calls).toEqual([]);
  });

  it('refuses an empty reply body', async () => {
    const forge = new FakeForge();
    await expect(replyAndResolve(forge, 42, thread(), '   ')).rejects.toThrow(/not an answer/);
    expect(forge.calls).toEqual([]);
  });

  it('refuses an already-resolved thread', async () => {
    const forge = new FakeForge();
    await expect(
      replyAndResolve(forge, 42, thread({ isResolved: true }), 'Fixed.'),
    ).rejects.toThrow(/already resolved/);
    expect(forge.calls).toEqual([]);
  });

  it('surfaces a resolve that silently did not take', async () => {
    const forge = new FakeForge({ resolveReturns: false });
    await expect(replyAndResolve(forge, 42, thread(), 'Fixed.')).rejects.toThrow(/isResolved=false/);
  });
});

describe('unresolvedThreads', () => {
  it('selects only the unresolved ones', () => {
    const list = [thread({ id: 'a' }), thread({ id: 'b', isResolved: true }), thread({ id: 'c' })];
    expect(unresolvedThreads(list).map((t) => t.id)).toEqual(['a', 'c']);
  });
});
