# Pluggable review providers, and honest degradation

**Status:** design, approved 2026-08-25. Not implemented.

## The problem

rloop's external review stream is one shape: a login on a GitHub pull request.
`merge.required_reviewers` holds logins, verdicts arrive from `listReviews`,
and findings arrive as review threads. Every mechanism assumes a forge.

Two consequences:

1. **A local reviewer cannot participate.** A Codex running on the developer's
   machine has no login, submits no review, and opens no threads. rloop's
   original premise — a PR reviewed by two different models — is unreachable
   with the current shape unless both models happen to be forge bots.

2. **A missing reviewer is indistinguishable from a misconfigured one.** The
   merge gate blocks on `reviewer_no_verdict` either way, and nothing tells the
   operator which happened.

## Decisions

Three questions were settled before design. Each is recorded with the reasoning,
because each could reasonably have gone the other way.

### D1 — Degraded mode never auto-merges

When no provider is configured or available, rloop runs everything else — gates,
the agent's own review passes, fixes, threads — and then **stops at the merge
step** and hands the decision to the operator.

The alternative was letting gates and threads stand in for the missing stream
and merging anyway. Rejected because a provider that is merely *down* is
indistinguishable at runtime from one deliberately absent, and that path
silently weakens the gate on exactly the day it is most needed.

This preserves the rule already written into `evaluateMergeGate`: *"a MISSING
signal is a blocker, never a pass."*

### D2 — rloop runs local providers itself and parses their output

A `kind: command` reviewer is spawned by rloop, like a gate, and must print a
JSON document rloop parses.

The alternative was an MCP tool the agent calls to submit findings it gathered
however it liked. Rejected on the same grounds `config.ts` already records
about thread resolution: it *"delegates the real check to a party with an
interest in the answer."* The agent being gated should not also be the source
of the verdict gating it.

Cost, stated plainly: every local tool needs a wrapper emitting rloop's shape.

### D3 — Notification is in-band

A banner in CLI output, a `degraded: { reason, provider }` field in the
JSON/MCP verdict, and a named blocker at the merge step.

No out-of-band notifier (`notify-send`, webhook). Rejected as a new config
surface whose own failure mode — a notifier that dies while reporting a
degradation — needs defined behaviour before it is worth having. Revisit if
in-band proves insufficient in practice.

## Config

```yaml
reviewers:
  - name: copilot
    kind: forge
    login: copilot-pull-request-reviewer
    required_state: any_verdict          # forge-only
  - name: codex
    kind: command
    run: codex review --base origin/staging --json
    timeout_seconds: 600
```

`required_state` moves from `merge:` to the individual reviewer. It was always a
per-reviewer property: a comment-only bot needs `any_verdict`, a human needs
`approved`, and one global setting cannot express both. It has no meaning for
`kind: command`, where the verdict derives from findings, and is rejected there.

### Migration — the part that nearly shipped broken

The first draft of this design said the old keys "are replaced". That is a
breaking change, and the schema makes it a hard one. Demonstrated, not assumed:

```
$ rloop check      # config using the proposed `reviewers:` key
invalid config
  - (root): Unrecognized key(s) in object: 'reviewers'
```

All six object schemas in `config.ts` carry `.strict()`, so an unrecognised key
is a refusal, not a warning — and the same rule that rejects a new key today
would reject a retired key tomorrow. The transcript above is the root object
refusing; the other five were counted, not exercised. rloop 0.2.1 is published, and WorkProbe's `rloop.yaml` —
merged to `staging` on 2026-08-24 — uses both retired keys and pins
`@tezer/rloop@0.2.1` in its header.

So:

- `merge.required_reviewers` and `merge.required_reviewer_state` **keep
  working**, desugaring into one `kind: forge` entry.
- `rloop check` warns that they are deprecated.
- **Both forms present is a config error.** Never a silent merge of the two —
  a config with two sources of truth for who must review is a config whose
  author does not know what will happen.
- Ships as **0.3.0**: additive, not a breaking major.

## The command contract

One JSON document on stdout:

```json
{
  "sha": "abc123...",
  "findings": [
    {
      "id": "codex-7",
      "severity": "critical",
      "path": "src/x.ts",
      "line": 42,
      "title": "…",
      "body": "…"
    }
  ]
}
```

`severity` is `critical | important | minor`, matching the classification the
loop prompt already uses. `id`, `path` and `line` are optional; `severity` and
`title` are not.

**Which severities block: `critical` and `important`. `minor` does not.** This
matches the loop prompt, whose step 4 acts "on any critical or important
finding" and leaves minor ones to the convergence rules. A `minor`-only report
is `status: 'clean'`, and its findings still appear in the report so the agent
can choose to fix them.

An unrecognised severity string is `malformed`, not a silently-ignored finding.

**What the `sha` field is worth.** rloop passes the head SHA in
`RLOOP_HEAD_SHA` and requires the document to echo it. This proves the process
ran in this invocation — it does **not** prove the provider read that tree, and
nothing in a subprocess contract can. The real binding comes from elsewhere:
rloop already refuses to run against a dirty worktree, so on a clean tree "the
working tree" and "that commit" are the same bytes. The echo catches a cached or
stale document; the worktree check is what makes the SHA meaningful. Do not
document the echo as more than it is.

## Normalized report

Both kinds produce one type, and `evaluateMergeGate` sees only this:

