# rloop

**A merge decision you can ask, instead of one you discover by being refused.**

```console
$ rloop pr status 812
PR #812 Add a retry budget to the job runner
  OPEN · → staging · head 9dbe1e8

  ~ copilot-pull-request-reviewer[bot] APPROVED (stale: a5aab06)
  ✗ threads: 3/4 resolved

BLOCKED — 3 condition(s) not met:
  ✗ [gates_not_green]     Local gates are not green: test failed.
  ✗ [reviewer_stale]      Latest review from "copilot-pull-request-reviewer" is
                          against a5aab06, but PR head is 9dbe1e8. Stale —
                          re-request review on the current commit.
  ✗ [threads_unresolved]  1 unresolved review thread(s): #2109482
```

Branch protection knows all three of those things. It will tell you the same
way every time: by refusing the merge, one round trip at a time, and only once
you have already tried. That is fine for a human — you read the message, you go
look. It is the wrong shape for an **agent**, which has to decide what to fix
*before* it decides what to do next, and which cannot see a rule it never
tripped.

`rloop` turns the merge decision into a question you can ask. Every condition is
evaluated on every call and **all** failures are reported at once, so three
blockers cost one pass instead of three force-pushes.

## It does not trust the thing calling it

`rloop pr merge` accepts no "already verified" flag. There is no way to tell it
you checked. It re-derives the entire decision itself — re-reads the PR state,
re-checks the reviewer verdict against the *current* head, re-lists the threads,
re-confirms the gate run was bound to this exact commit — because the agent
holding the tool may be acting on a verdict from three tool calls and one force
push ago.

The rule underneath every check: **a missing signal is a blocker, never a
pass.** No review yet is not approval. Gates you skipped are not gates that
passed. Ten minutes of silence from a reviewer is ten minutes of silence.

## The reviewer is not the author

The model that wrote the PR must not be the only one saying it is fine. So a
merge also requires a **verdict from a reviewer rloop does not control** —
another model (Copilot, or any review bot) or a human:

```yaml
reviewers:
  - name: copilot
    kind: forge
    login: copilot-pull-request-reviewer
    required_state: any_verdict
```

