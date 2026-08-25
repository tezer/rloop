# PR #3 round-2 fixes

Base commit: `3488f76d44f6676c29a94b24d31bf79cebb4d86c` (round-1 head).

## Setup note

This worktree's branch (`worktree-agent-af5ccccded8aa124f`) was checked out
28 commits behind the stated head — at `6a72e04`, an ancestor of `3488f76`
missing the entire `src/reviewers/*` feature the six review streams reported
on. Confirmed `6a72e04` is an ancestor of `3488f76` and the branch had no
divergent commits, so fast-forwarded (`git merge --ff-only 3488f76`) rather
than reworking a stale tree. All work below is on top of the correct head.

## C1 — docstring/README/code contradiction in `src/reviewers/command.ts`

**Finding was correct.** The `Classification order matters` table carried a
standalone row `parsed but fails the schema -> malformed`, which is false:
`parseProviderDocument` returns the same `{ok:false}` shape for invalid JSON
and schema failure, and both fall into the `!parsed.ok` branch gated on exit
code — a schema-invalid document with a non-zero exit yields `unavailable`.

Fix: merged the schema-failure case into the two existing "output unusable"
rows, matching the README's already-correct wording exactly:

```
output unusable (unparseable OR fails the document schema) AND exit != 0 -> unavailable
output unusable (unparseable OR fails the document schema) AND exit == 0 -> malformed
```

Re-read the full docstring afterward — no neighbouring sentence still implied
schema failure gets its own branch.

**Also found and fixed the same defect's sixth occurrence**, per the
instruction to check `document.ts` while there: its comment on
`parseProviderDocument` said "the caller turns a failure into a `malformed`
report" — unconditionally, which is exactly as wrong as the command.ts row
for the same reason. Reworded to state the verdict depends on the exit code
(`malformed` on zero, `unavailable` on non-zero), pointing at command.ts's
table as the source of truth instead of duplicating it a third place.

`README.md` was already correct (verified by reading the surrounding
Classification section in full) — no changes needed there.

## I1 — "could not run" asserted for a reviewer that did run

**Finding was correct.** `merge-gate.ts` rendered every `unavailable` status
identically as `Reviewer "X" could not run: ${detail}`, which is
self-contradictory for the "contradicted signals" cause (exit non-zero,
document clean) — the detail explicitly describes a document that was
produced.

**Approach chosen: a `reason` field on the report** (`UnavailableReason` —
`'never_ran' | 'crashed' | 'contradicted'`), not wording `detail` for
merge-gate.ts to pass through. Rationale:

- `command.ts` is the only place that actually knows which of the three
  code paths produced `unavailable`; asking `merge-gate.ts` to recover that
  distinction by pattern-matching `detail` text (as the instructions
  explicitly warned against) would make the two files silently coupled on
  wording — exactly the kind of stranded-fix defect C1 and its history are
  about.
