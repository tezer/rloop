# Pluggable Review Providers Implementation Plan

**Status:** executed. Shipped in 0.3.0 (PR #3, merged 2026-08-25).

## What execution falsified

Twelve defects surfaced while running this plan, and **every one was a hole in
what the plan asked to be PROVEN — none was a bug in code an implementer
wrote.** They are listed here because a plan read later as authoritative is
worse than no plan. The full record, with evidence for each, is in the
execution ledger under `.superpowers/sdd/2026-08-25-review-providers/`.

The ones that would mislead a reader of the tasks below:

- **Two mutation checks did not discriminate.** Task 2's domain-tag mutation
  and Task 3's `spawnError` test both passed with the guard deleted. Task 3's
  used a missing *binary*, but `bash -c <missing>` spawns bash successfully and
  exits 127, so the `error` handler never fired; an unspawnable *cwd* is what
  reaches it.
- **One load-bearing guard is absent from the plan entirely** — the separator
  between path and title in `fingerprint()`. Without it `'a'+'bc'` and
  `'ab'+'c'` collide.
- **Task 7's blocker-code list contradicts the report shape** it builds on, in
  the same way the spec does. Resolved by adding `FindingsReason`.
- **Task 5's `collectWarnings` text, given here verbatim to copy, asserted a
  safety property the code did not have** — it named a `reviewer_degraded`
  blocker that did not exist until Task 7.
- **Task 2's separator instructions produce a raw NUL byte** if typed with the
  Write tool, which silently turns a source file binary.
- Task 4's step text says "PASS (10 tests)" for an 11-test file; Task 8 cites
  duplicated filter logic in `report.ts`, where there is none — the second copy
  was in `merge-gate.ts`.

The out-of-scope section at the foot of this plan is accurate: the
`.rloop/reviews` store was deliberately never built.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let rloop collect external review verdicts from a local command as well as a forge bot, and degrade honestly — loudly, and never into an automatic merge — when no provider is configured or available.

**Architecture:** A new `src/reviewers/` module turns every configured reviewer, forge or command, into one `ReviewerReport`. `evaluateMergeGate` stops reading `ReviewVerdict[]` and reads `ReviewerReport[]` instead, so the merge decision has a single shape to reason about. The retired config keys keep working by desugaring into a forge reviewer.

**Tech Stack:** TypeScript (ESM, strict), zod for schemas, vitest, `node:child_process`, `node:crypto`.

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-08-25-rloop-review-providers-design.md`. Read it before Task 1.
- **Version:** ships as **0.3.0** — additive. `merge.required_reviewers` and `merge.required_reviewer_state` MUST keep working.
- **Every zod object gets `.strict()`.** Six of six do today; an unrecognised key is a refusal, and that is load-bearing for the migration story.
- **Blocking severities are `critical` and `important`. `minor` never blocks.**
- **Fingerprints are 8 lowercase hex characters** and never incorporate a line number.
- **A missing signal is a blocker, never a pass.** This rule already governs `evaluateMergeGate`; nothing added here may weaken it.
- **Every guard gets mutation-checked**: delete the guard, confirm a named test fails, restore. A guard whose deletion leaves the suite green is decoration.
- Run the full suite with `npx vitest run` from the repo root. Typecheck with `npx tsc -p tsconfig.json`.

## File Structure

**Create:**

| File | Responsibility |
|---|---|
| `src/reviewers/types.ts` | `Severity`, `Finding`, `ReviewerStatus`, `ReviewerReport`. Types only. |
| `src/reviewers/document.ts` | The zod schema for the JSON a command provider prints, and nothing else. |
| `src/reviewers/fingerprint.ts` | One pure function. Small on purpose — it is the piece most likely to be wrong. |
| `src/reviewers/read-json.ts` | Spawn a provider with stdout and stderr kept **separate**. |
| `src/reviewers/command.ts` | Run one command reviewer, classify the outcome into a `ReviewerReport`. |
| `src/reviewers/collect.ts` | Build a `ReviewerReport[]` for all configured reviewers, forge and command. |
| `test/reviewers/*.test.ts` | One test file per source file above. |
| `test/fixtures/reviewers/*` | Executable fixture providers. |

**Modify:** `src/config.ts` (schema + alias + warnings), `src/merge-gate.ts` (new input type, new blockers), `src/pr.ts` (call `collect`), `src/report.ts` (banner + fingerprints), `src/cli.ts` and `src/mcp/server.ts` (surface `degraded`), `README.md`, `examples/*.yaml`.

**Why `read-json.ts` is separate from the existing runner:** `src/exec.ts::runCommand` interleaves stdout and stderr into one buffer, deliberately — gate markers are positional. A JSON contract cannot survive that: one progress line on stderr corrupts the document. Do not "simplify" by reusing `runCommand`.

---

### Task 1: Types and the provider document schema

**Files:**
- Create: `src/reviewers/types.ts`
- Create: `src/reviewers/document.ts`
- Test: `test/reviewers/document.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `Severity`, `BLOCKING_SEVERITIES`, `Finding`, `ReviewerStatus`, `ReviewerReport` from `types.ts`; `providerDocumentSchema`, `type ProviderDocument`, `parseProviderDocument(text: string): { ok: true; doc: ProviderDocument } | { ok: false; error: string }` from `document.ts`.

- [ ] **Step 1: Write the failing test**

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/reviewers/document.test.ts`
Expected: FAIL — `Cannot find module '../../src/reviewers/document.js'`

- [ ] **Step 3: Write the implementation**

```ts
// src/reviewers/types.ts
/** Matches the classification the loop prompt already uses. */
export type Severity = 'critical' | 'important' | 'minor';

/**
 * Severities that block a merge.
 *
 * `minor` is deliberately absent: the loop prompt acts "on any critical or
 * important finding" and leaves minor ones to its convergence rules. A
 * minor-only report is clean, and its findings are still reported so the agent
 * can choose to fix them.
 */
export const BLOCKING_SEVERITIES: readonly Severity[] = ['critical', 'important'];

export interface Finding {
  /** Provider-supplied stable id, when it has one. */
  id: string | null;
  severity: Severity;
  path: string | null;
  line: number | null;
  title: string;
  body: string | null;
  /** Computed by rloop — see `fingerprint.ts`. Never supplied by the provider. */
  fingerprint: string;
  /** True when a config `dismiss` entry matches. Reported, not counted. */
  dismissed: boolean;
}

export type ReviewerStatus =
  /** Reported; nothing blocking. */
  | 'clean'
  /** Reported; blocking findings open. */
  | 'findings'
  /** Reported against a SHA that is not the head. */
  | 'stale'
  /** Forge: no review submitted yet. */
  | 'absent'
  /** Command: could not be run to a conclusion. */
  | 'unavailable'
  /** Command: ran, and its output could not be used. Distinct from unavailable. */
  | 'malformed';

export interface ReviewerReport {
  name: string;
  kind: 'forge' | 'command';
  status: ReviewerStatus;
  sha: string | null;
  /** Always empty for `kind: forge` — their findings are review threads. */
  findings: Finding[];
  /** Why, for unavailable/malformed/stale. Null when there is nothing to say. */
  detail: string | null;
}
```

```ts
// src/reviewers/document.ts
import { z } from 'zod';

/**
 * The document a `kind: command` provider prints on stdout.
 *
 * Strict, like every other schema here: a provider emitting a key rloop does
 * not know is a provider written against a different contract, and guessing
 * which half is right is how a blocking finding gets dropped.
 */
export const providerDocumentSchema = z
  .object({
    /** Echoed from RLOOP_HEAD_SHA. Proves the run is not cached; see the spec. */
    sha: z.string().min(7),
    findings: z
      .array(
        z
          .object({
            id: z.string().min(1).optional(),
            severity: z.enum(['critical', 'important', 'minor']),
            path: z.string().min(1).optional(),
            line: z.number().int().positive().optional(),
            title: z.string().min(1),
            body: z.string().optional(),
          })
          .strict(),
      )
      .default([]),
  })
  .strict();

export type ProviderDocument = z.infer<typeof providerDocumentSchema>;

export type ParseResult =
  | { ok: true; doc: ProviderDocument }
  | { ok: false; error: string };

/**
 * Parse and validate. Never throws — the caller turns a failure into a
 * `malformed` report, which is a verdict, not a crash.
 */
export function parseProviderDocument(text: string): ParseResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return { ok: false, error: `not valid JSON: ${(err as Error).message}` };
  }

  const parsed = providerDocumentSchema.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    return { ok: false, error: detail };
  }
  return { ok: true, doc: parsed.data };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/reviewers/document.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Mutation-check the severity guard**

