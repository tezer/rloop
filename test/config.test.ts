import { describe, expect, it } from 'vitest';

import { collectWarnings, loadConfig } from '../src/config.js';

const minimal = `
version: 1
gates:
  - name: build
    run: npm run build
    require: ["^Route \\\\("]
`;

describe('loadConfig', () => {
  it('applies safe defaults', () => {
    const cfg = loadConfig(minimal);
    expect(cfg.merge.enabled).toBe(false); // dry run unless opted in
    expect(cfg.merge.allowed_base_branches).toEqual([]);
    expect(cfg.parallel_gates).toBe(false); // sequential unless opted in
    expect(cfg.gates[0].expect_exit).toBe(0);
    expect(cfg.gates[0].timeout_seconds).toBe(1800);
  });

  it('rejects a gate that proves nothing', () => {
    expect(() =>
      loadConfig(`
version: 1
gates:
  - name: build
    run: npm run build
`),
    ).toThrow(/proves nothing/);
  });

  it('rejects merge.enabled with an empty base-branch allowlist', () => {
    expect(() =>
      loadConfig(`
version: 1
gates:
  - name: build
    run: npm run build
    forbid: ["npm ERR!"]
merge:
  enabled: true
`),
    ).toThrow(/allowed_base_branches is empty/);
  });

  it('accepts merge.enabled with an explicit allowlist', () => {
    const cfg = loadConfig(`
version: 1
gates:
  - name: build
    run: npm run build
    forbid: ["npm ERR!"]
merge:
  enabled: true
  allowed_base_branches: [staging]
`);
    expect(cfg.merge.allowed_base_branches).toEqual(['staging']);
  });

  it('rejects duplicate gate names', () => {
    expect(() =>
      loadConfig(`
version: 1
gates:
  - name: build
    run: a
    forbid: ["x"]
  - name: build
    run: b
    forbid: ["y"]
`),
    ).toThrow(/duplicate gate name/);
  });

  it('rejects an empty when_paths, which reads like "always" but means "never"', () => {
    expect(() =>
      loadConfig(`
version: 1
gates:
  - name: build
    run: a
    forbid: ["x"]
    when_paths: []
`),
    ).toThrow();
  });

  it('rejects unknown keys instead of ignoring a typo', () => {
    expect(() =>
      loadConfig(`
version: 1
gates:
  - name: build
    run: a
    forbidden: ["x"]
`),
    ).toThrow();
  });
});

describe('collectWarnings', () => {
  it('flags a gate that rests on negative evidence alone', () => {
    const cfg = loadConfig(`
version: 1
gates:
  - name: authoring
    run: npm run build --workspace=tools/authoring
    forbid: ["npm ERR!", "error TS[0-9]{3,}"]
`);
    const warnings = collectWarnings(cfg);
    expect(warnings.some((w) => w.gate === 'authoring' && /no "require" patterns/.test(w.message))).toBe(true);
  });

  it('stays quiet on a well-formed config', () => {
    expect(collectWarnings(loadConfig(minimal))).toEqual([]);
  });
});