```ts
type ReviewerStatus =
  | 'clean'          // reported, nothing blocking
  | 'findings'       // reported, blocking findings open
  | 'stale'          // reported against a different SHA
  | 'absent'         // forge: no review submitted yet
  | 'unavailable'    // command: could not run
  | 'malformed';     // command: ran, output unusable

interface ReviewerReport {
  name: string;
  kind: 'forge' | 'command';
  status: ReviewerStatus;
  sha: string | null;
  findings: Finding[];   // always empty for kind: forge — see below
}
```

`findings` stays empty for forge reviewers because their findings are review
threads, which the merge gate already handles through
`require_threads_resolved`. Routing threads into `findings` as well would give
two mechanisms for one fact. This is an asymmetry in the type, and it is
deliberate; it is called out here so a future reader does not "fix" it.

## Findings reach zero by disappearing

A local finding has no thread to resolve. It clears when a re-run of the same
provider, at the new head, no longer reports it.

rloop stores the last report at `.rloop/reviews/<name>.json`. After a fix and a
new commit, it re-runs and compares.

This is deliberately stronger than thread resolution, which is performed by the
agent being gated. Disappearance is checked by re-running the reviewer; nobody
marks their own homework.

**Fingerprints** use the provider's `id` when present, else a hash of
`path + title`. **Never the line number** — an edit above a finding moves it,
and a fingerprint that changes on every unrelated edit reports every finding as
new and every fixed one as gone.

**Dismissal**, for a finding that is simply wrong:

```yaml
reviewers:
  - name: codex
    dismiss:
      - fingerprint: "a1b2c3d4"
        reason: "False positive: the guard is in the caller, src/gate.ts:88."
```

`reason` is required. A dismissal lives in the config, so it appears in the
diff and survives review — unlike a runtime assertion that a finding was
handled, which is exactly the self-grading this design avoids elsewhere.

Two details a first implementation will otherwise get wrong:

- **rloop prints each finding's fingerprint** in the CLI report and includes it
  in the JSON. A dismissal keyed on a value the operator cannot see is a
  feature nobody can use.
- **A dismissal matching nothing at head is a warning, not an error.** It
  usually means the finding was genuinely fixed and the entry is now dead
  weight; saying so lets it be deleted. Erroring would punish the good outcome.
  It is never silent: a dismissal file that accumulates unmatched entries is
  how a real finding gets pre-suppressed by accident.

## Merge gate

New blocker codes, joining the existing set:

| Code | Fires when |
|---|---|
| `reviewer_degraded` | No provider configured, or none available. Always blocks (D1). |
| `reviewer_unavailable` | A configured `kind: command` provider could not run. |
| `reviewer_malformed` | It ran; its output failed the schema. Fails closed. |
| `reviewer_findings_open` | Blocking findings still reported at head. |

`reviewer_no_verdict`, `reviewer_stale`, `reviewer_changes_requested` and
`reviewer_not_approved` keep their current meaning for forge reviewers.

`unavailable` and `malformed` stay distinct even though both block: a reviewer
you broke is a different problem from one you never had, and collapsing them
would hide a broken wrapper behind a message that reads like a missing one.

## Degradation

| Situation | Status | Reason string |
|---|---|---|
| No `reviewers:` and no deprecated keys | degraded | `not_configured` |
| Spawn fails (ENOENT), non-zero exit with no parseable document, or timeout | degraded | `unavailable` |
| Document parses as JSON but fails the schema | degraded | `malformed` |

All three produce the banner, the `degraded` field, and `reviewer_degraded` at
the merge step. **Gates still run** — a missing reviewer does not stop rloop
telling the operator whether the build is green.

## Testing

`evaluateMergeGate` is pure — no I/O, no clock, no network — so every blocker
above is a unit test over a literal input, matching the existing suite.

The command provider needs fixture executables: clean, findings-at-each-severity,
malformed JSON, valid JSON failing the schema, ENOENT, non-zero exit, and a
hang for the timeout path.

Fingerprint tests must include the case the rule exists for: the same finding
after an unrelated edit shifts its line number, and must be recognised as the
same finding.

Every guard gets mutation-checked — delete it, confirm a test fails. A guard
whose deletion leaves the suite green is decoration, and this repo has shipped
that mistake before.

## Non-goals

- **GitLab support.** `forge.provider` remains `z.literal('github')`. A
  `kind: command` reviewer runs anywhere, but reviewers are part of the merge
  gate and the merge gate needs a pull request from a forge. This design does
  nothing for AutoMatrix, which is on self-hosted GitLab and uses gates only.
- **Out-of-band notification** (D3).
- **Running providers in parallel.** Sequential first. Parallelism is an
  optimisation, and no measurement yet says it is needed.

## Update checklist

From `git grep` on the retired terms, per file:

| File | `required_reviewers` | `required_reviewer_state` | `reviewer_timeout_seconds` |
|---|---|---|---|
| `README.md` | 6 | 2 | 1 |
| `examples/next-vitest.yaml` | 1 | 1 | 1 |
| `examples/python-pytest.yaml` | 1 | 1 | 1 |
| `examples/rust-cargo.yaml` | 1 | 1 | 1 |
| `src/config.ts` | 5 | 3 | 1 |
| `src/merge-gate.ts` | 1 | 2 | — |
| `test/merge-gate.test.ts` | 3 | 4 | — |

Counted 2026-08-25; re-run the grep rather than trusting this table.

Outside the repo: WorkProbe's `rloop.yaml` uses both retired keys. It keeps
working under the alias, and should move to `reviewers:` in its own PR.
AutoMatrix's `rloop.yaml` has no `merge:` block and is unaffected.
