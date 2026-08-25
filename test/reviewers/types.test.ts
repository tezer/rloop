import { describe, expect, it } from 'vitest';
import { assertReasonCoupling, isBlocking, type ReviewerReport } from '../../src/reviewers/types.js';

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
    unavailableReason: null,
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

describe('assertReasonCoupling', () => {
  it('passes through a report where all fields already agree', () => {
    const clean = report({ status: 'clean', findingsReason: null });
    expect(assertReasonCoupling(clean)).toBe(clean);

    const findings = report({ status: 'findings', findingsReason: 'provider_findings' });
    expect(assertReasonCoupling(findings)).toBe(findings);

    const unavailable = report({ status: 'unavailable', unavailableReason: 'never_ran' });
    expect(assertReasonCoupling(unavailable)).toBe(unavailable);
  });

  it('throws, naming the reviewer, when status is "clean" but findingsReason is set', () => {
    // A copy-pasted branch that sets findingsReason but forgets to also set
    // status: 'findings' — exactly the drift this assertion exists to catch
    // at the factory instead of downstream in evaluateMergeGate.
    const bad = report({ status: 'clean', findingsReason: 'provider_findings' });
    expect(() => assertReasonCoupling(bad)).toThrow(/codex/);
  });

  it('throws, naming the reviewer, when status is "findings" but findingsReason is null', () => {
    const bad = report({ status: 'findings', findingsReason: null });
    expect(() => assertReasonCoupling(bad)).toThrow(/codex/);
  });

  it('throws, naming the reviewer, when status is "clean" but unavailableReason is set', () => {
    // Mirrors the findingsReason case above, for the field Round 2 added:
    // a branch that sets unavailableReason without also setting
    // status: 'unavailable' used to sail through unchecked.
    const bad = report({ status: 'clean', unavailableReason: 'never_ran' });
    expect(() => assertReasonCoupling(bad)).toThrow(/codex/);
  });

  it('throws, naming the reviewer, when status is "unavailable" but unavailableReason is null', () => {
    const bad = report({ status: 'unavailable', unavailableReason: null });
    expect(() => assertReasonCoupling(bad)).toThrow(/codex/);
  });
});
