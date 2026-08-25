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

const base = `
version: 1
gates:
  - name: build
    run: npm run build
    require: ["^ok$"]
`;

describe('reviewers', () => {
  it('accepts a forge and a command reviewer side by side', () => {
    const cfg = loadConfig(`${base}
reviewers:
  - name: copilot
    kind: forge
    login: copilot-pull-request-reviewer
    required_state: any_verdict
  - name: codex
    kind: command
    run: codex review --json
`);
    expect(cfg.reviewers.map((r) => r.kind)).toEqual(['forge', 'command']);
  });

  it('desugars the deprecated merge keys into a forge reviewer', () => {
    const cfg = loadConfig(`${base}
merge:
  enabled: true
  allowed_base_branches: [staging]
  required_reviewers: [copilot-pull-request-reviewer]
  required_reviewer_state: any_verdict
`);
    expect(cfg.reviewers).toHaveLength(1);
    expect(cfg.reviewers[0]).toMatchObject({
      kind: 'forge',
      login: 'copilot-pull-request-reviewer',
      required_state: 'any_verdict',
    });
  });

  it('desugars multiple deprecated required_reviewers into one forge reviewer each', () => {
    const cfg = loadConfig(`${base}
merge:
  enabled: true
  allowed_base_branches: [staging]
  required_reviewers: [alice, bob]
  required_reviewer_state: any_verdict
`);
    expect(cfg.reviewers).toHaveLength(2);
    expect(cfg.reviewers.every((r) => r.kind === 'forge')).toBe(true);
    expect(cfg.reviewers.map((r) => (r.kind === 'forge' ? r.login : undefined))).toEqual(['alice', 'bob']);
    expect(cfg.reviewers.every((r) => r.kind === 'forge' && r.required_state === 'any_verdict')).toBe(true);
  });

  it('REFUSES a config that uses both forms', () => {
    // Two sources of truth for who must review is a config whose author does
    // not know what will happen. Never silently merged.
    expect(() =>
      loadConfig(`${base}
reviewers:
  - name: codex
    kind: command
    run: codex review --json
merge:
  required_reviewers: [copilot-pull-request-reviewer]
  required_reviewer_state: any_verdict
`),
    ).toThrow(/both/i);
  });

  it('rejects required_state on a command reviewer', () => {
    expect(() =>
      loadConfig(`${base}
reviewers:
  - name: codex
    kind: command
    run: codex review --json
    required_state: approved
`),
    ).toThrow();
  });

  it('rejects a dismissal with no reason', () => {
    expect(() =>
      loadConfig(`${base}
reviewers:
  - name: codex
    kind: command
    run: codex review --json
    dismiss:
      - fingerprint: a1b2c3d4
`),
    ).toThrow();
  });

  it('rejects duplicate reviewer names, which key the report output', () => {
    expect(() =>
      loadConfig(`${base}
reviewers:
  - name: dup
    kind: command
    run: a
  - name: dup
    kind: command
    run: b
`),
    ).toThrow(/duplicate/i);
  });

  it('rejects duplicate logins in the deprecated required_reviewers, which would ' +
    'desugar into a duplicate reviewer name undetected by the reviewers: check above', () => {
    // The reviewers:-duplicate check above runs on the new block, which is
    // empty when only the deprecated keys are set — so this needs its own
    // guard or a repeated login sails through desugaring as a silent
    // duplicate name.
    expect(() =>
      loadConfig(`${base}
merge:
  enabled: true
  allowed_base_branches: [staging]
  required_reviewers: [copilot-pull-request-reviewer, copilot-pull-request-reviewer]
  required_reviewer_state: any_verdict
`),
    ).toThrow(/duplicate/i);
  });

  it('warns that the deprecated keys are deprecated', () => {
    const cfg = loadConfig(`${base}
merge:
  enabled: true
  allowed_base_branches: [staging]
  required_reviewers: [copilot-pull-request-reviewer]
  required_reviewer_state: any_verdict
`);
    expect(collectWarnings(cfg).some((w) => /deprecated/i.test(w.message))).toBe(true);
  });
});
