---
name: r-loop
description: Use on every PR you author — the autonomous review-fix-merge cycle. Runs external review and local review passes in parallel, gates the build on output evidence rather than exit codes, drives review threads to zero, and merges only when every condition holds on one commit. Invoke immediately after the initial push of a PR branch, and re-enter after every push to an open PR.
---

# r-loop — autonomous PR review-fix-merge cycle

This skill is a **wrapper**. The procedure itself lives in the rloop MCP
server's `loop` prompt, and the rules it enforces live in the rloop core where
they are unit-tested.

**Load the procedure first**: get the `loop` prompt from the `rloop` MCP server
and follow it. Everything below is only what that prompt cannot cover — the
parts specific to running inside Claude Code.

Do not re-derive the procedure from this file. If this file and the `loop`
prompt ever disagree, the prompt wins.

## What lives where

| Concern | Owner | Why |
|---|---|---|
| Gate evidence, SHA agreement, merge conditions | rloop core | Unit-tested; a second copy would drift |
| The loop, severity calls, when to stop | `loop` MCP prompt | Host-agnostic, one copy for every harness |
| Parallel subagent review | **this file** | Claude Code feature; MCP has no equivalent |

## The one thing the MCP server cannot do

The `loop` prompt says "trigger every review stream in parallel". The external
reviewer is a tool call. The **local** review passes are Claude Code subagents,
which no MCP server can dispatch.

Dispatch them yourself, **all in one message with multiple Agent calls** so they
run concurrently. Scope each to the PR's diff:

```
gh pr diff <N>
```

or, if that is unavailable:

```
git fetch origin <base> && git diff origin/<base>...HEAD
```

Never diff against a bare local branch name — the local ref can be stale, which
hands every reviewer a diff bloated with already-merged work.

**Reviewers to dispatch** — edit this list when you install the skill:

1. `pr-review-toolkit:code-reviewer`
2. `pr-review-toolkit:type-design-analyzer`
3. `pr-review-toolkit:silent-failure-hunter`
4. `pr-review-toolkit:comment-analyzer`
5. `pr-review-toolkit:pr-test-analyzer`

Each reports findings as critical / important / minor. Ambiguous severity
classifies **up** — you are both the classifier and the thing that merges, so
the bias must run against your own convenience.

A subagent that returns nothing is not a clean pass. Re-dispatch it or surface
the failure; never treat silence as approval.

## Tool map

| You need to | Call |
|---|---|
| See where the PR stands | `pr_status` |
| Know if the environment can even render a verdict | `preflight` |
| Prove the build and tests | `gate_run` |
| List review threads | `pr_threads` |
| Answer a thread | `pr_reply_and_resolve` |
| Merge | `pr_merge` |

`pr_status` runs the gates itself, so you rarely need `gate_run` separately —
reach for it when iterating on a fix and you want the gate result alone.

In multi-project mode every call needs `configPath` (the absolute path to that
project's `rloop.yaml`). A pinned server needs nothing.

## Do not work around the tools

These refusals are the point of the tool, not obstacles to route around:

- **`pr_merge` refuses.** Read the blockers, fix them, loop. There is no force
  flag and adding one is not the fix.
- **A gate run comes back void** (dirty worktree, HEAD moved). Commit or stash
  and re-run. Do not pass `--allow-dirty` to get a verdict you intend to act on;
  that flag exists for debugging markers, and the run is still void.
- **A gate is red but you believe the code is fine.** Read the evidence — it
  names the pattern and the log line. If the *marker* is wrong, fix the marker
  in `rloop.yaml` and say so explicitly in your report. Never hand-edit a log
  or work around the gate.
- **`preflight` blocks.** That is an operator problem (a service down, wrong
  committer identity). Surface it; do not proceed.

## If the MCP server is not connected

Fall back to the CLI — same core, same rules:

| Tool | CLI |
|---|---|
| `preflight` | `rloop preflight` |
| `gate_run` | `rloop gate` |
| `pr_status` | `rloop pr status <N>` |
| `pr_threads` | `rloop pr threads <N>` |
| `pr_reply_and_resolve` | `rloop pr reply <N> --thread <id> --body "..."` |
| `pr_merge` | `rloop pr merge <N>` |

Exit codes: `0` pass · `1` a gate failed · `2` no verdict (config, preflight,
timeout, or a void run). Both `1` and `2` block a merge.

If neither the MCP server nor the CLI is available, **stop and say so**. Do not
reconstruct the gate by hand with `npm run build && npm test` — that is the
exact false-green this tool exists to prevent.

## Installing this skill in a project

Two edits:

1. The reviewer list above — use whatever review subagents that project has.
2. Nothing else. Project-specific gates, merge policy, and the base-branch
   allowlist all live in that project's `rloop.yaml`, not here.

If you find yourself adding project-specific rules to this file, they probably
belong in `rloop.yaml` instead — that is the file the tools actually enforce.
