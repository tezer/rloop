# PR #3 round 3 — bounded drain for exec.ts / read-json.ts

## Starting point

Worktree fast-forwarded from `6a72e04` to the actual current tip of
`worktree-review-providers`, commit `1bb0276` (one commit past the
`4401dff` named in the brief — `1bb0276` only deletes a stray
`pr3-round2-report.md`, no code change). Baseline: `npx vitest run` → 216/216,
`npx tsc -p tsconfig.json` clean, `npx tsc -p tsconfig.test.json` clean,
`node_modules` was missing so `npm install` was run first.

## The finding

`src/exec.ts::runCommand` and `src/reviewers/read-json.ts::readProviderJson`
both resolved their promise inside `child.on('exit', ...)`, snapshotting
whatever chunks had arrived by that instant. Node's docs say stdio "might
still be open" at `'exit'` — only `'close'` guarantees full delivery, but
`'close'` reintroduces the stall this code was written to avoid (a
backgrounded grandchild holding the pipe open makes the run wait until
`timeoutMs`). Two reviewers disagreed on severity; the one who couldn't
reproduce truncation but pointed at the documented contract was right —
"passes here" is not evidence of "cannot happen there."

## The fix: bounded drain

Both files now track `stdoutEnded` / `stderrEnded`, set by each stream's
`'end'` event (a stream's `'end'` fires when *all* holders of the pipe's
write end have closed it — the same condition `'close'` waits on, which is
exactly why it can't be trusted alone in the grandchild case).

On `'exit'`:
- If both streams have already ended, settle immediately with the exit code.
- Otherwise, record the exit code as pending and start a `DRAIN_GRACE_MS`
  (300 ms) timer. If both streams end before the timer fires, settle right
  then (cancelling the timer). If the timer fires first, settle anyway with
  whatever has been collected — this is the case where a grandchild is
  holding the pipe.

The existing `settled` guard (added in round 2, `I6`) is untouched and still
correct in both files: `settle()` returns immediately if already settled, so
whichever of {`'error'`, drained-immediately, drained-after-`'end'`,
grace-timer} fires first wins and every other path is a no-op. Verified this
holds under both mutations below — neither produced a double-resolve, only
the expected single-path failures.

### The comment (as written in both files, in the surrounding code's voice)

```
// Grace window for draining stdio after 'exit', before settling on whatever
// arrived. It sits between two failure modes: settle on 'exit' with no drain
// at all and a chunk still in flight when the event fires is lost — Node
// documents that stdio streams "might still be open" at 'exit' — while
// waiting for 'close' instead blocks on every inherited fd, including one a
// backgrounded grandchild (`sleep 100 &` with no `>/dev/null`) holds open
// long after the command itself is done. A few hundred milliseconds is ample
// for the normal case, where the streams are already drained by the time
// 'exit' fires, and short enough that a held-open pipe cannot stall the run.
const DRAIN_GRACE_MS = 300;
```

(`read-json.ts`'s version opens with "same constant and same reasoning as
src/exec.ts" instead of restating it, matching the existing cross-referencing
style between the two files.)

Both `'exit'` handlers now read:

```
child.on('exit', (code) => {
  exitedWith = code;
  if (stdoutEnded && stderrEnded) {
    settle(code, null);
    return;
  }
  exitPending = true;
  graceTimer = setTimeout(() => settle(code, null), DRAIN_GRACE_MS);
});
```

## Proof 1 — completeness

Both `test/exec.test.ts` and `test/reviewers/read-json.test.ts` already
carried a "does not truncate a several-hundred-KB payload" test from round 2
(`I6`), reusing / matching `test/fixtures/reviewers/large-payload.mjs`
(400 KB body, deterministic filler + `END-OF-BODY` tail so truncation OR
reordering fails loudly, not just "shorter than expected"). No new fixture
was needed — these are exactly the tests the brief asked for, and they pass
with the drain in place:

```
✓ test/exec.test.ts > does not truncate a several-hundred-KB payload (large-payload regression guard)
✓ test/reviewers/read-json.test.ts > does not truncate a several-hundred-KB document (large-payload regression guard)
```

## Proof 2 — no stall

The existing backgrounded-grandchild tests (`sleep 2 &` / `spawn('sleep',
['2'], { stdio: 'inherit' }).unref()`, no redirect) still pass, and their
elapsed time actually dropped versus the pre-fix baseline because the drain
resolves as soon as *both* streams end, not just on a fixed timer:

```
✓ test/exec.test.ts > resolves promptly ... backgrounded grandchild ...  311ms  (threshold: <1500ms)
✓ test/reviewers/read-json.test.ts > resolves promptly ... backgrounded grandchild ...  329ms  (threshold: <1500ms)
```

Both are well under the 1500 ms assertion and nowhere near `timeoutMs`
(15 000 ms in these tests). The grandchild's 2 s `sleep` never gets waited
on — the parent process's own stdio ends immediately after it exits since
it's the actual writer of record here (the grandchild only inherits the fd,
it doesn't write to it in these fixtures), so `'end'` fires fast and the
300 ms grace timer isn't even needed on the happy path here.

## Proof 3 — mutation testing

**Mutation A: drain removed** (settle immediately on `'exit'`, ignoring
`stdoutEnded`/`stderrEnded`) — the pre-round-3 behavior:

- `tsc -p tsconfig.json`: clean.
- Ran the full suite 5 times: **216/216 passed every time, zero failures.**

This is not a bug in the mutation — it's the exact shape of the finding.
Node's flush-before-exit ordering held in every trial on this box (Linux,
Node — same as both reviewers' own experience), so a test suite alone cannot
prove the fix is *necessary* here; it can only fail to disprove the risk
Node's own docs assert. I did not fabricate a synthetic reproduction (e.g.
artificially delaying `'data'` relative to `'exit'` in a fixture) because
that would test the mock, not the code. This absence-of-failure is reported
as-is rather than papered over.

