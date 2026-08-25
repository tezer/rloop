import { describe, expect, it } from 'vitest';
import { formatDegradation } from '../../src/report.js';

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
