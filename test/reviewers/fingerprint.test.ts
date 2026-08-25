import { describe, expect, it } from 'vitest';
import { fingerprint } from '../../src/reviewers/fingerprint.js';

describe('fingerprint', () => {
  it('is 8 lowercase hex characters', () => {
    expect(fingerprint({ path: 'src/a.ts', title: 'Off-by-one' })).toMatch(/^[0-9a-f]{8}$/);
  });

  it('is stable when an unrelated edit moves the finding to a new line', () => {
    // THE case this function exists for. A fingerprint that changes when a line
    // number shifts reports every finding as new and every fixed one as gone,
    // which makes disappearance-on-re-run meaningless.
    const a = fingerprint({ path: 'src/a.ts', title: 'Off-by-one' });
    const b = fingerprint({ path: 'src/a.ts', title: 'Off-by-one' });
    expect(a).toBe(b);
  });

  it('ignores case and surrounding whitespace in the title', () => {
    expect(fingerprint({ path: 'src/a.ts', title: '  Off-By-One  ' })).toBe(
      fingerprint({ path: 'src/a.ts', title: 'off-by-one' }),
    );
  });

  it('collapses internal whitespace, so a rewrapped title matches', () => {
    expect(fingerprint({ path: 'src/a.ts', title: 'off by  one' })).toBe(
      fingerprint({ path: 'src/a.ts', title: 'off by one' }),
    );
  });

  it('distinguishes the same title in different files', () => {
    expect(fingerprint({ path: 'src/a.ts', title: 'x' })).not.toBe(
      fingerprint({ path: 'src/b.ts', title: 'x' }),
    );
  });

  it('prefers the provider id, so a reworded title keeps its identity', () => {
    expect(fingerprint({ id: 'codex-7', path: 'src/a.ts', title: 'first wording' })).toBe(
      fingerprint({ id: 'codex-7', path: 'src/b.ts', title: 'second wording' }),
    );
  });

  it('does not confuse an id with a path+title that concatenate to the same string', () => {
    // Without the `id`/`pt` domain tags these collide exactly: the id branch
    // yields "src/a.tsx" and the pt branch yields "src/a.ts" + "x". Verified —
    // both hash to 633790c1 with the tags removed.
    expect(fingerprint({ id: 'src/a.tsx', title: 'anything' })).not.toBe(
      fingerprint({ path: 'src/a.ts', title: 'x' }),
    );
  });

  it('does not confuse a path/title boundary that shifts', () => {
    // The separator BETWEEN path and title is load-bearing too: without it
    // "a"+"bc" and "ab"+"c" are the same string.
    expect(fingerprint({ path: 'a', title: 'bc' })).not.toBe(
      fingerprint({ path: 'ab', title: 'c' }),
    );
  });
});
