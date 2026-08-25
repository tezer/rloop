import { describe, expect, it } from 'vitest';
import { assertFindingsReasonCoupling, isBlocking, type ReviewerReport } from '../../src/reviewers/types.js';

/** Minimal, otherwise-valid report — only the two fields under test vary. */
function report(overrides: Partial<ReviewerReport>): ReviewerReport {
  return {
    name: 'codex',
    kind: 'command',
    status: 'clean',
    sha: 'a'.repeat(40),
    findings: [],
    detail: null,
    findingsReason: null,
    ...overrides,
  };
}

describe('isBlocking', () => {
  it('blocks critical and important, not minor', () => {
    expect(isBlocking('critical')).toBe(true);
    expect(isBlocking('important')).toBe(true);
    expect(isBlocking('minor')).toBe(false);
  });
});

describe('assertFindingsReasonCoupling', () => {
  it('passes through a report where the two fields already agree', () => {
    const clean = report({ status: 'clean', findingsReason: null });
    expect(assertFindingsReasonCoupling(clean)).toBe(clean);

    const findings = report({ status: 'findings', findingsReason: 'provider_findings' });
    expect(assertFindingsReasonCoupling(findings)).toBe(findings);
  });

  it('throws, naming the reviewer, when status is "clean" but findingsReason is set', () => {
    // A copy-pasted branch that sets findingsReason but forgets to also set
    // status: 'findings' — exactly the drift this assertion exists to catch
    // at the factory instead of downstream in evaluateMergeGate.
    const bad = report({ status: 'clean', findingsReason: 'provider_findings' });
    expect(() => assertFindingsReasonCoupling(bad)).toThrow(/codex/);
  });

  it('throws, naming the reviewer, when status is "findings" but findingsReason is null', () => {
    const bad = report({ status: 'findings', findingsReason: null });
    expect(() => assertFindingsReasonCoupling(bad)).toThrow(/codex/);
  });
});
