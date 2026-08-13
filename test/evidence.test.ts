import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { evaluateEvidence } from '../src/evidence.js';

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const fixture = (name: string) => readFileSync(path.join(fixturesDir, name), 'utf8');

/** The markers a Next.js + vitest project actually needs. */
const NEXT_BUILD = {
  require: ['Compiled successfully', '^Route \\('],
  forbid: [
    'Failed to compile',
    'Module not found',
    'Error occurred prerendering',
    'Export encountered errors',
    'Build error occurred',
    'npm ERR!',
  ],
};

const VITEST = {
  require: ['^\\s*Tests\\s+[1-9][0-9]* passed'],
  forbid: ['^\\s*FAIL ', '^\\s*Tests\\s+.*[1-9][0-9]* failed'],
};

describe('golden logs: build', () => {
  it('passes a genuinely successful next build', () => {
    const ev = evaluateEvidence(fixture('next-build-pass.log'), NEXT_BUILD.require, NEXT_BUILD.forbid);
    expect(ev.satisfied).toBe(true);
    expect(ev.requiredMissing).toEqual([]);
    expect(ev.forbiddenMatched).toEqual([]);
  });

  it('catches the masked failure that exits 0 under npm 9', () => {
    const ev = evaluateEvidence(
      fixture('next-build-masked-fail.log'),
      NEXT_BUILD.require,
      NEXT_BUILD.forbid,
    );
    expect(ev.satisfied).toBe(false);
    expect(ev.forbiddenMatched.map((m) => m.pattern)).toEqual(
      expect.arrayContaining(['Error occurred prerendering', 'Export encountered errors', 'npm ERR!']),
    );
  });

  it('would have false-greened on "Compiled successfully" alone — the route table is load-bearing', () => {
    const log = fixture('next-build-masked-fail.log');

    // The naive marker most people reach for first.
    const naive = evaluateEvidence(log, ['Compiled successfully'], []);
    expect(naive.satisfied).toBe(true);

    // The closing route table only prints after prerender succeeds.
    const real = evaluateEvidence(log, ['Compiled successfully', '^Route \\('], []);
    expect(real.satisfied).toBe(false);
    expect(real.requiredMissing).toEqual(['^Route \\(']);
  });

  it('reports the line number of the first forbidden hit', () => {
    const ev = evaluateEvidence(fixture('next-build-masked-fail.log'), [], ['npm ERR!']);
    const hit = ev.forbiddenMatched[0];
    expect(hit.line).toBeGreaterThan(0);
    expect(hit.text).toContain('npm ERR!');
  });
});

describe('golden logs: tests', () => {
  it('passes a green vitest run', () => {
    const ev = evaluateEvidence(
      fixture('vitest-pass-with-taskfailed-string.log'),
      VITEST.require,
      VITEST.forbid,
    );
    expect(ev.satisfied).toBe(true);
  });

  it('does not trip on the literal "failed" inside a passing error-path assertion', () => {
    const log = fixture('vitest-pass-with-taskfailed-string.log');
    expect(log).toContain('task 1 failed'); // the trap is genuinely present

    const anchored = evaluateEvidence(log, VITEST.require, VITEST.forbid);
    expect(anchored.satisfied).toBe(true);

    // An unanchored `failed` guard would have failed a green run.
    const sloppy = evaluateEvidence(log, VITEST.require, ['failed']);
    expect(sloppy.satisfied).toBe(false);
  });

  it('catches --passWithNoTests running zero tests', () => {
    const ev = evaluateEvidence(fixture('vitest-zero-tests.log'), VITEST.require, VITEST.forbid);
    expect(ev.satisfied).toBe(false);
    expect(ev.requiredMissing).toEqual(VITEST.require);
    expect(ev.forbiddenMatched).toEqual([]); // nothing "failed" — it just never ran
  });

  it('catches a real test failure', () => {
    const ev = evaluateEvidence(fixture('vitest-fail.log'), VITEST.require, VITEST.forbid);
    expect(ev.satisfied).toBe(false);
    expect(ev.forbiddenMatched.map((m) => m.pattern)).toEqual(
      expect.arrayContaining(['^\\s*FAIL ', '^\\s*Tests\\s+.*[1-9][0-9]* failed']),
    );
  });
});

describe('matching semantics', () => {
  it('anchors ^ and $ to each line, not the whole log', () => {
    const log = 'preamble\nRoute (app)  Size\ntrailer';
    expect(evaluateEvidence(log, ['^Route \\('], []).satisfied).toBe(true);
  });

  it('records each required pattern once, at its first hit', () => {
    const log = 'ok\nok\nok';
    const ev = evaluateEvidence(log, ['ok'], []);
    expect(ev.requiredMatched).toHaveLength(1);
    expect(ev.requiredMatched[0].line).toBe(1);
  });

  it('records every forbidden hit, so the caller sees the blast radius', () => {
    const ev = evaluateEvidence('bad\nfine\nbad', [], ['bad']);
    expect(ev.forbiddenMatched.map((m) => m.line)).toEqual([1, 3]);
  });

  it('requires ALL require patterns, not any', () => {
    const ev = evaluateEvidence('only-a', ['only-a', 'only-b'], []);
    expect(ev.satisfied).toBe(false);
    expect(ev.requiredMissing).toEqual(['only-b']);
  });

  it('treats an empty require list as vacuously satisfied', () => {
    // Legitimate for tools that print nothing on success (tsc -b), which is
    // why the gate result flags it as negativeEvidenceOnly.
    expect(evaluateEvidence('whatever', [], []).satisfied).toBe(true);
    expect(evaluateEvidence('npm ERR! nope', [], ['npm ERR!']).satisfied).toBe(false);
  });

  it('handles CRLF logs', () => {
    expect(evaluateEvidence('a\r\nRoute (app)\r\nb', ['^Route \\('], []).satisfied).toBe(true);
  });

  it('rejects an invalid regex loudly instead of silently never matching', () => {
    expect(() => evaluateEvidence('x', ['('], [])).toThrow(/Invalid regex/);
  });
});