That verdict is bound to the commit it was given on. Approve `a5aab06`, push
again, and it is `reviewer_stale` — two reviewers agreeing about different
versions of the code is not agreement. Enabling `merge.enabled` with an empty
`reviewers:` is not a schema error — `rloop check` only warns — but it can
never merge: rloop treats "no external review stream configured" as
degradation, which blocks unconditionally. Details in
[The merge gate](#the-merge-gate) and
[Command reviewers](#command-reviewers).

## Where the models are configured: not here

rloop never calls an LLM. There is no model setting, no API key, and no
provider — the entire config is `version`, `forge`, `committer`, `preflight`,
`gates`, `merge`, `parallel_gates`, `log_dir`. It holds no credentials of any
kind, GitHub included: every forge call shells out to `gh`.

Two models are usually involved. Neither is chosen here.

**The one driving the loop** is your MCP host — Claude Code, Cursor, whatever
you launched the server from. Its config names the *server*:

```json
{ "mcpServers": { "rloop": {
  "command": "npx", "args": ["-y", "--package=@tezer/rloop", "rloop-mcp"]
} } }
```

Which model sits behind that host is the host's own setting. rloop is a tool it
calls and cannot see what is calling it.

**The one reviewing** is a `reviewers:` entry of `kind: forge`, and its
`login` is a **forge login, not a model**:

```yaml
reviewers:
  - name: copilot
    kind: forge
    login: copilot-pull-request-reviewer
    required_state: any_verdict
```

You enable that reviewer on GitHub; rloop only checks whether the login left a
verdict on the current head. Put a human's username there and the same rules
apply — stale verdicts still block, silence still blocks. rloop has no opinion
about what kind of thing reviews the code, only that it is not the thing that
wrote it.

**What the driving agent should do** is the `loop` prompt, served over MCP from
[`prompts/loop.md`](prompts/loop.md) — the review streams, the fix loop, the
thread discipline. It names no model either, which is what makes it portable
across hosts. The [Claude Code skill](skills/r-loop/SKILL.md) is a thin wrapper
over it.

rloop is the referee. You bring the players.

## And it does not believe exit codes

`gates_not_green` is the condition rloop is strictest about, because the signal
underneath it is the least trustworthy one in the stack:

```console
$ npm run build && echo GREEN
GREEN
$ echo $?
0
```

That build failed. npm 9 masks a failing child script's exit code for **any
package that is a workspace member** — it prints `npm ERR!` and returns `0`.
Not just `--workspace=<w>`: a root script wrapping one masks too, and so does
`cd packages/thing && npm run build`. You cannot `cd` your way out of it.

So green is proven by **output**: positive end-of-run markers that only print on
real success, plus negative guards for failure strings that appear even when the
exit code lies.

> **If your test runner emits JUnit XML, TAP or SARIF, prefer that** — a
> structured result file beats a regex over a log, and you should reach for it
> first. rloop exists for the rest: builds, type-checks, container preflights,
> lint passes and custom scripts, which mostly emit prose and an exit code you
> have just seen lie.

## Not a JavaScript tool

A gate is **a shell command plus regexes over its output**, so `cargo test`,
`pytest`, `go build`, `mvn` and `make` all work identically — see
[`examples/`](examples/) for copyable starting points. npm is not special to
rloop; it is just the ecosystem whose exit-code bug made the tool necessary,
and the reason the design assumes *every* runner may be lying.

One config can mix them. Nothing groups gates by language, so a repo with a
Rust service and a Python worker lists both in the same `gates:` block and gets
one verdict over the lot.

## If you already have CI and a merge queue

Then most of the *policy* is solved for you, and you should not replace it.
Required status checks, "dismiss stale approvals on push" and "require
conversation resolution" cover the merge conditions natively; Mergify, Aviator,
Trunk or GitHub's own merge queue cover the automation. rloop is not competing
with those and is not a policy engine for your org.

Two things it still does that they do not:

**Your CI inherits the false green.** A workflow step that runs
`npm run build --workspace=web` gets the same masked `0` your terminal does, and
GitHub renders it as a green check. CI moved *where* the command runs; it did
not make the exit code honest. `rloop gate` is useful as the step your workflow
actually runs:

```yaml
- run: npx @tezer/rloop gate --json   # exit 1 = broken, exit 2 = no verdict
```

**Merge queues answer by refusing.** The loop is: push, wait for CI, read the
rejection, fix, push again. That is a reasonable cost per human iteration and a
bad one per *agent* iteration. The same `rloop gate` config runs locally before
the push and answers in seconds, so a failing type-check costs one command
instead of one round trip through a runner and a reviewer.

The case rloop was actually built for is narrower than either: **no CI, no
branch protection, and an agent authoring the PR**, where the gate runs on the
same machine as the work and is the only thing between generated code and the
base branch. Running on that machine is also its main weakness — see
[What it cannot do](#what-it-cannot-do).

## Status

Early, but complete through the MCP layer: config schema, gate engine,
preflight, CLI, GitHub forge layer and MCP server are all implemented and
tested.

All paths, including the writes (`pr reply`, `pr merge`), have been exercised
end to end against a live GitHub repository — a real review thread replied to
and resolved, a real PR merged, and both refusal paths (unresolved thread,
non-allowlisted base branch) confirmed to block an actual merge attempt.

## Install

```bash
npm install -g @tezer/rloop
rloop check
```

Or without installing:

```bash
npx @tezer/rloop check
```

The package is scoped because npm's typosquatting filter rejects the bare name
`rloop` as too close to `rlp` and `plop`. The **command is still `rloop`** — a
`bin` name is independent of the package it ships in.

From a clone:

```bash
npm install && npm run build
node dist/cli.js check
```

## Writing your config

Put `rloop.yaml` in your repo root. rloop searches upward for `rloop.yaml`,
`rloop.yml`, `.rloop.yaml` or `.rloop.yml`, so a subdirectory works too. Start
by copying the nearest file from [`examples/`](examples/).

Only two blocks need information you have to go and look up. Both are one
command.

**`forge.slug`** — your repo as `owner/name`:

```bash
gh repo view --json nameWithOwner -q .nameWithOwner
```

**`committer`** — your git identity, which rloop compares against the live
`git config` before every run and refuses to proceed if they differ (an
unattended loop must not author under someone else's name):

```bash
git config user.name && git config user.email
```

If `user.email` is unset, or you want GitHub's privacy address rather than your
real one, build it from your account — the shape is always
`<id>+<login>@users.noreply.github.com`:

```bash
gh api user -q '"\(.id)+\(.login)@users.noreply.github.com"'
```

Then set it: `git config user.email "<that address>"`. The whole `committer`
block is optional — delete it and the check is skipped.

**A `reviewers:` forge entry's `login`** is a login, not a display name — and
not a model either, see
[Where the models are configured](#where-the-models-are-configured-not-here).
Bots are where this bites. GitHub Copilot answers to three different spellings across
three API surfaces; use `copilot-pull-request-reviewer` and let rloop normalize
(see [Reviewer logins are not one string](#reviewer-logins-are-not-one-string)).
For a human, `gh api users/<login> -q .login` confirms the exact casing.

**`merge.allowed_base_branches`** is an allowlist. List only the branches an
agent may merge into, and leave your release branch out — a branch you never
thought about stays protected by default rather than by memory.

### The gates are the part that takes real work

Everything above is bookkeeping. A gate needs a `run` command and markers that
prove it worked, and **you cannot write those from documentation** — tool output
changes between versions. Get them from your own logs:

```bash
# 1. Write the gate with only the `run:` line and a placeholder marker.
# 2. Run just that gate. It will fail; that is fine, you want its log.
rloop gate --only build

# 3. Read what the command ACTUALLY printed.
less .rloop/logs/build.log
```

Now pick markers out of that file, using the three rules in
[Picking markers that actually hold](#picking-markers-that-actually-hold):
take `require` from the **end** of a successful run, make it prove work happened
(a non-zero count, not merely the absence of complaints), and anchor `forbid` so
it cannot match ordinary text inside passing output.

Re-run `rloop gate --only <name>` until it passes on a good commit. Then break
something on purpose — comment out a line, fail an assertion — and confirm it
goes red. A marker you have only ever seen pass is a marker you have not tested.

## Use

```bash
rloop check                      # validate config, print warnings, run nothing
rloop preflight                  # environment checks only
rloop gate                       # preflight, then the gates, then a verdict
rloop gate --base origin/staging # resolve when_paths against the PR diff
rloop gate --only build          # one gate; never yields a merge verdict
rloop gate --json                # machine output
```

```bash
rloop pr status 812              # evaluate every merge condition, read-only
rloop pr threads 812             # list review threads and resolved state
rloop pr reply 812 --thread <id> --body "Fixed in abc123: ..."
rloop pr merge 812               # re-check everything, merge only if all holds
```

Exit codes are the contract:

| Code | Meaning |
|---|---|
| `0` | every gate that ran passed |
| `1` | a gate failed — the code under test is broken |
| `2` | no verdict: bad config, preflight blocker, timeout, or a void run |

`1` and `2` are separate on purpose. Both block a merge, but a human fixes very
different things.

```console
$ rloop gate
  ✗ build          0.4s
      build: forbidden pattern "Failed to compile" matched at line 7 (+5 more)
          7 │ > echo 'Compiled successfully' && echo 'Failed to compile'
         10 │ Failed to compile
         11 │ npm ERR! Lifecycle script `build` failed with error:
      note: this command exited 0. The exit code was wrong; the output was not.
      log: .rloop/logs/build.log

RED — 1 of 1 gate(s) failed. Do not merge.
```

## The gate

```yaml
version: 1
gates:
  - name: build
    run: npm run build
    require:
      - "Compiled successfully"
      - "^Route \\("      # the closing route table — see below
    forbid:
      - "Error occurred prerendering"
      - "npm ERR!"

  - name: test
    run: npm test
    require:
      - "^\\s*Tests\\s+[1-9][0-9]* passed"
    forbid:
      - "^\\s*FAIL "
```

`require`: every pattern must match at least one line.
`forbid`: no pattern may match any line.
Patterns are matched **per line**, so `^` and `$` mean what they do in `grep -E`.

## Picking markers that actually hold

Three traps, all of them real:

**Pick a marker from the END of the run.** `next build` prints
`Compiled successfully` after webpack, then runs type-check, page-data
collection and static generation. Their failures print *after* that line. The
honest marker is the closing route table, `^Route \(`, which only appears when
the whole build succeeded.

**Prove the work happened, not just that nothing complained.**
`vitest run --passWithNoTests` exits 0 having discovered zero tests. A broken
glob greens silently. `^\s*Tests\s+[1-9][0-9]* passed` asserts tests ran.

**Anchor your failure guards.** A bare `failed` matches assertion text inside
legitimately passing error-path tests. `^\s*FAIL ` does not.

Every one of these is a regression test in `test/evidence.test.ts`, driven by
committed golden logs. If you are going to let a tool merge your code, the
tool's own failure detection should be tested.

## Safety posture

- **Dry run by default.** `merge.enabled` is `false` until you set it.
- **Base branches are an allowlist**, never a denylist. A branch nobody
  remembered to list stays protected.
- **Gates run sequentially** unless you opt in. Concurrent runs sharing a
  container runtime, port, or test database green each other.
- **A verdict is bound to one commit.** Dirty worktree or HEAD moving mid-run
  voids the result — the gates verified something other than what would merge.
- **Timeout is `error`, never `skipped`.** An unrunnable gate gets surfaced.
- **A gate with no patterns is rejected**, because it would pass on exit code
  alone. A gate with only `forbid` patterns is allowed (`tsc -b` prints nothing
  on success) but warns — it can only catch failure modes you already know.
- **`GIT_DIR` and friends are stripped** from rloop's own git calls *and* from
  every gate subprocess. `GIT_DIR` outranks `cwd`, so without this a leaked
  value redirects HEAD, `status` and any git the gates themselves run — all to
  the same wrong repository, all agreeing. See
  [what it cannot do](#what-it-cannot-do) for the part scrubbing does not fix.
- **A forge reviewer's `required_state` has no default.** "A review exists"
  and "the reviewer approved" are different facts; see below.
- **Review degradation always blocks the merge.** No reviewers configured, a
  `kind: command` reviewer that crashed, or one whose output could not be
  used — each blocks `pr merge` unconditionally, even with every gate green.
  See [Command reviewers](#command-reviewers).

### A review is not an approval

GitHub review states are `APPROVED`, `CHANGES_REQUESTED` and `COMMENTED`. A bot
that files findings as inline comments submits `COMMENTED` whether it found
nothing or found ten things — and **Copilot never submits `APPROVED` at all**.
So a gate blocking only on `CHANGES_REQUESTED` is checking "did the reviewer
turn up", which reads like a stronger claim than it is.

```yaml
reviewers:
  - name: copilot
    kind: forge
    login: copilot-pull-request-reviewer
    required_state: any_verdict   # or: approved
```

- `approved` — only `APPROVED` clears the gate. Right for humans. Makes a
  comment-only bot block forever, which is why it cannot be the default.
- `any_verdict` — `APPROVED` or `COMMENTED` clears it; `CHANGES_REQUESTED`
  still blocks. Right when the reviewer's findings arrive as review threads and
  `require_threads_resolved` is the real gate. **Know what that leans on:**
  threads are usually resolved by the same agent being gated, so this delegates
  the check to a party with an interest in the answer.

There is deliberately no default — with `merge.enabled`, this decides what "the
reviewer was happy" means, and inheriting that silently is the mistake the
field exists to prevent. rloop found this in its own gate: a `COMMENTED` review
carrying a real finding satisfied the reviewer condition.

## Command reviewers

`reviewers:` is a top-level list, and it holds two kinds of entry. `kind:
forge` is everything above — a GitHub login rloop polls for a verdict.
`kind: command` is a local program you write yourself: no bot to install, no
network call rloop makes on your behalf, just a process you control.

```yaml
reviewers:
  - name: copilot
    kind: forge
    login: copilot-pull-request-reviewer
    required_state: any_verdict

  - name: local-review
    kind: command
    run: my-review-script --base origin/main
    timeout_seconds: 600        # default; max 3600
    dismiss:
      - fingerprint: a1b2c3d4
        reason: "false positive — checked manually, see PR #123"
```

### The contract: one JSON document on stdout

rloop runs the command once, from the repo root, with `RLOOP_HEAD_SHA` set to
the current head commit. The command must print **exactly one JSON document
on stdout and nothing else** — any narration ("analysing 41 files…", progress
bars, retries) belongs on **stderr**. rloop captures the two streams
separately for exactly this reason: a real tool that logs progress would
otherwise corrupt the document the moment it prints anything.

```json
{
  "sha": "<echo of RLOOP_HEAD_SHA>",
  "findings": [
    {
      "severity": "critical",
      "title": "Unchecked null deref",
      "id": "RULE042",
      "path": "src/a.ts",
      "line": 10,
      "body": "optional free-text detail"
    }
  ]
}
```

`sha` is required; so are a finding's `severity` and `title`. `id`, `path`,
`line` and `body` are optional. Every other key — top-level or per-finding —
fails the schema: a provider printing a field rloop does not recognize is a
provider written against a different contract, and guessing which half is
right is how a blocking finding gets silently dropped.

### What the `sha` echo proves, and what it does not

The provider echoes `RLOOP_HEAD_SHA` back as `sha`. That proves the command
**ran during this invocation** — not a cached document, not a stale file from
an earlier run left lying around. It does **not** prove the provider actually
read the tree at that commit; a provider could echo the variable without
opening a single file. The real binding is not the echo, it is that rloop
[refuses to run against a dirty
worktree](#worktree-is-dirty-a-gate-run-against-uncommitted-changes-proves-nothing):
on a clean tree, "the working tree" and "that commit" are the same bytes, so a
provider that inspects the former is inspecting the latter. The echo catches
a *cached* run; the clean-tree requirement is what makes "ran now" mean "ran
against this commit".

### Classification

Order matters — this table is `runCommandReviewer`'s whole contract:

| Condition | Status |
|---|---|
| spawn failed, or timed out | `unavailable` — never ran |
| output unusable (unparseable OR fails the document schema) AND exit != 0 | `unavailable` — crashed mid-review |
| output unusable (unparseable OR fails the document schema) AND exit == 0 | `malformed` — ran fine, printed junk |
| echoed `sha` != head | `stale` |
| blocking findings present | `findings` |
| otherwise | `clean` |

The exit code is the provider's own verdict on whether it ran. rloop trusts
that verdict over the shape of whatever it printed: a non-zero exit wins even
when the printed JSON is well-formed but fails the schema, and `malformed` is
reserved for the case where the provider claims success (`exit 0`) and the
output still cannot be used — parsed or not.

Nothing on this list returns `clean` on a path where the review did not
actually happen.

### Severity and what blocks

Three severities: `critical`, `important`, `minor`. Only `critical` and
`important` block a merge. An unrecognized severity value fails the document
schema — it comes back `malformed`, not an ignored finding. `minor` findings
are still reported, in `rloop pr status` output and in the JSON result, so
the loop can act on them; a report containing only `minor` findings is
`clean`.

### Fingerprints and clearing findings

Every finding gets an 8-hex-character fingerprint, computed by rloop — never
supplied by the provider — from its `id` if present, otherwise from `path`
plus a normalized `title`. It **never incorporates the line number**: an
edit anywhere above a finding moves the line, and a fingerprint that changed
on every unrelated edit would report every finding as new on every run. That
matters because **a finding clears by disappearing from the next run's
output** — there is no "resolved" flag to set. Paste the printed fingerprint
into `dismiss:` to suppress a specific finding; `reason` is required, because
a dismissal with no stated reason is indistinguishable from a finding someone
silenced because it was inconvenient.

### Degradation always blocks the merge

Three situations count as review **degradation**, and each blocks `pr merge`
unconditionally — every gate being green is not enough:

| Reason | When |
|---|---|
| `not_configured` | `reviewers:` is empty — checked unconditionally, not only when `merge.enabled` is true |
| `unavailable` | any configured reviewer's status is `unavailable` |
| `malformed` | any configured reviewer's status is `malformed` |

Degradation prints a banner (`⚠ EXTERNAL REVIEW DEGRADED`) and adds a
`reviewer_degraded` blocker regardless of what else passed. Gates still run —
degradation is about the review stream, not the code under test — but the
merge does not happen without one.

### Blocker codes

Alongside the forge-only codes that already existed —
`reviewer_changes_requested`, `reviewer_not_approved`, `reviewer_no_verdict`
— a `reviewers:` block can now produce:

| Code | Means |
|---|---|
| `reviewer_degraded` | review is degraded — see above; always blocks |
| `reviewer_unavailable` | a reviewer's status is `unavailable` |
| `reviewer_malformed` | a reviewer's status is `malformed` |
| `reviewer_findings_open` | a `kind: command` reviewer has open (non-dismissed) blocking findings |

`reviewer_stale` is not forge-only, even though it predates this feature: a
`kind: command` reviewer whose echoed `sha` does not match head produces
`status: stale` exactly like a forge review against an old commit, and both
land on the same `reviewer_stale` blocker — see the classification table
above.

### Deprecated: `merge.required_reviewers` / `merge.required_reviewer_state`

These two keys still work — rloop 0.2.1 is published and configs in the wild
set them. `loadConfig` desugars each login in `required_reviewers` into a
`kind: forge` entry in `reviewers:`, using `required_reviewer_state` (default
`approved`) as its `required_state`, and `rloop check` prints a warning
pointing at the replacement. They will be removed in 1.0.

Setting **both** forms — the deprecated keys and a non-empty `reviewers:` — is
a config error, not a merge: two sources of truth for who must review a PR is
a config whose author cannot predict what will happen.

```yaml
# Old (still works, but deprecated and warned about):
merge:
  required_reviewers: [copilot-pull-request-reviewer]
  required_reviewer_state: any_verdict

# New, equivalent:
reviewers:
  - name: copilot-pull-request-reviewer
    kind: forge
    login: copilot-pull-request-reviewer
    required_state: any_verdict
```

The desugared entry's `name` is the login itself. Migrating by hand and
giving it a friendlier report name (`copilot` instead of the full login) is a
deliberate difference from auto-desugaring, not a bug.

## What it cannot do

A tool whose argument is "prove it, do not assume it" owes you the list of
things it does not prove.

**The verdict comes from a machine you trust, not a neutral one.** This is the
real thing CI does better, and no amount of care here closes it. A hosted runner
starts from a fresh checkout every time; rloop runs in whatever state your
working copy is actually in. A live example, from gating a repo whose root
`npm test` covers only one workspace: the gate went red on 18 test files that
had nothing to do with the branch. The cause was stale compiled `.js` left in
`src/` by a tsconfig that used to emit in place — invisible to the branch, fatal
to the run, and impossible on CI. The dirty-worktree void and the SHA binding
narrow this; they do not remove it. If you need a verdict a third party can
audit, you need a runner, not this.

**`forbid` fails open.** `require` patterns fail closed — a marker that stops
printing fails the gate, which is the safe direction. `forbid` has the opposite
bias: if your test runner renames `FAIL` in a minor release, the pattern quietly
stops matching and takes a failure mode with it. Nothing detects that. Treat
`forbid` as a second line, never the only one, and pin the tool versions your
markers were written against.

**It cannot tell a real suite from a hollow one.** `Tests 1800 passed` and
`Tests 1 passed` both satisfy `[1-9][0-9]* passed`. Requiring a non-zero count
catches a glob that broke completely; it says nothing about one that silently
narrowed. If that matters, assert a floor on the count in your own script and
gate on its output.

**A green run proves the gates you configured passed** — not that they were the
right gates. rloop has no idea what your PR touched or which suite covers it.
Deriving that from the diff sounds appealing and is a trap: the coupling between
changed files and affected suites is not the directory tree. Name every suite
unconditionally and pay the wall-clock.

**There is no audit trail anyone else can read.** Logs land in `log_dir` on the
machine that ran them. Nothing is signed, published, or attested. "The gate was
green" is a claim, backed by a file you could have edited.

## Results carry evidence

```json
{
  "green": false,
  "sha": "061b9a4",
  "gates": [{
    "name": "build",
    "status": "fail",
    "reason": "forbidden_match",
    "exitCode": 0,
    "summary": "build: forbidden pattern \"npm ERR!\" matched at line 11",
    "evidence": { "forbiddenMatched": [{ "pattern": "npm ERR!", "line": 11, "text": "…" }] }
  }]
}
```

`exitCode: 0`, verdict `fail`. A bare boolean makes a caller retry blindly; a
line number lets it fix the cause.

## MCP server

The same core, exposed to any MCP host. Zero logic lives in the server — it
parses arguments, calls a core function, and serializes the result. Every rule
that matters is in the core, unit-tested there, so there is no second copy to
drift.

### Two modes

**Pinned** — one server, one project. Every tool serves that config, and a call
naming a different one is **refused**:

```bash
claude mcp add rloop -- node /path/to/rloop/dist/mcp/server.js \
  -e RLOOP_CONFIG=/path/to/repo/rloop.yaml \
  -e RLOOP_REPO=/path/to/repo
```

**Multi-project** — one server, many repos. Leave the env vars unset; each call
passes `configPath`:

```bash
claude mcp add rloop -- node /path/to/rloop/dist/mcp/server.js
```

```jsonc
{ "name": "gate_run", "arguments": { "configPath": "/repos/alpha/rloop.yaml" } }
{ "name": "gate_run", "arguments": { "configPath": "/repos/beta/rloop.yaml" } }
```

Pick pinned when the server is scoped to one repository — the config carries
the merge policy (base-branch allowlist, whether merging is enabled at all), so
refusing to be redirected means a caller cannot swap that policy for a laxer
one. Pick multi-project when an agent genuinely works across repos in one
session.

`repoRoot` is optional in both modes and defaults to the config file's
directory. Config is re-read per call, so editing `rloop.yaml` needs no
restart.

**There is no cwd fallback.** In multi-project mode a call without `configPath`
is an error, not a guess. An MCP server is launched with whatever cwd the host
picked, and an upward search from the wrong directory can silently resolve to a
*different* repository's config — running one project's gates with another
project's markers, with no error to notice.

**Tools**

| Tool | Annotation | Does |
|---|---|---|
| `check` | read-only | Validate config, list gates, report warnings |
| `preflight` | read-only | Environment, committer and worktree checks |
| `gate_run` | executes, non-destructive | Run gates, return verdict **with evidence** |
| `pr_status` | read-only | Every merge condition, all blockers at once |
| `pr_threads` | read-only | Review threads, paged to exhaustion |
| `pr_reply_and_resolve` | writes | Reply, then resolve — never one without the other |
| `pr_merge` | **destructive** | Re-checks everything, then merges. No force flag. |

Only `pr_merge` carries `destructiveHint: true`, so hosts can gate exactly the
one irreversible operation rather than treating the whole server as dangerous.

**Resources** — so an agent can read the rules it is being held to instead of
guessing them.

| URI | Available | Serves |
|---|---|---|
| `rloop://config` | pinned mode only | the pinned project's config |
| `rloop://config{+configPath}` | always | any project, by absolute path |

```
rloop://config/home/you/repos/alpha/rloop.yaml
```

The template uses `{+var}` reserved expansion so the variable can contain the
slashes of an absolute path — a plain `{var}` stops at the first one and never
matches.

Two properties worth knowing. Template reads route through the same resolver as
the tools, so **a pinned server refuses another project's config here too** — a
resource is not a side door around the pin. And `rloop://config` is only
registered when a project is pinned: in multi-project mode it could never
resolve, and advertising a resource that always errors is worse than not
offering it.

**Prompt** — `loop` serves the review–fix–merge procedure: parallel review
streams, severity classification (ambiguous classifies *up*), the fix loop,
thread resolution, and when to stop and ask.

That prompt is the host-agnostic home for the judgment half. A harness wrapper
becomes a thin pointer to it instead of a re-authored copy that slowly diverges.

### Claude Code skill

`skills/r-loop/SKILL.md` is that wrapper. Copy it to `.claude/skills/r-loop/`
in your project and edit one thing: the list of review subagents to dispatch.

It deliberately contains no gate commands, no merge conditions, and no
procedure — those live in the core, `rloop.yaml`, and the `loop` prompt
respectively. What it *does* carry is the one thing MCP cannot express:
dispatching parallel review subagents, which is a Claude Code feature with no
protocol equivalent.

Rule of thumb when installing it: if you find yourself adding project-specific
rules to the skill, they belong in `rloop.yaml` instead — that is the file the
tools actually enforce.

## The merge gate

`rloop pr merge` re-derives the whole decision itself before touching anything.
It takes no "it's fine, I checked" flag — an agent driving this tool may be
holding a verdict from three tool calls ago.

Every condition is evaluated and all failures reported at once, so you fix
three blockers in one pass instead of discovering them one re-run at a time:

```console
$ rloop pr status 804
PR #804 Migrate residual config-rot validators…
  MERGED · → staging · head 9dbe1e8

  ~ copilot-pull-request-reviewer[bot] COMMENTED (stale: a5aab06)
  ✓ copilot-pull-request-reviewer[bot] COMMENTED
  ✓ threads: 0/0 resolved

BLOCKED — 4 condition(s) not met:
  ✗ [pr_not_open]         PR #804 is MERGED, not OPEN.
  ✗ [sha_mismatch_gates]  Gates ran on 0000000 but PR head is 9dbe1e8.
  …
```

The rule underneath every check: **a missing signal is a blocker, never a
pass.** No review yet is not approval. Gates you skipped are not gates that
passed.

### Reply before resolve, always

A resolved thread with no reply is worse than an open one — it reads as handled,
so nobody re-opens it, and the reviewer's point is gone from the checklist
unanswered. `replyAndResolve` posts the reply, requires the API to hand back a
reply id as proof, and only then resolves. Any failure leaves the thread open,
which keeps blocking the merge. That is the safe direction.

### Reviewer logins are not one string

The same bot answers to three spellings, verified live:

| Surface | Login |
|---|---|
| Requesting a reviewer | `copilot-pull-request-reviewer[bot]` (without `[bot]` the call silently no-ops) |
| REST `/pulls/N/reviews` | `copilot-pull-request-reviewer[bot]` |
| GraphQL `reviewThreads` | `copilot-pull-request-reviewer` |
| `requested_reviewers[].login` | `Copilot` |

Comparing raw strings reports "no verdict" for a review that plainly exists.
That fails safe — no verdict blocks a merge — but it still burns a polling
window, so `matchesReviewer` normalizes instead.

### No tokens

The GitHub adapter shells out to `gh`. rloop never reads, stores or forwards a
credential, so a leak here cannot expose one it never held. Every call uses an
argv array, never a shell string — review bodies are arbitrary text that has
been through a model and a diff.

## Exactly which npm invocations lie

Measured on npm 9.2.0 / Node 22, and asserted in `test/npm-masking.test.ts` so
these claims cannot rot:

| Invocation | Exit code on failure |
|---|---|
| Standalone package, `npm run boom` | `7` — correct |
| `npm run boom --workspace=child` | `0` — **masked** |
| Root script wrapping `npm run --workspace=child` | `0` — **masked** |
| `cd child && npm run boom` | `0` — **masked** |

The trigger is **workspace membership**, not the `--workspace` flag. `cd`-ing
into the package does not escape it.

The practical consequence: **`npm run x && echo MARKER` is not a guard inside a
workspace.** The marker prints on failure. If you need to mint a positive marker
for a tool that is silent on success, keep npm out of the chain:

```yaml
run: npx tsc -b && echo "RLOOP_TSC_OK"    # tsc propagates its own exit code
require: ["^RLOOP_TSC_OK$"]
```

Those tests skip themselves on other npm majors rather than failing, so if a
future npm fixes this, you will find out here rather than from folklore.

## Known gotcha

npm echoes the script body before running it, so a script whose *text* contains
a forbidden string trips its own guard. Put the failure strings in your config,
not in your script names.

## Troubleshooting

Most of these are rloop refusing to guess. The message names the cause; this is
what to do about it.

### `worktree is dirty. A gate run against uncommitted changes proves nothing`

You have uncommitted changes to **tracked** files. The gates would test your
working copy while the verdict claims to be about a commit, so rloop declines to
render one. Untracked files are ignored — only modifications count.

```bash
git status --porcelain --untracked-files=no   # exactly what rloop looks at
```

Commit or stash them. `--only` does **not** get you past this — it selects which
gates run, not whether the verdict is trustworthy.

If you just want to know whether the code works right now, say so explicitly:

```bash
rloop gate --allow-dirty
```

The gates run, and the result is still marked `VOID — worktree was dirty. These
gates did not verify <sha>.` with exit code 2. The flag moves where the run
stops; it cannot turn an unverifiable run into a verdict.

### `no config found. Looked for rloop.yaml … from <dir> upward`

You are outside the repo, or the file is not where you think. Point at it:

```bash
rloop gate -c /path/to/rloop.yaml -C /path/to/repo
```

`-c` is the config, `-C` the repo root. The MCP server needs both explicitly —
it deliberately has no upward search, because a host can launch it with any
working directory and the search could silently resolve to a different repo.

### `committer identity is "X", config requires "Y"`

Your `git config user.name`/`user.email` do not match the `committer` block. Fix
whichever is wrong — usually you switched identity for another project and did
not switch back. See [Writing your config](#writing-your-config), or delete the
`committer` block to skip the check.

### The command works by hand, but the gate says `required pattern(s) never appeared`

Your marker does not match the real output. Read what actually printed:

```bash
rloop gate --only <name>
less .rloop/logs/<name>.log
```

Three usual causes: the pattern is anchored with `^` but the line is indented
(use `^\s*`); the tool changed its wording in a version bump; or the marker
prints to stderr in a form you did not expect. rloop matches **per line**, so
`^` and `$` mean what they do in `grep -E`.

### The gate goes red on a run that is genuinely fine

A `forbid` pattern is matching ordinary text. The classic is a bare `failed`,
which appears inside legitimately passing error-path tests ("task 1 failed").
The log names the offender:

```
forbidden pattern "failed" matched at line 412
   412 │   ✓ retries when the first attempt failed
```

Anchor it (`^\s*FAIL `), or exclude the known-noise shape with a negative
lookahead. Do not delete the guard.

### `PARTIAL — 1 selected gate(s) passed, but not every gate ran`

You used `--only`. That is not a merge verdict and never will be, by design.
Run `rloop gate` with no filter for one.

### Exit code 2 instead of 0 or 1

`1` means a gate failed — the code is broken. `2` means **no verdict**: bad
config, a preflight blocker, a timeout, or a run voided by a dirty tree or
HEAD moving mid-run. Both block a merge, but only `1` is about your code.

### `pr merge` refuses with `base_not_allowed`

The PR targets a branch not in `merge.allowed_base_branches`. If that is
deliberate — a release branch an agent must never merge into — this is working.
If not, add the branch.

### `pr merge` refuses with `reviewer_stale`

Your reviewer approved an earlier commit and you have pushed since. Re-request
the review on the current head. Two reviewers agreeing about different versions
of the code is not agreement.

### `gh: command not found`, or every `pr` command fails

rloop shells out to the GitHub CLI and never handles a token itself. Install
`gh` and authenticate:

```bash
gh auth status   # must show a logged-in account
```

### A gate is rejected at `rloop check`

Two rules a config cannot break. **A gate with no `require` and no `forbid`** is
refused, because it would pass on exit code alone, which is the thing this tool
exists not to trust. **`merge.enabled: true` with an empty
`allowed_base_branches`** is refused for the same class of reason: enabling
merges without saying where is not a configuration, it is an oversight.

A gate with only `forbid` patterns is allowed — `tsc -b` prints nothing on
success — but warns, because it can only catch failure modes you already thought
of.

## Layout

| Path | What |
|---|---|
| `src/config.ts` | Config schema + validation (zod) |
| `src/evidence.ts` | Marker matching — the testable core |
| `src/gate.ts` | Runner: process control, SHA binding, path conditions |
| `test/fixtures/` | Golden logs, including a real masked failure |
| `examples/` | Ready-to-copy configs |

## License

Apache License 2.0 — see [LICENSE](LICENSE).
