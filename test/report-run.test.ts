import { describe, expect, it } from 'vitest';

import { formatRun } from '../src/report.js';
import type { GateRunResult } from '../src/types.js';

/**
 * `formatRun` renders the headline verdict a human reads, and it is exported
 * from src/index.ts — so a library consumer can hand it any `GateRunResult`,
 * including ones `runGates` would never build.
 *
 * It had no test at all. Two defects lived in that gap: a new
 * `invalidatedBy` member fell through to a PARTIAL line blaming `--only`, and
 * the GREEN headline was re-derived from the gate array rather than read from
 * the authoritative `green` flag.
 */
const run = (over: Partial<GateRunResult> = {}): GateRunResult => ({
  green: true,
  partial: false,
  sha: 'a'.repeat(40),
  invalidatedBy: null,
  gates: [
    { name: 'build', status: 'pass', durationMs: 1, evidence: { requiredMatched: [], requiredMissing: [], forbidden: [] }, exitCode: 0, logPath: '' },
  ] as unknown as GateRunResult['gates'],
  durationMs: 1,
  logDir: '/tmp',
  ...over,
});

describe('formatRun', () => {
  it('renders GREEN only when the run says it is green', () => {
    expect(formatRun(run())).toMatch(/GREEN/);
  });

  it('refuses GREEN when every gate passed but the run flag says otherwise', () => {
    // The headline used to be computed from the gate array alone, so a run
    // whose own `green` was false could still print GREEN. `green` is what
    // `runGates` actually decides; the renderer must not second-guess it.
    const out = formatRun(run({ green: false }));
    expect(out).not.toMatch(/GREEN/);
    expect(out).toMatch(/Do not merge/);
  });

  it.each([
    ['dirty_worktree', /worktree was dirty/],
    ['head_moved', /HEAD moved/],
    ['gates_skipped', /gates were skipped/],
  ] as const)('renders VOID with a true reason for %s', (invalidatedBy, expected) => {
    // `gates_skipped` is the one this file was written for: it used to fall
    // through to "PARTIAL — 0 selected gate(s) passed" — the same false-flag
    // defect merge-gate.ts named `--only` outright, in this file's own
    // wording. All three are asserted so the next member added is the only
    // one that can be missing.
    const out = formatRun(run({ green: false, invalidatedBy }));
    expect(out).toMatch(/VOID/);
    expect(out).toMatch(expected);
    expect(out).not.toMatch(/--only|PARTIAL/);
  });
});
