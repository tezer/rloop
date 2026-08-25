import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import type {
  Forge,
  MergeOptions,
  PullRequest,
  ReviewThread,
  ReviewVerdict,
} from '../../src/forge/types.js';
import { prStatus } from '../../src/pr.js';
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
    unavailableReason: null,
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

/**
 * End-to-end: config -> `prStatus` -> `formatPrStatus`, with a fake `Forge`
 * standing in for GitHub (the CLI always hits the real one, so nothing else
 * exercises this full path). Pins the operator-visible string, not
 * intermediate objects.
 */
describe('formatPrStatus — end to end via prStatus', () => {
  const HEAD = 'c'.repeat(40);

  /** Controls only what `prStatus` reads; every other method is unused here. */
  class FakeForge implements Forge {
    async getPullRequest(): Promise<PullRequest> {
      return {
        number: 7,
        baseRef: 'main',
        headSha: HEAD,
        state: 'OPEN',
        isDraft: false,
        title: 'Add token refresh',
        url: 'https://example.invalid/pr/7',
      };
    }
    async listReviews(): Promise<ReviewVerdict[]> {
      return [];
    }
    async listReviewThreads(): Promise<ReviewThread[]> {
      return [];
    }
    async requestReviewer(): Promise<string[]> {
      throw new Error('not used');
    }
    async replyToThread(): Promise<string> {
      throw new Error('not used');
    }
    async resolveThread(): Promise<boolean> {
      throw new Error('not used');
    }
    async merge(_number: number, _opts: MergeOptions): Promise<void> {
      throw new Error('not used');
    }
  }

  // `run` points at a fixture that does not exist, so the command reviewer
  // spawn fails (ENOENT) and the run degrades — see
  // `collectReviewerReports — command dispatch > an unavailable command
  // reviewer becomes degradation` in test/reviewers/collect.test.ts for the
  // same shape isolated at the unit level.
  const cfg = loadConfig(`
version: 1
gates:
  - name: build
    run: npm run build
    require: ["^ok$"]
merge:
  enabled: true
  allowed_base_branches: ["main"]
reviewers:
  - name: codex
    kind: command
    run: definitely-not-a-real-binary-xyz
`);

  it('pins the degraded banner, the reviewer name, and the blocked verdict in the rendered output', async () => {
    // skipGates avoids running real gates (and real `npm run build`) in this
    // test. That models an explicitly-absent gate run — void, `sha` all
    // zeros — which on its own blocks the merge for TWO reasons
    // (gates_not_green and sha_mismatch_gates) independent of the reviewer.
    // So the assertion below targets `reviewer_degraded` specifically, not
    // just "blocked", to pin what THIS test actually claims to cover.
    const status = await prStatus(cfg, {
      repoRoot: process.cwd(),
      prNumber: 7,
      forge: new FakeForge(),
      skipGates: true,
    });

    const out = formatPrStatus(status);

    expect(out).toContain('EXTERNAL REVIEW DEGRADED');
    expect(out).toContain('codex');
    expect(status.decision.allowed).toBe(false);
    expect(status.decision.blockers.map((b) => b.code)).toContain('reviewer_degraded');
    expect(out).toContain('[reviewer_degraded]');
  });
});
