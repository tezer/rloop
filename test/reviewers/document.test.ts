// test/reviewers/document.test.ts
import { describe, expect, it } from 'vitest';
import { parseProviderDocument } from '../../src/reviewers/document.js';

const SHA = 'a'.repeat(40);

describe('parseProviderDocument', () => {
  it('accepts a document with no findings', () => {
    const r = parseProviderDocument(JSON.stringify({ sha: SHA, findings: [] }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.doc.findings).toEqual([]);
  });

  it('defaults a missing findings array to empty rather than failing', () => {
    const r = parseProviderDocument(JSON.stringify({ sha: SHA }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.doc.findings).toEqual([]);
  });

  it('rejects an unknown severity instead of dropping the finding', () => {
    // A finding rloop cannot classify must not vanish: silently ignoring it
    // turns a blocking finding into a clean report.
    const r = parseProviderDocument(
      JSON.stringify({ sha: SHA, findings: [{ severity: 'nit', title: 'x' }] }),
    );
    expect(r.ok).toBe(false);
  });

  it('rejects a finding with no title', () => {
    const r = parseProviderDocument(
      JSON.stringify({ sha: SHA, findings: [{ severity: 'critical' }] }),
    );
    expect(r.ok).toBe(false);
  });

  it('rejects unknown top-level keys', () => {
    const r = parseProviderDocument(JSON.stringify({ sha: SHA, findings: [], extra: 1 }));
    expect(r.ok).toBe(false);
  });

  it('reports non-JSON as an error rather than throwing', () => {
    const r = parseProviderDocument('not json at all');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/JSON/i);
  });
});
