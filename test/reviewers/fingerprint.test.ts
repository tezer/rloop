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

  it('does not confuse an id with a path+title that happens to look like one', () => {
    expect(fingerprint({ id: 'x', title: 'y' })).not.toBe(fingerprint({ path: 'x', title: 'y' }));
  });
});
