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

  it('desugars to the STRICTER "approved" when required_reviewer_state is omitted', () => {
    // Reachable whenever `merge.required_reviewers` is set with
    // `merge.enabled: false` — the superRefine that otherwise forces
    // `required_reviewer_state` to be stated only fires when `merge.enabled`
    // is true, so this shape parses cleanly and falls all the way through to
    // `desugarDeprecatedReviewers`'s `?? 'approved'` fallback. Every other
    // desugar test above sets `required_reviewer_state` explicitly, so none
    // of them would catch a mutation of that fallback's default value.
    const cfg = loadConfig(`${base}
merge:
  enabled: false
  required_reviewers: [copilot-pull-request-reviewer]
`);
    expect(cfg.reviewers).toHaveLength(1);
    expect(cfg.reviewers[0]).toMatchObject({
      kind: 'forge',
      login: 'copilot-pull-request-reviewer',
      required_state: 'approved',
    });
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

  it('defaults inject_sha off, so the sha echo stays required unless asked', () => {
    // OFF by default because it RELAXES a check. A relaxation that arrives by
    // surprise in a config that did not ask for it is the wrong direction for
    // this tool, whatever the ergonomics.
    const cfg = loadConfig(`${base}
reviewers:
  - name: codex
    kind: command
    run: codex review --json
`);
    expect(cfg.reviewers[0]).toMatchObject({ inject_sha: false });
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

  /**
   * The upgrade is not symmetric, and the warning has to say so.
   *
   * 0.3.x accepts both shapes, but every earlier release hard-REJECTS
   * `reviewers:` — `.strict()` makes an unknown root key an error, so the gate
   * stops running rather than warning. Meanwhile rloop.yaml is normally tracked
   * and the version pin lives in an untracked .mcp.json. So an author who reads
   * "move to the `reviewers:` block" and commits it breaks the gate for every
   * colleague still below 0.3.0, at merge time, with no prior signal to them.
   *
   * Asserted as the two facts a reader has to come away with — the floor and
   * the ordering — rather than the exact sentence, so rewording is free and
   * dropping either half is not.
   */
  it('tells the migrating author to update version pins BEFORE landing the config change', () => {
    const cfg = loadConfig(`${base}
merge:
  enabled: true
  allowed_base_branches: [staging]
  required_reviewers: [copilot-pull-request-reviewer]
  required_reviewer_state: any_verdict
`);
    const dep = collectWarnings(cfg).find((w) => /deprecated/i.test(w.message));
    expect(dep?.message).toMatch(/0\.3\.0/);
    expect(dep?.message).toMatch(/before/i);
  });

  /**
   * `merge.reviewer_timeout_seconds` parses, validates, and is read by NOTHING:
   * the forge-verdict polling it was meant to bound was never built, and
   * `grep -rn reviewer_timeout_seconds src/` finds only the schema line. It is
   * kept parseable so configs in the wild still load, which means a warning is
   * the only signal an author can get. Silently accepting an inert knob is the
   * one option that misleads.
   */
  it('warns that merge.reviewer_timeout_seconds does nothing', () => {
    const cfg = loadConfig(`${base}
merge:
  enabled: true
  allowed_base_branches: [staging]
  reviewer_timeout_seconds: 900
reviewers:
  - name: copilot
    kind: forge
    login: copilot-pull-request-reviewer
    required_state: any_verdict
`);
    expect(
      collectWarnings(cfg).some((w) => /reviewer_timeout_seconds does NOTHING/.test(w.message)),
    ).toBe(true);
  });

  /**
   * The other half. The warning must key off the author having WRITTEN the key,
   * not off its presence after parsing — which is why the field is `.optional()`
   * rather than the `.default(600)` it used to carry. Restore the default and
   * this fires on every config that never mentioned it.
   */
  it('stays quiet about reviewer_timeout_seconds when the config omits it', () => {
    const cfg = loadConfig(`${base}
merge:
  enabled: true
  allowed_base_branches: [staging]
reviewers:
  - name: copilot
    kind: forge
    login: copilot-pull-request-reviewer
    required_state: any_verdict
`);
    expect(collectWarnings(cfg).some((w) => /reviewer_timeout_seconds/.test(w.message))).toBe(
      false,
    );
  });
});