- A typed field is checked by the compiler at every construction site
  (`command.ts`, `collect.ts`), the same reasoning `FindingsReason` already
  uses one field over for a structurally identical problem (`status` alone
  can't carry the distinction; both are "one status, several reasons why").
- Explicitly did **not** add a seventh `ReviewerStatus` — merge-blocking
  behaviour is identical across all three causes, only the message differs,
  and the instructions called out the status axis as deliberately small.

Implementation:
- `src/reviewers/types.ts`: new `UnavailableReason` type and
  `unavailableReason: UnavailableReason | null` field on `ReviewerReport`
  (set exactly when `status === 'unavailable'`, mirroring how
  `findingsReason` is coupled to `status === 'findings'`).
- `src/reviewers/command.ts`: each of the three `unavailable`-producing
  branches (spawn error, timeout, unparseable+non-zero-exit,
  contradicted-signals) now sets the matching reason (`never_ran` for the
  first two, `crashed`, `contradicted`).
- `src/reviewers/collect.ts`: `forgeReport`'s `base` sets
  `unavailableReason: null` — a forge report never reaches `unavailable`.
- `src/merge-gate.ts`: the `case 'unavailable'` branch now picks a lead-in
  phrase from `r.unavailableReason` — `"could not run"` only for
  `never_ran`; `"ran but crashed before producing a usable review"` for
  `crashed`; `"ran and produced a document, but its own signals contradict
  each other"` for `contradicted`. None of the latter two assert "could not
  run".

Tests added:
- `test/reviewers/command.test.ts`: `unavailableReason` assertions on all
  five `unavailable`-producing scenarios (spawn-unspawnable, ENOENT/exit
  127, crash without a document, bad-schema+exit-1, clean-doc+exit-1,
  timeout) — pins that the real production code sets the right reason, not
  just that a hand-built report renders correctly.
- `test/merge-gate.test.ts`: new `describe('unavailable wording, per
  cause (I1)')` with one test per cause, asserting the exact wording
  contract (`never_ran` contains "could not run"; `crashed` and
  `contradicted` do not, and each names its own situation).

## I2 — `assertFindingsReasonCoupling` weakly wired

**Finding was correct**, confirmed independently: `test/merge-gate.test.ts`'s
`report()` helper set `findingsReason: null` unconditionally and never called
the assertion, so `report({ status: 'findings' })` (used by the "blocks open
findings" test) built an inconsistent `ReviewerReport` and fed it straight to
`evaluateMergeGate`, bypassing the exact invariant the assertion protects —
and this was the only place doing so outside the two dedicated unit tests in
`test/reviewers/types.test.ts`.

Fix, both parts:
1. `report()` now derives a sensible `findingsReason` default from `status`
   (`'provider_findings'` when `status === 'findings'`, else `null`) before
   applying overrides — a test that only cares about a different axis no
   longer has to also remember this coupling.
2. `report()` now runs its result through `assertFindingsReasonCoupling`
   before returning it — the same call every production factory
   (`command.ts`, `collect.ts`) makes. This routes essentially every test in
   `merge-gate.test.ts` (all ~30 that use `report()`) through the assertion,
   not just the two isolated unit tests. Added one explicit test —
   `'the report() helper itself enforces the findingsReason/status coupling
   (I2)'` — that deliberately overrides `findingsReason: null` on a
   `status: 'findings'` report and asserts `report()` throws, proving the
   wiring actually fires rather than being dead code in the helper too.

No other test in the file needed a status/findingsReason override that would
now conflict with the new default; the full suite was the check for that.

## MINOR items

- **Large-payload regression guard.** Added
  `test/fixtures/reviewers/large-payload.mjs` — a 400KB `body` field ending
  in a distinctive `END-OF-BODY` tail (so truncation OR reordering fails
  loudly, not just "shorter than expected"). Added round-trip tests at two
  layers: `test/reviewers/read-json.test.ts` (raw stream capture) and
  `test/reviewers/command.test.ts` (through schema parsing). Also added the
  same guard for `exec.ts` in `test/exec.test.ts`, since gate output goes
  through the same 'exit'-based resolution — cheap (`node -e` inline, no new
  fixture needed).
- **`exec.ts`'s `settle()` missing the `settled` guard.** Added, matching
  `read-json.ts` exactly (comment included) — a no-op guard against a
  hypothetical double-resolve if Node's 'error'-before-'exit' ordering ever
  isn't honored.

## Files touched

- `src/reviewers/command.ts` — C1 docstring fix, I1 `unavailableReason` at
  each `unavailable` branch.
- `src/reviewers/document.ts` — C1 stranded-claim fix.
- `src/reviewers/types.ts` — I1 `UnavailableReason` type and field.
- `src/reviewers/collect.ts` — I1 `unavailableReason: null` in `forgeReport`.
- `src/merge-gate.ts` — I1 cause-specific wording.
- `src/exec.ts` — MINOR `settled` guard, large-payload test only in test file.
- `test/reviewers/command.test.ts`, `test/reviewers/read-json.test.ts`,
  `test/reviewers/collect.test.ts`, `test/reviewers/report.test.ts`,
  `test/reviewers/types.test.ts`, `test/merge-gate.test.ts`,
  `test/exec.test.ts` — required-field updates (`unavailableReason`) plus
  new tests for I1, I2, and the large-payload guard.
- `test/fixtures/reviewers/large-payload.mjs` — new fixture.

## Verification

- `npx tsc -p tsconfig.json` — clean.
- `npx tsc -p tsconfig.test.json` — clean.
- `npm run build` — clean, `dist/cli.js` produced.
- `node dist/cli.js check -c examples/next-vitest.yaml` — exit 0:
  ```
  config OK: .../examples/next-vitest.yaml
  gates: build, test, authoring
  merge: disabled (dry run)
  ```
- Full suite, run 1: **20 files, 216 tests passed** (209 baseline + 7 new:
  3 I1 wording tests + 1 I2 drift test in merge-gate.test.ts, 1 large-payload
  test each in command.test.ts / read-json.test.ts / exec.test.ts).
- Full suite, run 2: **20 files, 216 tests passed.**
- Full suite, run 3: **20 files, 216 tests passed.**

## Concerns / things not done

- No new invariant-assertion was added for `unavailableReason` analogous to
  `assertFindingsReasonCoupling` for `findingsReason` — the task scoped I2
  to the existing assertion, and adding a second one wasn't asked for. If a
  future round wants the same drift protection for `unavailableReason`, that
  would be the natural next step, following the same pattern.
- `degradationOf` in `collect.ts` (message: `Reviewer "X" is unavailable:
  ...`) was left untouched — it already avoids "could not run" and wasn't
  named in I1.
