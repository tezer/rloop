import { describe, expect, it } from 'vitest';
import { formatDegradation, formatPrStatus } from '../../src/report.js';
import type { Finding, ReviewerReport } from '../../src/reviewers/types.js';

describe('formatDegradation', () => {
  it('is empty when nothing is degraded', () => {
    expect(formatDegradation(null)).toBe('');
  });

  it('names the reason and is impossible to skim past', () => {
    const s = formatDegradation({
      reason: 'unavailable',
      provider: 'codex',
      message: 'Reviewer "codex" is unavailable: ENOENT',
    });
    expect(s).toContain('DEGRADED');
    expect(s).toContain('codex');
    expect(s).toContain('unavailable');
  });

  it('says explicitly that gates still ran and the merge will not', () => {
    // The whole point of in-band notification: the operator must not have to
    // infer what rloop did and did not do.
    const s = formatDegradation({ reason: 'not_configured', provider: null, message: 'none' });
    expect(s).toMatch(/gates/i);
    expect(s).toMatch(/not merge|will not merge|no merge/i);
  });
});

/** Minimal, type-correct `formatPrStatus` input shared across the cases below. */
function basePrStatus() {
  return {
    pr: {
      number: 42,
      baseRef: 'main',
      headSha: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
      state: 'OPEN',
      isDraft: false,
      title: 'Add token refresh',
    },
    reviews: [],
    threads: [],
    decision: { allowed: true, blockers: [] },
  };
}

function finding(overrides: Partial<Finding>): Finding {
  return {
    id: null,
    severity: 'important',
    path: 'src/auth.ts',
    line: 88,
    title: 'Missing null check on token',
    body: null,
    fingerprint: '8c7515f5',
    dismissed: false,
    ...overrides,
  };
}

function report(overrides: Partial<ReviewerReport>): ReviewerReport {
  return {
    name: 'local-lint',
    kind: 'command',
    status: 'findings',
    sha: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
    findings: [],
    detail: null,
    findingsReason: 'provider_findings',
    ...overrides,
  };
}

describe('formatPrStatus', () => {
  it("renders a finding's fingerprint and severity", () => {
    const f = finding({ fingerprint: '8c7515f5', severity: 'critical' });
    const out = formatPrStatus({ ...basePrStatus(), reviewerReports: [report({ findings: [f] })] });
    expect(out).toContain('8c7515f5');
    // Same line: a dismissal is keyed on the fingerprint, so an operator must
    // be able to read the fingerprint and its severity together, not infer
    // which finding a stray "critical" elsewhere in the report belongs to.
    const line = out.split('\n').find((l) => l.includes('8c7515f5'));
    expect(line).toBeDefined();
    expect(line).toContain('critical');
  });

  it('renders a dismissed finding as visually distinct from a blocking one', () => {
    const f = finding({ fingerprint: 'deadbeef', severity: 'critical', dismissed: true });
    const out = formatPrStatus({ ...basePrStatus(), reviewerReports: [report({ findings: [f] })] });
    const line = out.split('\n').find((l) => l.includes('deadbeef'));
    expect(line).toBeDefined();
    expect(line).toContain('dismissed');
    // Not labelled with its severity — "dismissed" replaces it rather than
    // sitting alongside it, so a scan for "critical" does not still flag it.
    expect(line).not.toContain('critical');
  });

  it('has no doubled blank line in the clean, non-degraded case', () => {
    const out = formatPrStatus({ ...basePrStatus(), reviewerReports: [], degradation: null });
    // Regression guard for the doubled-blank-line bug: formatDegradation('')
    // being pushed unconditionally left an empty array entry that, joined
    // with '\n', produced two consecutive blank lines.
    expect(out).not.toMatch(/\n\n\n/);
  });
});