Change `z.enum(['critical', 'important', 'minor'])` to `z.string()`. Run the test file.
Expected: `rejects an unknown severity instead of dropping the finding` FAILS.
Restore the enum, re-run, expect PASS.

- [ ] **Step 6: Commit**

```bash
git add src/reviewers/types.ts src/reviewers/document.ts test/reviewers/document.test.ts
git commit -m "feat(reviewers): provider document schema and report types"
```

---

### Task 2: Fingerprints

**Files:**
- Create: `src/reviewers/fingerprint.ts`
- Test: `test/reviewers/fingerprint.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `fingerprint(input: { id?: string | null; path?: string | null; title: string }): string` — returns 8 lowercase hex characters.

- [ ] **Step 1: Write the failing test**

```ts
// test/reviewers/fingerprint.test.ts
import { describe, expect, it } from 'vitest';
import { fingerprint } from '../../src/reviewers/fingerprint.js';

describe('fingerprint', () => {
  it('is 8 lowercase hex characters', () => {
    expect(fingerprint({ path: 'src/a.ts', title: 'Off-by-one' })).toMatch(/^[0-9a-f]{8}$/);
  });

  it('is stable when an unrelated edit moves the finding to a new line', () => {
    // THE case this function exists for. A fingerprint that changes when a line
    // number shifts reports every finding as new and every fixed one as gone,
    // which makes disappearance-on-re-run meaningless.
    const a = fingerprint({ path: 'src/a.ts', title: 'Off-by-one' });
    const b = fingerprint({ path: 'src/a.ts', title: 'Off-by-one' });
    expect(a).toBe(b);
  });

  it('ignores case and surrounding whitespace in the title', () => {
    expect(fingerprint({ path: 'src/a.ts', title: '  Off-By-One  ' })).toBe(
      fingerprint({ path: 'src/a.ts', title: 'off-by-one' }),
    );
  });

  it('collapses internal whitespace, so a rewrapped title matches', () => {
    expect(fingerprint({ path: 'src/a.ts', title: 'off by  one' })).toBe(
      fingerprint({ path: 'src/a.ts', title: 'off by one' }),
    );
  });

  it('distinguishes the same title in different files', () => {
    expect(fingerprint({ path: 'src/a.ts', title: 'x' })).not.toBe(
      fingerprint({ path: 'src/b.ts', title: 'x' }),
    );
  });

  it('prefers the provider id, so a reworded title keeps its identity', () => {
    expect(fingerprint({ id: 'codex-7', path: 'src/a.ts', title: 'first wording' })).toBe(
      fingerprint({ id: 'codex-7', path: 'src/b.ts', title: 'second wording' }),
    );
  });

  it('does not confuse an id with a path+title that happens to look like one', () => {
    expect(fingerprint({ id: 'x', title: 'y' })).not.toBe(fingerprint({ path: 'x', title: 'y' }));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/reviewers/fingerprint.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

```ts
// src/reviewers/fingerprint.ts
import { createHash } from 'node:crypto';

/**
 * Stable identity for a finding across runs.
 *
 * NEVER incorporates the line number. An edit anywhere above a finding moves
 * it, and an identity that changes on every unrelated edit would report each
 * finding as new and each fixed one as gone — destroying the only mechanism
 * local findings have for reaching zero.
 *
 * Eight hex characters is 32 bits. Collisions are a concern at millions of
 * items; a review produces tens. Short enough to type into a `dismiss` entry.
 */
export function fingerprint(input: {
  id?: string | null;
  path?: string | null;
  title: string;
}): string {
  // The domain tag keeps the two bases in separate spaces, so an id of "x"
  // cannot collide with a path of "x".
  const basis = input.id
    ? `id\u0000${input.id}`
    : `pt\u0000${input.path ?? ''}\u0000${normalizeTitle(input.title)}`;

  return createHash('sha256').update(basis, 'utf8').digest('hex').slice(0, 8);
}

/** Case- and whitespace-insensitive, so a rewrap or re-case is the same finding. */
function normalizeTitle(title: string): string {
  return title.trim().replace(/\s+/g, ' ').toLowerCase();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/reviewers/fingerprint.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 5: Mutation-check the domain tag**

Delete `id\u0000` and `pt\u0000...` tags so both bases are plain concatenations
(`input.id ? input.id : `${path}${title}``). Run the test file.
Expected: `does not confuse an id with a path+title...` FAILS. Restore, re-run, PASS.

- [ ] **Step 6: Commit**

```bash
git add src/reviewers/fingerprint.ts test/reviewers/fingerprint.test.ts
git commit -m "feat(reviewers): line-independent finding fingerprints"
```

---

### Task 3: Read a provider's JSON with streams kept apart

**Files:**
- Create: `src/reviewers/read-json.ts`
- Test: `test/reviewers/read-json.test.ts`
- Create: `test/fixtures/reviewers/clean.mjs`, `noisy-stderr.mjs`, `crash.mjs`, `hang.mjs`

**Interfaces:**
- Consumes: `GIT_ENV_OVERRIDES` from `../git.js`.
- Produces: `readProviderJson(command: string, opts: { cwd: string; timeoutMs: number; env?: Record<string, string> }): Promise<ProviderRun>` where
  `interface ProviderRun { stdout: string; stderr: string; exitCode: number | null; timedOut: boolean; spawnError: Error | null }`.

- [ ] **Step 1: Create the fixture providers**

```js
// test/fixtures/reviewers/clean.mjs
#!/usr/bin/env node
process.stdout.write(JSON.stringify({ sha: process.env.RLOOP_HEAD_SHA, findings: [] }));
```

```js
// test/fixtures/reviewers/noisy-stderr.mjs
#!/usr/bin/env node
// The case that forbids reusing exec.ts::runCommand: real tools narrate on
// stderr. Interleaved into one buffer, this document stops being parseable.
process.stderr.write('analysing 41 files...\n');
process.stdout.write(JSON.stringify({ sha: process.env.RLOOP_HEAD_SHA, findings: [] }));
process.stderr.write('done in 2.1s\n');
```

```js
// test/fixtures/reviewers/crash.mjs
#!/usr/bin/env node
process.stderr.write('boom\n');
process.exit(3);
```

```js
// test/fixtures/reviewers/hang.mjs
#!/usr/bin/env node
setInterval(() => {}, 1000);
```

- [ ] **Step 2: Write the failing test**

```ts
// test/reviewers/read-json.test.ts
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { readProviderJson } from '../../src/reviewers/read-json.js';

const FIX = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/reviewers');
const run = (f: string, timeoutMs = 15_000) =>
  readProviderJson(`node ${path.join(FIX, f)}`, {
    cwd: process.cwd(),
    timeoutMs,
    env: { RLOOP_HEAD_SHA: 'a'.repeat(40) },
  });

describe('readProviderJson', () => {
  it('returns stdout containing exactly the document', async () => {
    const r = await run('clean.mjs');
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout).findings).toEqual([]);
  });

  it('keeps stderr OUT of stdout, so narration cannot corrupt the document', async () => {
    const r = await run('noisy-stderr.mjs');
    expect(() => JSON.parse(r.stdout)).not.toThrow();
    expect(r.stderr).toContain('analysing 41 files');
    expect(r.stdout).not.toContain('analysing');
  });

  it('reports a non-zero exit without throwing', async () => {
    const r = await run('crash.mjs');
    expect(r.exitCode).toBe(3);
    expect(r.stderr).toContain('boom');
    expect(r.spawnError).toBeNull();
  });

  it('reports a spawn failure rather than throwing', async () => {
    const r = await readProviderJson('definitely-not-a-real-binary-xyz', {
      cwd: process.cwd(),
      timeoutMs: 15_000,
    });
    expect(r.exitCode).not.toBe(0);
  });

  it('times out and says so', async () => {
    const r = await run('hang.mjs', 1_000);
    expect(r.timedOut).toBe(true);
  }, 20_000);

  it('passes the supplied env through to the provider', async () => {
    const r = await run('clean.mjs');
    expect(JSON.parse(r.stdout).sha).toBe('a'.repeat(40));
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run test/reviewers/read-json.test.ts`
Expected: FAIL — module not found

- [ ] **Step 4: Write the implementation**

```ts
// src/reviewers/read-json.ts
import { spawn } from 'node:child_process';

import { GIT_ENV_OVERRIDES } from '../git.js';

export interface ProviderRun {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  spawnError: Error | null;
}

/**
 * Run a review provider and capture its streams SEPARATELY.
 *
 * `exec.ts::runCommand` cannot be reused here. It interleaves stdout and
 * stderr into one buffer on purpose — gate markers are positional — and a
 * provider that narrates progress on stderr would corrupt the JSON document
 * with it. See test/fixtures/reviewers/noisy-stderr.mjs.
 *
 * The git environment is scrubbed for the same reason gates are: a provider
 * that reads git under a leaked GIT_DIR reviews another repository and says
 * nothing about it.
 */
export function readProviderJson(
  command: string,
  opts: { cwd: string; timeoutMs: number; env?: Record<string, string> },
): Promise<ProviderRun> {
  return new Promise((resolve) => {
    const out: string[] = [];
    const err: string[] = [];
    let timedOut = false;

    const child = spawn('bash', ['-c', command], {
      cwd: opts.cwd,
      env: { ...process.env, ...GIT_ENV_OVERRIDES, ...(opts.env ?? {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });

    child.stdout.on('data', (b: Buffer) => out.push(b.toString('utf8')));
    child.stderr.on('data', (b: Buffer) => err.push(b.toString('utf8')));

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid!, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    }, opts.timeoutMs);

    const settle = (exitCode: number | null, spawnError: Error | null) => {
      clearTimeout(timer);
      resolve({
        stdout: out.join('').trim(),
        stderr: err.join('').trim(),
        exitCode,
        timedOut,
        spawnError,
      });
    };

    child.on('error', (e) => settle(null, e));
    child.on('close', (code) => settle(code, null));
  });
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/reviewers/read-json.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 6: Mutation-check the stream separation**

Change `child.stderr.on('data', ...)` to push into `out` instead of `err`. Run the test file.
Expected: `keeps stderr OUT of stdout...` FAILS. Restore, re-run, PASS.

- [ ] **Step 7: Commit**

```bash
git add src/reviewers/read-json.ts test/reviewers/read-json.test.ts test/fixtures/reviewers
git commit -m "feat(reviewers): stream-separated provider runner"
```

---

### Task 4: Classify one command reviewer into a report

**Files:**
- Create: `src/reviewers/command.ts`
- Test: `test/reviewers/command.test.ts`
- Create: `test/fixtures/reviewers/findings.mjs`, `bad-schema.mjs`, `wrong-sha.mjs`, `junk-exit-zero.mjs`

**Interfaces:**
- Consumes: `readProviderJson` (Task 3), `parseProviderDocument` (Task 1), `fingerprint` (Task 2), `ReviewerReport`/`Finding`/`BLOCKING_SEVERITIES` (Task 1).
- Produces: `runCommandReviewer(rev: { name: string; run: string; timeout_seconds: number; dismiss: Array<{ fingerprint: string; reason: string }> }, opts: { repoRoot: string; headSha: string }): Promise<ReviewerReport>`.

- [ ] **Step 1: Create the fixtures**

```js
// test/fixtures/reviewers/findings.mjs
#!/usr/bin/env node
process.stdout.write(JSON.stringify({
  sha: process.env.RLOOP_HEAD_SHA,
  findings: [
    { severity: 'critical', path: 'src/a.ts', line: 10, title: 'Unchecked null' },
    { severity: 'minor', path: 'src/b.ts', title: 'Wording' },
  ],
}));
```

```js
// test/fixtures/reviewers/bad-schema.mjs
#!/usr/bin/env node
// Valid JSON, wrong contract: ran fine, output unusable => malformed.
process.stdout.write(JSON.stringify({ sha: process.env.RLOOP_HEAD_SHA, results: [] }));
```

```js
// test/fixtures/reviewers/wrong-sha.mjs
#!/usr/bin/env node
process.stdout.write(JSON.stringify({ sha: 'c'.repeat(40), findings: [] }));
```

```js
// test/fixtures/reviewers/junk-exit-zero.mjs
#!/usr/bin/env node
process.stdout.write('Reviewed 3 files. Looks good!');
```

```js
// test/fixtures/reviewers/minor-only.mjs
#!/usr/bin/env node
process.stdout.write(JSON.stringify({
  sha: process.env.RLOOP_HEAD_SHA,
  findings: [{ severity: 'minor', path: 'src/b.ts', title: 'Wording' }],
}));
```

- [ ] **Step 2: Write the failing test**

```ts
// test/reviewers/command.test.ts
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { runCommandReviewer } from '../../src/reviewers/command.js';

const FIX = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/reviewers');
const HEAD = 'a'.repeat(40);
const rev = (file: string, dismiss: Array<{ fingerprint: string; reason: string }> = []) => ({
  name: 'codex',
  run: `node ${path.join(FIX, file)}`,
  timeout_seconds: 15,
  dismiss,
});
const go = (file: string, dismiss?: Array<{ fingerprint: string; reason: string }>) =>
  runCommandReviewer(rev(file, dismiss), { repoRoot: process.cwd(), headSha: HEAD });

describe('runCommandReviewer', () => {
  it('reports clean when the document has no findings', async () => {
    expect((await go('clean.mjs')).status).toBe('clean');
  });

  it('reports findings, and computes a fingerprint for each', async () => {
    const r = await go('findings.mjs');
    expect(r.status).toBe('findings');
    expect(r.findings).toHaveLength(2);
    for (const f of r.findings) expect(f.fingerprint).toMatch(/^[0-9a-f]{8}$/);
  });

  it('is clean when only MINOR findings are present', async () => {
    // minor never blocks, but the findings still travel in the report.
    const r = await go('minor-only.mjs');
    expect(r.status).toBe('clean');
    expect(r.findings).toHaveLength(1);
  });

  it('names dismissals that matched nothing, so dead entries can be deleted', async () => {
    // A dismissal list that quietly accumulates unmatched entries is how a
    // real finding gets pre-suppressed by accident. Warning, not an error:
    // the usual cause is that the finding was genuinely fixed.
    const r = await go('clean.mjs', [{ fingerprint: 'deadbeef', reason: 'stale entry' }]);
    expect(r.status).toBe('clean');
    expect(r.detail).toContain('deadbeef');
  });

  it('reports unavailable when the command cannot be spawned', async () => {
    const r = await runCommandReviewer(
      { ...rev('clean.mjs'), run: 'definitely-not-a-real-binary-xyz' },
      { repoRoot: process.cwd(), headSha: HEAD },
    );
    expect(r.status).toBe('unavailable');
  });

  it('reports unavailable when the command crashes without a document', async () => {
    expect((await go('crash.mjs')).status).toBe('unavailable');
  });

  it('reports MALFORMED, not unavailable, when it exits 0 with junk', async () => {
    // The distinction is the point: a reviewer you broke is a different
    // problem from one you never had.
    expect((await go('junk-exit-zero.mjs')).status).toBe('malformed');
  });

  it('reports malformed when valid JSON fails the schema', async () => {
    expect((await go('bad-schema.mjs')).status).toBe('malformed');
  });

  it('reports stale when the echoed sha is not the head', async () => {
    const r = await go('wrong-sha.mjs');
    expect(r.status).toBe('stale');
    expect(r.detail).toContain('c'.repeat(7));
  });

  it('times out into unavailable', async () => {
    const r = await runCommandReviewer(
      { ...rev('hang.mjs'), timeout_seconds: 1 },
      { repoRoot: process.cwd(), headSha: HEAD },
    );
    expect(r.status).toBe('unavailable');
    expect(r.detail).toMatch(/timed out/i);
  }, 20_000);

  it('a dismissed blocking finding is reported but does not block', async () => {
    const first = await go('findings.mjs');
    const critical = first.findings.find((f) => f.severity === 'critical')!;
    const r = await go('findings.mjs', [
      { fingerprint: critical.fingerprint, reason: 'guard is in the caller' },
    ]);
    expect(r.status).toBe('clean');
    expect(r.findings.find((f) => f.fingerprint === critical.fingerprint)?.dismissed).toBe(true);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run test/reviewers/command.test.ts`
Expected: FAIL — module not found

- [ ] **Step 4: Write the implementation**

```ts
// src/reviewers/command.ts
import { parseProviderDocument } from './document.js';
import { fingerprint } from './fingerprint.js';
import { readProviderJson } from './read-json.js';
import { BLOCKING_SEVERITIES, type Finding, type ReviewerReport } from './types.js';

export interface CommandReviewer {
  name: string;
  run: string;
  timeout_seconds: number;
  dismiss: Array<{ fingerprint: string; reason: string }>;
}

const short = (sha: string) => sha.slice(0, 7);

/**
 * Run one command reviewer and classify the outcome.
 *
 * Classification order matters and is the whole contract:
 *
 *   spawn failed / timed out          -> unavailable  (never ran)
 *   unparseable AND exit != 0         -> unavailable  (crashed mid-review)
 *   unparseable AND exit == 0         -> malformed    (ran fine, printed junk)
 *   parsed but fails the schema       -> malformed
 *   echoed sha != head                -> stale
 *   blocking findings present         -> findings
 *   otherwise                         -> clean
 *
 * Nothing here returns clean on a path where the review did not happen.
 */
export async function runCommandReviewer(
  rev: CommandReviewer,
  opts: { repoRoot: string; headSha: string },
): Promise<ReviewerReport> {
  const base = { name: rev.name, kind: 'command' as const, sha: null, findings: [] };

  const run = await readProviderJson(rev.run, {
    cwd: opts.repoRoot,
    timeoutMs: rev.timeout_seconds * 1000,
    env: { RLOOP_HEAD_SHA: opts.headSha },
  });

  if (run.spawnError) {
    return { ...base, status: 'unavailable', detail: `could not start: ${run.spawnError.message}` };
  }
  if (run.timedOut) {
    return { ...base, status: 'unavailable', detail: `timed out after ${rev.timeout_seconds}s` };
  }

  const parsed = parseProviderDocument(run.stdout);
  if (!parsed.ok) {
    if (run.exitCode !== 0) {
      return {
        ...base,
        status: 'unavailable',
        detail: `exited ${run.exitCode} without a usable document: ${run.stderr.slice(0, 200)}`,
      };
    }
    return { ...base, status: 'malformed', detail: parsed.error };
  }

  if (parsed.doc.sha !== opts.headSha) {
    return {
      ...base,
      status: 'stale',
      sha: parsed.doc.sha,
      detail:
        `reviewed ${short(parsed.doc.sha)} but head is ${short(opts.headSha)} — ` +
        `a cached or stale run`,
    };
  }

  const dismissed = new Set(rev.dismiss.map((d) => d.fingerprint));
  const findings: Finding[] = parsed.doc.findings.map((f) => {
    const fp = fingerprint({ id: f.id, path: f.path, title: f.title });
    return {
      id: f.id ?? null,
      severity: f.severity,
      path: f.path ?? null,
      line: f.line ?? null,
      title: f.title,
      body: f.body ?? null,
      fingerprint: fp,
      dismissed: dismissed.has(fp),
    };
  });

  const blocking = findings.filter(
    (f) => !f.dismissed && BLOCKING_SEVERITIES.includes(f.severity),
  );

  // A dismissal that matches nothing is usually a finding that was genuinely
  // fixed, so this is a warning rather than an error — erroring would punish
  // the good outcome. It is never SILENT: an accumulating dismissal list is
  // how a future real finding gets pre-suppressed by accident.
  const seen = new Set(findings.map((f) => f.fingerprint));
  const unmatched = rev.dismiss.filter((d) => !seen.has(d.fingerprint)).map((d) => d.fingerprint);
  const detail =
    unmatched.length > 0
      ? `dismissals matching nothing at head (delete them): ${unmatched.join(', ')}`
      : null;

  return {
    ...base,
    status: blocking.length > 0 ? 'findings' : 'clean',
    sha: parsed.doc.sha,
    findings,
    detail,
  };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/reviewers/command.test.ts`
Expected: PASS (10 tests)

- [ ] **Step 6: Mutation-check the unavailable/malformed split**

Replace the `if (run.exitCode !== 0)` branch so both cases return `malformed`. Run the test file.
Expected: `reports unavailable when the command crashes without a document` FAILS.
Restore, re-run, PASS.

- [ ] **Step 7: Mutation-check the stale guard**

Delete the `parsed.doc.sha !== opts.headSha` block. Run the test file.
Expected: `reports stale when the echoed sha is not the head` FAILS. Restore, re-run, PASS.

- [ ] **Step 8: Commit**

```bash
git add src/reviewers/command.ts test/reviewers/command.test.ts test/fixtures/reviewers
git commit -m "feat(reviewers): classify a command provider's outcome"
```

---

### Task 5: Config — `reviewers:`, the deprecated alias, and warnings

**Files:**
- Modify: `src/config.ts`
- Test: `test/config.test.ts` (append)

**Interfaces:**
- Consumes: nothing from earlier tasks (config is standalone).
- Produces: `cfg.reviewers` as `Array<{ name: string; kind: 'forge'; login: string; required_state: 'approved' | 'any_verdict' } | { name: string; kind: 'command'; run: string; timeout_seconds: number; dismiss: Array<{ fingerprint: string; reason: string }> }>`. Always populated after load — the deprecated keys desugar into it, so no consumer reads `merge.required_reviewers` again.

- [ ] **Step 1: Write the failing test**

```ts
// test/config.test.ts — append
import { collectWarnings, loadConfig } from '../src/config.js';

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/config.test.ts`
Expected: FAIL — `Unrecognized key(s) in object: 'reviewers'`

- [ ] **Step 3: Add the schema to `src/config.ts`**

Insert above `configSchema`:

```ts
const dismissalSchema = z
  .object({
    /** 8 hex characters, as printed next to the finding in rloop's report. */
    fingerprint: z.string().regex(/^[0-9a-f]{8}$/, 'fingerprint must be 8 lowercase hex chars'),
    /**
     * Required. A dismissal without a stated reason is indistinguishable from
     * a finding somebody silenced because it was inconvenient.
     */
    reason: z.string().min(1),
  })
  .strict();

const forgeReviewerSchema = z
  .object({
    name: z.string().min(1),
    kind: z.literal('forge'),
    /** Login, not display name. See README for the Copilot form. */
    login: z.string().min(1),
    /**
     * Per-reviewer, because it always was: a comment-only bot needs
     * `any_verdict` and a human needs `approved`, and one global setting
     * cannot express both.
     */
    required_state: z.enum(['approved', 'any_verdict']),
  })
  .strict();

const commandReviewerSchema = z
  .object({
    name: z.string().min(1),
    kind: z.literal('command'),
    run: z.string().min(1),
    timeout_seconds: z.number().int().positive().max(3600).default(600),
    dismiss: z.array(dismissalSchema).default([]),
  })
  .strict();

const reviewerSchema = z.discriminatedUnion('kind', [forgeReviewerSchema, commandReviewerSchema]);
```

Add to `configSchema`'s object, after `forge`:

```ts
    reviewers: z.array(reviewerSchema).default([]),
```

Extend `configSchema`'s `.superRefine` with:

```ts
    const usesDeprecated =
      cfg.merge.required_reviewers.length > 0 || cfg.merge.required_reviewer_state !== undefined;

    if (cfg.reviewers.length > 0 && usesDeprecated) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'both `reviewers:` and the deprecated `merge.required_reviewers` / ' +
          '`merge.required_reviewer_state` are set. Pick one — merging them silently ' +
          'would give two sources of truth for who must review this PR.',
      });
    }

    const names = new Set<string>();
    for (const r of cfg.reviewers) {
      if (names.has(r.name)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `duplicate reviewer name "${r.name}" — names must be unique (they key the report)`,
        });
      }
      names.add(r.name);
    }
```

- [ ] **Step 4: Desugar the deprecated keys in `loadConfig`**

Replace the `return parsed.data;` line at the end of `loadConfig`:

```ts
  return desugarDeprecatedReviewers(parsed.data);
}

/**
 * Turn `merge.required_reviewers` into `reviewers:` entries.
 *
 * Runs after validation, so every consumer sees one shape and nothing below
 * this line reads the deprecated keys. They stay on the config object because
 * `collectWarnings` reports them and removing them would be the breaking
 * change this function exists to avoid — rloop 0.2.1 is published, and configs
 * in the wild use them.
 */
function desugarDeprecatedReviewers(cfg: RloopConfig): RloopConfig {
  if (cfg.reviewers.length > 0 || cfg.merge.required_reviewers.length === 0) return cfg;

  // superRefine on mergeSchema already requires required_reviewer_state when
  // merge is enabled with reviewers; `approved` is the safe read otherwise.
  const required_state = cfg.merge.required_reviewer_state ?? 'approved';

  return {
    ...cfg,
    reviewers: cfg.merge.required_reviewers.map((login) => ({
      name: login,
      kind: 'forge' as const,
      login,
      required_state,
    })),
  };
}
```

- [ ] **Step 5: Add the deprecation warning to `collectWarnings`**

Replace the existing `cfg.merge.enabled && cfg.merge.required_reviewers.length === 0` block with:

```ts
  if (cfg.merge.required_reviewers.length > 0) {
    warnings.push({
      message:
        'merge.required_reviewers / merge.required_reviewer_state are DEPRECATED and will ' +
        'be removed in 1.0. They now desugar into `reviewers:` entries. Move to the ' +
        '`reviewers:` block, which also accepts `kind: command` local providers.',
    });
  }

  if (cfg.merge.enabled && cfg.reviewers.length === 0) {
    warnings.push({
      message:
        'merge.enabled is true with no reviewers configured: local gates are the only ' +
        'thing standing between a generated PR and the base branch. rloop will refuse ' +
        'to merge (reviewer_degraded) rather than proceed on gates alone.',
    });
  }
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run test/config.test.ts && npx tsc -p tsconfig.json`
Expected: PASS, and a clean typecheck.

- [ ] **Step 7: Mutation-check the both-forms refusal**

Delete the `cfg.reviewers.length > 0 && usesDeprecated` issue. Run the test file.
Expected: `REFUSES a config that uses both forms` FAILS. Restore, re-run, PASS.

- [ ] **Step 8: Commit**

```bash
git add src/config.ts test/config.test.ts
git commit -m "feat(config): reviewers block, with the old keys desugaring into it"
```

---

### Task 6: Collect every reviewer into reports

**Files:**
- Create: `src/reviewers/collect.ts`
- Test: `test/reviewers/collect.test.ts`

**Interfaces:**
- Consumes: `runCommandReviewer` (Task 4), `cfg.reviewers` (Task 5), `matchesReviewer` and `ReviewVerdict` from `../forge/types.js`.
- Produces:
  - `collectReviewerReports(cfg: RloopConfig, opts: { repoRoot: string; headSha: string; reviews: ReviewVerdict[] }): Promise<ReviewerReport[]>`
  - `type DegradedReason = 'not_configured' | 'unavailable' | 'malformed'`
  - `degradationOf(reports: ReviewerReport[], cfg: RloopConfig): { reason: DegradedReason; provider: string | null; message: string } | null`

- [ ] **Step 1: Write the failing test**

```ts
// test/reviewers/collect.test.ts
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import type { ReviewVerdict } from '../../src/forge/types.js';
import { collectReviewerReports, degradationOf } from '../../src/reviewers/collect.js';

const HEAD = 'a'.repeat(40);
const OLD = 'b'.repeat(40);
const base = `
version: 1
gates:
  - name: build
    run: npm run build
    require: ["^ok$"]
`;
const forgeCfg = loadConfig(`${base}
reviewers:
  - name: copilot
    kind: forge
    login: copilot-pull-request-reviewer
    required_state: any_verdict
`);
const review = (over: Partial<ReviewVerdict> = {}): ReviewVerdict => ({
  author: 'copilot-pull-request-reviewer',
  state: 'COMMENTED',
  sha: HEAD,
  submittedAt: '2026-08-25T10:00:00Z',
  ...over,
});
const collect = (cfg = forgeCfg, reviews: ReviewVerdict[] = []) =>
  collectReviewerReports(cfg, { repoRoot: process.cwd(), headSha: HEAD, reviews });

describe('collectReviewerReports — forge', () => {
  it('reports absent when the reviewer has not reviewed', async () => {
    expect((await collect()).at(0)!.status).toBe('absent');
  });

  it('reports clean for a COMMENTED review under any_verdict', async () => {
    expect((await collect(forgeCfg, [review()])).at(0)!.status).toBe('clean');
  });

  it('reports findings for a COMMENTED review under approved', async () => {
    const cfg = loadConfig(`${base}
reviewers:
  - name: copilot
    kind: forge
    login: copilot-pull-request-reviewer
    required_state: approved
`);
    expect((await collect(cfg, [review()])).at(0)!.status).toBe('findings');
  });

  it('reports stale when the latest review is against another sha', async () => {
    expect((await collect(forgeCfg, [review({ sha: OLD })])).at(0)!.status).toBe('stale');
  });

  it('uses the LATEST review, not the first', async () => {
    const reports = await collect(forgeCfg, [
      review({ state: 'CHANGES_REQUESTED', submittedAt: '2026-08-25T09:00:00Z' }),
      review({ state: 'APPROVED', submittedAt: '2026-08-25T11:00:00Z' }),
    ]);
    expect(reports.at(0)!.status).toBe('clean');
  });

  it('leaves findings empty for a forge reviewer', async () => {
    expect((await collect(forgeCfg, [review()])).at(0)!.findings).toEqual([]);
  });
});

describe('degradationOf', () => {
  it('is not_configured when no reviewers are declared', async () => {
    const cfg = loadConfig(base);
    const d = degradationOf(await collectReviewerReports(cfg, {
      repoRoot: process.cwd(), headSha: HEAD, reviews: [],
    }), cfg);
    expect(d?.reason).toBe('not_configured');
  });

  it('is null when a reviewer reported, even with findings', async () => {
    expect(degradationOf(await collect(forgeCfg, [review()]), forgeCfg)).toBeNull();
  });

  it('is NOT degraded merely because a forge reviewer is absent', async () => {
    // Absence is already a merge blocker with its own code. Calling it
    // degradation would report "no provider available" when one is configured
    // and simply has not answered yet.
    expect(degradationOf(await collect(), forgeCfg)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/reviewers/collect.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

```ts
// src/reviewers/collect.ts
import type { RloopConfig } from '../config.js';
import { matchesReviewer, type ReviewVerdict } from '../forge/types.js';
import { runCommandReviewer } from './command.js';
import type { ReviewerReport } from './types.js';

export type DegradedReason = 'not_configured' | 'unavailable' | 'malformed';

export interface Degradation {
  reason: DegradedReason;
  /** The reviewer that failed, or null for `not_configured`. */
  provider: string | null;
  message: string;
}

const short = (sha: string) => sha.slice(0, 7);

/**
 * One report per configured reviewer, in config order.
 *
 * Sequential by design. Parallelism is an optimisation and no measurement
 * yet says it is needed; running unknown third-party commands concurrently
 * also multiplies whatever they do to the working tree.
 */
export async function collectReviewerReports(
  cfg: RloopConfig,
  opts: { repoRoot: string; headSha: string; reviews: ReviewVerdict[] },
): Promise<ReviewerReport[]> {
  const reports: ReviewerReport[] = [];

  for (const rev of cfg.reviewers) {
    if (rev.kind === 'command') {
      reports.push(await runCommandReviewer(rev, opts));
      continue;
    }
    reports.push(forgeReport(rev, opts));
  }

  return reports;
}

function forgeReport(
  rev: Extract<RloopConfig['reviewers'][number], { kind: 'forge' }>,
  opts: { headSha: string; reviews: ReviewVerdict[] },
): ReviewerReport {
  const base = { name: rev.name, kind: 'forge' as const, findings: [] };
  const theirs = opts.reviews.filter((r) => matchesReviewer(rev.login, r.author));

  if (theirs.length === 0) {
    return {
      ...base,
      status: 'absent',
      sha: null,
      detail: `no review from "${rev.login}" yet. Absence of a verdict is not approval.`,
    };
  }

  const latest = theirs.reduce((a, b) => ((b.submittedAt ?? '') >= (a.submittedAt ?? '') ? b : a));

  if (latest.sha !== opts.headSha) {
    return {
      ...base,
      status: 'stale',
      sha: latest.sha,
      detail: `reviewed ${short(latest.sha)} but head is ${short(opts.headSha)}`,
    };
  }

  // `findings` stays empty: a forge reviewer's findings are review threads,
  // gated by merge.require_threads_resolved. Two mechanisms for one fact is
  // how they drift apart.
  if (latest.state === 'CHANGES_REQUESTED') {
    return { ...base, status: 'findings', sha: latest.sha, detail: 'changes requested' };
  }
  if (rev.required_state === 'approved' && latest.state !== 'APPROVED') {
    return {
      ...base,
      status: 'findings',
      sha: latest.sha,
      detail: `left a ${latest.state} review, and required_state is "approved"`,
    };
  }
  return { ...base, status: 'clean', sha: latest.sha, detail: null };
}

/**
 * Whether the external review stream is degraded, and why.
 *
 * `absent` is NOT degradation: the reviewer is configured and has simply not
 * answered yet, which the merge gate already blocks on by its own code.
 * Degradation means rloop could not obtain a stream at all.
 */
export function degradationOf(
  reports: ReviewerReport[],
  cfg: RloopConfig,
): Degradation | null {
  if (cfg.reviewers.length === 0) {
    return {
      reason: 'not_configured',
      provider: null,
      message:
        'No reviewers configured. Gates ran, but there is no external review stream — ' +
        'rloop will not merge on gates alone.',
    };
  }

  const broken = reports.find((r) => r.status === 'unavailable' || r.status === 'malformed');
  if (broken) {
    return {
      reason: broken.status as DegradedReason,
      provider: broken.name,
      message: `Reviewer "${broken.name}" is ${broken.status}: ${broken.detail ?? 'no detail'}`,
    };
  }

  return null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/reviewers/collect.test.ts`
Expected: PASS (9 tests)

- [ ] **Step 5: Mutation-check the latest-review selection**

Change the `reduce` to `theirs[0]`. Run the test file.
Expected: `uses the LATEST review, not the first` FAILS. Restore, re-run, PASS.

- [ ] **Step 6: Commit**

```bash
git add src/reviewers/collect.ts test/reviewers/collect.test.ts
git commit -m "feat(reviewers): collect forge and command reviewers into one shape"
```

---

### Task 7: Merge gate consumes reports

**Files:**
- Modify: `src/merge-gate.ts`
- Modify: `test/merge-gate.test.ts`
- Modify: `src/pr.ts:41-71`

**Interfaces:**
- Consumes: `ReviewerReport` (Task 1), `collectReviewerReports` / `degradationOf` / `Degradation` (Task 6).
- Produces: `MergeGateInput` gains `reviewerReports: ReviewerReport[]` and `degradation: Degradation | null`, and loses `reviews`. `BlockerCode` gains `reviewer_degraded`, `reviewer_unavailable`, `reviewer_malformed`, `reviewer_findings_open`. `PrStatus` gains `reviewerReports` and `degradation`.

- [ ] **Step 1: Write the failing test**

Append to `test/merge-gate.test.ts`:

```ts
import type { ReviewerReport } from '../src/reviewers/types.js';

const report = (over: Partial<ReviewerReport> = {}): ReviewerReport => ({
  name: 'copilot',
  kind: 'forge',
  status: 'clean',
  sha: HEAD,
  findings: [],
  detail: null,
  ...over,
});

const codes = (over: Partial<Parameters<typeof evaluateMergeGate>[0]> = {}): BlockerCode[] =>
  evaluateMergeGate({
    cfg: cfg(),
    pr: pr(),
    gateRun: greenRun(),
    reviewerReports: [report()],
    degradation: null,
    threads: [],
    ...over,
  }).blockers.map((b) => b.code);

describe('reviewer reports', () => {
  it('allows a merge when every reviewer is clean', () => {
    expect(codes()).toEqual([]);
  });

  it('blocks on degradation, whatever else is green', () => {
    expect(
      codes({
        degradation: { reason: 'not_configured', provider: null, message: 'none configured' },
        reviewerReports: [],
      }),
    ).toContain('reviewer_degraded');
  });

  it('blocks an unavailable reviewer with its own code', () => {
    expect(codes({ reviewerReports: [report({ status: 'unavailable', detail: 'ENOENT' })] }))
      .toContain('reviewer_unavailable');
  });

  it('blocks a malformed reviewer separately from an unavailable one', () => {
    expect(codes({ reviewerReports: [report({ status: 'malformed', detail: 'bad json' })] }))
      .toContain('reviewer_malformed');
  });

  it('blocks open findings', () => {
    expect(codes({ reviewerReports: [report({ status: 'findings' })] }))
      .toContain('reviewer_findings_open');
  });

  it('blocks a stale reviewer', () => {
    expect(codes({ reviewerReports: [report({ status: 'stale', sha: OLD })] }))
      .toContain('reviewer_stale');
  });

  it('blocks an absent reviewer', () => {
    expect(codes({ reviewerReports: [report({ status: 'absent', sha: null })] }))
      .toContain('reviewer_no_verdict');
  });

  it('reports EVERY blocker, not just the first', () => {
    const c = codes({
      pr: pr({ isDraft: true }),
      reviewerReports: [report({ status: 'unavailable' })],
    });
    expect(c).toContain('pr_draft');
    expect(c).toContain('reviewer_unavailable');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/merge-gate.test.ts`
Expected: FAIL — `reviewerReports` is not a known property, and the old `reviews` argument is missing.

- [ ] **Step 3: Rewrite the reviewer section of `src/merge-gate.ts`**

Update the imports and the `BlockerCode` union:

```ts
import type { RloopConfig } from './config.js';
import type { PullRequest, ReviewThread } from './forge/types.js';
import type { Degradation } from './reviewers/collect.js';
import type { ReviewerReport } from './reviewers/types.js';
import type { GateRunResult } from './types.js';

export type BlockerCode =
  | 'merge_disabled'
  | 'base_not_allowed'
  | 'pr_not_open'
  | 'pr_draft'
  | 'gates_not_green'
  | 'sha_mismatch_gates'
  | 'reviewer_degraded'
  | 'reviewer_no_verdict'
  | 'reviewer_stale'
  | 'reviewer_unavailable'
  | 'reviewer_malformed'
  | 'reviewer_findings_open'
  | 'threads_unresolved';
```

Change `MergeGateInput`:

```ts
export interface MergeGateInput {
  cfg: RloopConfig;
  pr: PullRequest;
  gateRun: GateRunResult;
  reviewerReports: ReviewerReport[];
  degradation: Degradation | null;
  threads: ReviewThread[];
}
```

Replace the whole `for (const required of cfg.merge.required_reviewers) { ... }` loop with:

```ts
  // Degradation blocks unconditionally. The operator chose: rloop may run
  // everything else without an external reviewer, but it may not MERGE
  // without one. A provider that is merely down is indistinguishable at
  // runtime from one deliberately absent, and merging through the second
  // silently merges through the first.
  if (input.degradation) {
    blockers.push({
      code: 'reviewer_degraded',
      message:
        `External review is degraded (${input.degradation.reason}): ` +
        `${input.degradation.message} Gates still ran; the merge does not.`,
    });
  }

  for (const r of input.reviewerReports) {
    switch (r.status) {
      case 'clean':
        break;
      case 'absent':
        blockers.push({
          code: 'reviewer_no_verdict',
          message: `No review from "${r.name}" at all. Absence of a verdict is NOT approval.`,
        });
        break;
      case 'stale':
        blockers.push({
          code: 'reviewer_stale',
          message:
            `Latest review from "${r.name}" is against ${short(r.sha ?? '')}, but PR head is ` +
            `${short(pr.headSha)}. Stale — re-request review on the current commit.`,
        });
        break;
      case 'unavailable':
        blockers.push({
          code: 'reviewer_unavailable',
          message: `Reviewer "${r.name}" could not run: ${r.detail ?? 'no detail'}`,
        });
        break;
      case 'malformed':
        blockers.push({
          code: 'reviewer_malformed',
          message:
            `Reviewer "${r.name}" ran but its output could not be used: ${r.detail ?? 'no detail'}. ` +
            `A reviewer you broke is a different problem from one you never had — fix the wrapper.`,
        });
        break;
      case 'findings': {
        const open = r.findings.filter((f) => !f.dismissed);
        const sample = open.slice(0, 3).map((f) => `${f.fingerprint} ${f.title}`).join('; ');
        blockers.push({
          code: 'reviewer_findings_open',
          message:
            `"${r.name}" has open findings${sample ? `: ${sample}` : ''}` +
            (open.length > 3 ? ` (+${open.length - 3} more)` : '') +
            (r.detail ? ` — ${r.detail}` : ''),
        });
        break;
      }
    }
  }
```

- [ ] **Step 4: Update `src/pr.ts`**

Replace lines 41-44 and the `evaluateMergeGate` call:

```ts
  const [reviews, threads] = await Promise.all([
    forge.listReviews(opts.prNumber),
    forge.listReviewThreads(opts.prNumber),
  ]);
```

…stays. After `gateRun` is computed, add:

```ts
  const reviewerReports = await collectReviewerReports(cfg, {
    repoRoot: opts.repoRoot,
    headSha: pr.headSha,
    reviews,
  });
  const degradation = degradationOf(reviewerReports, cfg);

  const decision = evaluateMergeGate({
    cfg,
    pr,
    gateRun,
    reviewerReports,
    degradation,
    threads,
  });
  return { pr, gateRun, reviews, threads, reviewerReports, degradation, decision };
```

Add to imports:

```ts
import { collectReviewerReports, degradationOf, type Degradation } from './reviewers/collect.js';
import type { ReviewerReport } from './reviewers/types.js';
```

Extend `PrStatus`:

```ts
export interface PrStatus {
  pr: PullRequest;
  gateRun: GateRunResult;
  reviews: ReviewVerdict[];
  threads: ReviewThread[];
  reviewerReports: ReviewerReport[];
  degradation: Degradation | null;
  decision: MergeDecision;
}
```

- [ ] **Step 5: Run the full suite and typecheck**

Run: `npx vitest run && npx tsc -p tsconfig.json`
Expected: PASS. Existing merge-gate tests that passed `reviews:` must have been updated to `reviewerReports:` — fix any that were missed.

- [ ] **Step 6: Mutation-check the degradation blocker**

Delete the `if (input.degradation)` block. Run `npx vitest run test/merge-gate.test.ts`.
Expected: `blocks on degradation, whatever else is green` FAILS. Restore, re-run, PASS.

- [ ] **Step 7: Commit**

```bash
git add src/merge-gate.ts src/pr.ts test/merge-gate.test.ts
git commit -m "feat(merge-gate): decide from reviewer reports, and refuse to merge when degraded"
```

---

### Task 8: Surface it — CLI banner, fingerprints, MCP field

**Files:**
- Modify: `src/report.ts:86-128` (`formatPrStatus`)
- Modify: `src/mcp/server.ts` (the `pr_status` and `pr_merge` handlers)
- Test: `test/reviewers/report.test.ts`

**Interfaces:**
- Consumes: `PrStatus` with `reviewerReports` and `degradation` (Task 7).
- Produces: `formatDegradation(d: Degradation | null): string` exported from `src/report.ts` — empty string when null.

- [ ] **Step 1: Write the failing test**

```ts
// test/reviewers/report.test.ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/reviewers/report.test.ts`
Expected: FAIL — `formatDegradation` is not exported

- [ ] **Step 3: Add `formatDegradation` to `src/report.ts`**

```ts
import type { Degradation } from './reviewers/collect.js';

/**
 * The in-band notification.
 *
 * rloop has no channel to the operator except its own output, so this is the
 * whole notification mechanism — it must be unmissable in a scrollback and
 * must state what rloop did and did not do, rather than leaving it inferred.
 */
export function formatDegradation(d: Degradation | null): string {
  if (!d) return '';
  const who = d.provider ? ` [${d.provider}]` : '';
  return [
    '',
    '  ⚠ EXTERNAL REVIEW DEGRADED — ' + d.reason + who,
    '    ' + d.message,
    '    Gates still ran. rloop will NOT merge without an external review stream.',
    '',
  ].join('\n');
}
```

- [ ] **Step 4: Render it in `formatPrStatus`**

Inside `formatPrStatus`, immediately after the PR header line, insert:

```ts
  out.push(formatDegradation(s.degradation ?? null));
```

Then render each reviewer report, and print fingerprints — a dismissal is keyed
on one, so a fingerprint the operator cannot see is a feature nobody can use:

```ts
  for (const r of s.reviewerReports ?? []) {
    const mark = r.status === 'clean' ? '✓' : r.status === 'findings' ? '✗' : '~';
    out.push(`  ${mark} ${r.name} (${r.kind}): ${r.status}${r.detail ? ` — ${r.detail}` : ''}`);
    for (const f of r.findings) {
      const tag = f.dismissed ? 'dismissed' : f.severity;
      out.push(`      ${f.fingerprint}  ${tag.padEnd(9)} ${f.title}`);
    }
  }
```

Widen `formatPrStatus`'s parameter type to include the two new fields as optional.

- [ ] **Step 5: Add `degraded` to the MCP verdict**

In `src/mcp/server.ts`, in the `pr_status` and `pr_merge` handlers, include the
field on the returned object:

```ts
        degraded: status.degradation,
```

- [ ] **Step 6: Run the full suite and typecheck**

Run: `npx vitest run && npx tsc -p tsconfig.json`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/report.ts src/mcp/server.ts test/reviewers/report.test.ts
git commit -m "feat(report): degraded banner, reviewer lines, and visible fingerprints"
```

---

### Task 9: Documentation and examples

**Files:**
- Modify: `README.md` (9 sites — see table)
- Modify: `examples/next-vitest.yaml`, `examples/python-pytest.yaml`, `examples/rust-cargo.yaml`
- Modify: `package.json` (version 0.3.0)

- [ ] **Step 1: Re-run the grep rather than trusting the counted table**

```bash
git grep -n "required_reviewers\|required_reviewer_state\|reviewer_timeout_seconds" -- README.md examples src test
```

Counts at the time of writing — re-derive, do not assume:

| File | `required_reviewers` | `required_reviewer_state` | `reviewer_timeout_seconds` |
|---|---|---|---|
| `README.md` | 6 | 2 | 1 |
| `examples/next-vitest.yaml` | 1 | 1 | 1 |
| `examples/python-pytest.yaml` | 1 | 1 | 1 |
| `examples/rust-cargo.yaml` | 1 | 1 | 1 |

- [ ] **Step 2: Update the three examples to the `reviewers:` block**

For each example file, replace the `required_reviewers` / `required_reviewer_state`
lines inside `merge:` with a top-level block:

```yaml
reviewers:
  - name: copilot
    kind: forge
    login: copilot-pull-request-reviewer
    required_state: any_verdict

  # A second opinion that never touches the network. Must print one JSON
  # document on stdout — narration belongs on stderr.
  # - name: codex
  #   kind: command
  #   run: codex review --base origin/main --json
```

`examples/rust-cargo.yaml` and `examples/python-pytest.yaml` are marked
unvalidated; leave those markers in place.

- [ ] **Step 3: Add a README section documenting the contract**

Add after the existing reviewer section: the JSON document shape, the
`RLOOP_HEAD_SHA` echo and exactly what it does and does not prove, the
classification table from `command.ts`'s docstring, the blocking-severity rule,
the fingerprint rule, and the deprecation notice with the migration example.

- [ ] **Step 4: Verify every example still loads**

```bash
for f in examples/*.yaml; do node dist/cli.js check -c "$f" || echo "FAILED: $f"; done
```

Expected: `config OK` for each. Build first with `npx tsc -p tsconfig.json`.

- [ ] **Step 5: Bump the version**

```bash
npm version minor --no-git-tag-version   # 0.2.1 -> 0.3.0
```

- [ ] **Step 6: Full verification**

```bash
npx vitest run && npx tsc -p tsconfig.json
```

Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add README.md examples package.json package-lock.json
git commit -m "docs(reviewers): document the command contract and the deprecation"
```

---

## Out of scope, deliberately

- **The `.rloop/reviews/<name>.json` store.** The spec describes persisting the
  last report to compare across runs. It is **informational only** — the merge
  decision needs "are there blocking findings at head", which every run answers
  by itself. Building it now adds file I/O, a staleness question, and a new
  failure mode for information the agent already has in context from the
  previous round. Add it when something concretely needs history.
- **GitLab.** `forge.provider` stays `z.literal('github')`.
- **Out-of-band notification.** Decision D3 in the spec.
- **Parallel provider execution.** Sequential until measured.
- **WorkProbe's `rloop.yaml`.** It keeps working under the alias. Moving it to
  `reviewers:` is its own PR in its own repo.
