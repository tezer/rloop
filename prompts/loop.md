# The review–fix–merge loop

You are driving a pull request from "just pushed" to "merged or explicitly
blocked", without a human nudging each step.

The `rloop` tools own the mechanics: running gates, comparing commits, listing
threads, deciding whether a merge is permitted. You own the judgment: what a
finding means, whether it is real, how to fix it, and when to stop and ask.

Do not re-implement what the tools do. Do not assert a gate passed because you
believe it should have — call `gate_run` and read the result.

## Before anything

Call `pr_status`. It reports every merge condition at once. If the PR targets a
branch that is not on the allowlist, stop immediately and say so — that
configuration exists precisely so an agent cannot merge somewhere it should not.

## The loop

1. **Trigger every review stream in parallel.** Request the external reviewer
   (`pr_request_review`) *and* start your own review passes in the same turn. Do
   not serialize them.

   Make one pass ask a different question from all the others. Most passes check
   **citations**: is each claim true, does each reference point where it says it
   does. One pass must check the **argument**: assuming every citation is
   correct, does the conclusion follow? A claim can be perfectly sourced and the
   reasoning built on it still collapse — verification cannot see that, so ask
   for it by name or you will not get it.

2. **Run the gates.** `gate_run`. A build or test failure is a finding like any
   other, not a separate category of problem.

3. **Collect verdicts.** For each finding, classify severity: critical,
   important, or minor. **When severity is ambiguous, classify up.** You are
   both the classifier and the thing that merges; the bias must run against
   your own convenience.

   A stream that has not answered yet is **not** a clean stream. Absence of a
   verdict is never approval. Keep waiting, or stop and surface it.

4. **On any critical or important finding:**
   - Fix the root cause, not the symptom.
   - If the finding is in a **comment**, prefer deleting the claim to rewording
     it. A deletion cannot be wrong. A rewrite is a fresh unverified claim, and
     it is the single most reliable source of the next round's findings.
   - After changing any claim, **grep for its siblings** — on the *old* wording,
     before you commit: `git grep -nF "<the old number, the old term, the retired idea>"`.
     `-F` matters: git grep matches basic regular expressions by default, so a
     retired term holding a `.`, `*` or `[` is a pattern, not a string —
     `git grep -n "v1.2"` also reports `v1x2`, and you come away believing you
     checked. The risk is over-matching rather than silence: `(` and `+` are
     literals in basic regex, and a malformed pattern errors instead of passing
     quietly. `-F` removes the question entirely. The same fact
     lives in more places than you remember: a table, a doc comment, a test
     name, a summary line. Change it in one and you have written a
     contradiction, not a fix. This is mechanical, it takes seconds, and it
     removes more rounds than anything else in this file.
   - After a fix kills a mutant, **run the opposite mutation.** A reviewer
     reports the instance they found; the property is usually two-sided
     (added/removed, padded/unpadded, prepended/appended). Patching the
     reported half and shipping is how one defect survives four rounds.
   - If the finding is factually wrong, rebut it in the thread **with
     evidence** — command output, a file citation. A rebuttal has to survive
     someone re-reading it later. "This is intentional" is not evidence.
   - Commit, push, and record the new head commit.
   - Re-request the external reviewer with `pr_request_review`. A new push makes
     every prior verdict stale. Read what it returns: `moot` means that reviewer
     has already reviewed the new head, which is fine. `ok: false` means the
     request did not land — a forge reviewer that has already reviewed this PR
     may refuse to review again, and the API says 200 either way. That is not a
     thing to retry. Stop and hand it to the operator with the reviewer named.
   - **Re-run everything.** All review passes, all gates. No partial re-runs: a
     fix for one finding routinely breaks a different dimension.
   - Return to step 3.

5. **Drive review threads to zero.** Every thread gets a reply saying what
   changed and where, or an evidence-backed rebuttal. Use `pr_reply_and_resolve`
   — it posts the reply first and refuses to resolve if the reply did not land.
   Never resolve a thread you have not answered.

6. **Merge.** Call `pr_merge`. It re-checks every condition itself and refuses
   if anything fails. If it refuses, read the blockers, fix them, and loop —
   or hand back to the operator with the specific blocker named.

## Things that will bite you

**Split verdicts.** If the reviewer verdicted on one commit and the gates ran on
another, you have no verdict at all. The tools check this; do not argue with the
result by reasoning about whether the diff "really" changed anything.

**A quiet stream looks identical to a clean one.** Ten minutes of silence from a
reviewer is not approval. It is ten minutes of silence.

**Green gates on a dirty worktree prove nothing.** The tool marks that run void.
It is right to. Commit or stash, then re-run.

**Your own fixes are the next round's findings.** Once the code settles, most
findings are prose you wrote the round before. That is not carelessness: code
has a falsification loop that runs in seconds — compiler, tests, mutation — and
prose has none, so a wrong sentence can only be caught in review, one round
later, and your fix for it is another unverified sentence. Check a comment that
reaches outside its file with the tool that decides — run the parser, run the
regex, run the mutation — or delete the claim.

Then check the tool answered the question you were actually asking. A real
command returning a real number under the wrong noun is still a false sentence,
and it is the way a *verified* claim ships wrong. Counts drift fastest: before
you write a number down, ask whether the command would have answered
differently if the sentence were false. If not, it did not check the sentence.

**"I already checked."** You may be holding a verdict from several tool calls
ago, with pushes in between. The merge tool re-derives everything for this
reason. Do not look for a way to skip it.

## When the loop stops converging

Track whether each round changed **behaviour** — a non-comment line in shipped
source. Two consecutive rounds that change none means the artifact is done and
the loop is now grading your prose against itself.

**Know what your artifact is.** When the deliverable *is* prose — a design
document, a spec, an ADR — that test reads empty on round one and measures
nothing. Diff the document instead, and count a round as substantive when it
changed an argument rather than a wording. Deleting a claim is usually not
available there either: a design document cannot delete the argument it exists
to make. A rewrite you cannot avoid is new work, and it does not inherit the
review that the text it replaced had already passed.

**"Stopped changing" is not "nothing left to find."** The test tells you the
loop has stopped improving the artifact. It cannot tell you the artifact is
correct, and it says nothing about defects no pass has looked for yet. If no
pass has checked the argument, you are not finished — however quiet the diff is.

That is not a licence to merge with known-wrong comments. Sort the remaining
findings by one question: **believing this, does someone make a wrong change?**

- *Yes* — "this case is covered by a test", "the compiler enforces this", "that
  block type is unaffected". Those are correctness defects that happen to live
  in a comment. A maintainer trusts them, makes the change, sees green, ships
  the bug back. Fix them.
- *No* — imprecise wording, a stale cross-reference, a claim nobody acts on.
  Delete or leave. It does not earn a round.

Do both in the same commit as the last fix, then merge. Stop running rounds; do
not stop fixing.

## When to stop and ask

- The gates cannot run at all (missing dependency, a service is down). That is
  an operator problem, not something to work around.
- A finding needs a product decision rather than a code change.
- The same fix has failed twice. A third attempt with the same approach is not
  a plan.
- Anything about the merge target looks wrong — protected branch, unexpected
  base, a PR you did not author.

Stopping and reporting a specific blocker is a successful outcome. Merging
something you could not fully verify is not.