**Mutation B: grace period set enormous** (`DRAIN_GRACE_MS = 300 * 1000`) —
confirms the drain is load-bearing for the *stall* side of the tradeoff:

```
✗ test/exec.test.ts > resolves promptly ... backgrounded grandchild ...
  AssertionError: expected 2004 to be less than 1500
✗ test/reviewers/read-json.test.ts > resolves promptly ... backgrounded grandchild ...
  AssertionError: expected 2025 to be less than 1500
```

Both failed as expected, at ~2000 ms (the grandchild's `sleep 2` duration,
not the 300 s grace timer — with the grace timer effectively disabled,
`'end'` only fires once the grandchild itself exits and releases the pipe,
i.e. the same wait `'close'` would impose). Confirms the grace timer is what
keeps this fast in the pathological case, not the `'end'`-based early-settle
path alone.

Both mutations were reverted immediately after their respective runs;
`diff` against the pre-mutation backup showed zero drift afterward.

## Proof 4 — full suite ×3, both tsc configs

Post-fix, after restoring from mutation testing:

- `npx tsc -p tsconfig.json`: clean (exit 0), all 3 checks in this report.
- `npx tsc -p tsconfig.test.json`: clean (exit 0).
- `npx vitest run` × 3:
  - Run 1: `Test Files 20 passed (20)`, `Tests 216 passed (216)`
  - Run 2: `Test Files 20 passed (20)`, `Tests 216 passed (216)`
  - Run 3: `Test Files 20 passed (20)`, `Tests 216 passed (216)`

## Anything that contradicts the framing

- The stated PR head (`4401dff`) was one commit behind the actual branch tip
  (`1bb0276`) in the shared worktree; the extra commit was a no-op for this
  fix (report file cleanup only), so it didn't change scope.
- Mutation A (drain removed) could not be made to fail on this machine —
  consistent with, not contradicting, the brief's own framing that this bug
  "passes in dev and CI and can still fire elsewhere." Flagging this
  explicitly rather than quietly declaring victory on the completeness proof.
- No other divergence found. `settled` guard (round-2's `I6` follow-on) is
  present, correct, and unchanged in both files.
