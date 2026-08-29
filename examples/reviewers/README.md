# A model-backed `kind: command` reviewer

`codex-review.sh` is a complete provider. It is ~30 lines of actual work, and
that is the point of this directory: the hard parts of wiring a model into
`reviewers:` are not the model call, they are five safety properties that fail
*silently*, and rloop owns four of them so you do not have to.

## The config

```yaml
reviewers:
  - name: codex
    kind: command
    run: ./examples/reviewers/codex-review.sh
    timeout_seconds: 900

    # rloop fetches origin/<base>, diffs from the merge base, and writes it to
    # RLOOP_DIFF_FILE. A failed fetch becomes `unavailable`, which blocks —
    # never a review against a stale tracking ref.
    needs_diff: true

    # Cap for a model with a context limit. rloop refuses to accept `clean`
    # from a run whose diff it truncated.
    diff_max_bytes: 400000

    # The provider does not echo the sha; rloop supplies it. See below.
    inject_sha: true
```

## What rloop sets

| Variable | Value |
|---|---|
| `RLOOP_HEAD_SHA` | the commit under review |
| `RLOOP_BASE_REF` | e.g. `origin/main` — already fetched |
| `RLOOP_DIFF_FILE` | absolute path to `git diff <base>...HEAD` |
| `RLOOP_DIFF_BYTES` | size of that file |
| `RLOOP_DIFF_TRUNCATED` | `1` if `diff_max_bytes` cut it short |

The last four appear only under `needs_diff: true`.

## The five properties, and who owns each

**Fetch failure must be fatal.** rloop. A tracking ref that was not updated is
not detectably wrong — the diff still applies, still parses, still describes
real code, and is merely about a base nobody is merging into. A reviewer handed
that reports `clean` with total confidence.

**Truncation must not report clean.** rloop. Only if rloop did the truncating,
which is what `diff_max_bytes` is for.

**The truncation check must run after dismissals.** rloop, necessarily. A
provider counts findings *before* `dismiss:` is applied; rloop decides *after*.
A truncated diff yielding one critical finding that a dismissal then removes
leaves the provider exiting 0 (it found something) and rloop seeing nothing
blocking — a partial review reported clean, from two pieces of individually
correct logic. **The general rule: any provider logic keyed on "did I find
something blocking" is keyed on the wrong number.**

**Provider crash must not look clean.** Shared. rloop's contract already says a
non-zero exit can never produce `clean` — but that only works if your exit code
is true, and a shell pipeline ending in `jq` exits 0 over a dead pipeline.
`set -o pipefail` is the whole fix, and its absence is invisible until the day
the model is down.

**Findings need stable ids.** Yours. rloop fingerprints a finding by `id`, or
by `path` + normalized `title` when there is no id. Titles from a model are not
stable — one defect came back worded three ways across three runs during this
feature's own development, which is three fingerprints and three dead
`dismiss:` entries, failing silently while the config still looks configured.
Ask the model for a slug naming the *defect*, not its sentence about it. rloop
says so when a dismissal misses and the findings carried no ids.

## Two smaller walls

**Structured outputs and optional fields collide.** OpenAI requires every key
in `properties` to appear in `required`. rloop treats `id`/`path`/`line`/`body`
as optional but rejects unknown keys and empty-string values are values, not
absences — so ask the model for all six fields and strip the empty ones before
printing. That is the `jq` filter in the script.

**Pipe the diff, never pass it as an argument.** `MAX_ARG_STRLEN` caps a single
argv element at 131072 bytes on a 4K-page Linux — about 32 pages of diff — and
exceeding it fails at spawn with `E2BIG`, which reads as "the reviewer is
broken".

## One problem with no clean answer

A provider's prompt lives in the repo, so **the provider flags its own source**
whenever a PR touches it: any rule of the form "text addressing the reviewer is
suspicious" self-triggers on the file containing that rule. Dismissing it by
`id` disables the rule globally, which is a bad trade. There is no fix here,
only the warning — you will meet this the first time you edit your prompt.
