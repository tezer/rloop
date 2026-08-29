# A model-backed `kind: command` reviewer

`codex-review.sh` is a complete provider. Read this file before you copy it,
because the hard part of wiring a model into `reviewers:` is not the model
call — it is five safety properties that each fail **silently**, and **rloop
currently owns none of them.**

That is a statement about the current release, not a design position. An
attempt to move four of them into rloop was written, reviewed, and **withdrawn
from 0.4.0** with nine defects against it, every one in the git-interaction
layer it added. Until a second attempt lands, the list below is yours.

## What rloop sets

| Variable | Value |
|---|---|
| `RLOOP_HEAD_SHA` | the commit under review — the **forge's** PR head |

That is the whole list. Your provider derives its own base and produces its
own diff.

Diff `$RLOOP_HEAD_SHA`, not `HEAD`. They are not the same: local `HEAD` is
whatever is checked out, and in an agent loop it routinely differs (a commit
made but not pushed, a stale checkout, a push from elsewhere). Naming the sha
also fails safe — if it is not present locally, git errors and your provider
exits non-zero.

`codex-review.sh` takes two knobs of its own, `REVIEW_BASE_BRANCH` (default
`main`) and `REVIEW_MAX_DIFF_BYTES` (default 400000). They are deliberately
**not** `RLOOP_`-prefixed: a variable that looks like rloop's reads as though
rloop validates it, and rloop has never heard of them.

## The config

```yaml
reviewers:
  - name: codex
    kind: command
    run: ./examples/reviewers/codex-review.sh
    timeout_seconds: 900

    # The provider does not echo the sha; rloop supplies it. Safe here because
    # the script diffs $RLOOP_HEAD_SHA specifically — not "because it reads
    # committed state", which is necessary but not sufficient: it has to be
    # the RIGHT commit. Leave it off for a provider that diffs plain HEAD or
    # reads the working tree.
    inject_sha: true
```

## The five properties, and what rloop does about each

**1. Fetch failure must be fatal — yours.** Your provider runs
`git fetch origin <base>` and must **exit non-zero if it fails**. A tracking
ref that was not updated is not detectably wrong: the diff still applies, still
parses, still describes real code, and is merely about a base nobody is merging
into. A reviewer handed that reports `clean` with total confidence. rloop
cannot see the difference. (`git fetch origin main` *does* update
`refs/remotes/origin/main` in a normal clone — verified — but only via git's
opportunistic update, which needs a `remote.origin.fetch` refspec **covering
the base branch** — that is the whole rule, not a property of the clone type.
`--single-branch --branch feature` does not cover `main`, so the bare form
never creates `origin/main`; use the explicit
`+refs/heads/main:refs/remotes/origin/main`. A linked `git worktree` is fine,
it inherits the parent's config.)

**Shallowness is a separate requirement, and the refspec does not fix it.**
`actions/checkout` defaults to `fetch-depth: 1`. The explicit fetch then
succeeds and creates a correct `origin/main`, and the three-dot diff still
fails with `fatal: … no merge base` — there is no shared history to find one
in. Set `fetch-depth: 0`, or `git fetch --unshallow`. This one fails loudly, so
it costs you a red run rather than a wrong verdict.

**2. Diff from the merge base — yours.** Use three-dot
(`origin/<base>...$RLOOP_HEAD_SHA`). A two-dot diff against a base that has
moved presents the base's own new commits as reverts by your branch.

**3. A diff you could not read in full must not report clean — yours.** If your
model hits its context limit, or you capped the diff, the review covered part
of the change. **Exit non-zero before printing anything**, which rloop
classifies `unavailable` (`crashed`: a non-zero exit with no usable document).
That is the only lever you have here. Note it is not the `contradicted` rule —
that one needs a parseable document *alongside* the failure. Both block.

Validate your own numeric knobs while you are at it: `set -e` does not apply
inside an `if` condition, so `[ "$n" -gt "$MAX" ]` with a `$MAX` the shell
cannot compare returns 2, the `if` reads false, and your size guard silently
does nothing. Two shapes reach that, not one — a non-numeric value, and a
numeric value too large for the shell's integer type. Bounding the *length*
is not enough either: `2^63-1` is itself 19 digits, so a 19-digit cap still
admits values above it. Cap at 18.

**4. Do not key that decision on your own finding count — structural.** rloop
applies `dismiss:` *after* your provider exits. So a partial review that found
one critical finding, which a dismissal then removes, leaves you exiting 0
(you found something) and rloop seeing nothing blocking. **Any provider logic
keyed on "did I find something blocking" is keyed on the wrong number.** Key
your exit code on whether you *reviewed the whole diff*, never on what you
found in it.

**5. Findings need stable `id`s — yours.** rloop fingerprints a finding by
`id`, or by `path` + normalized `title` when there is no id. Titles from a
model are not stable — one defect came back worded three ways across three runs
while this example was being written, which is three fingerprints and three
dead `dismiss:` entries, failing silently while the config still looks
configured. Ask the model for a slug naming the *defect*, not its sentence
about the defect, and tell it two findings must never share an id.

rloop helps at both ends, but only after the fact. When a dismissal matches
nothing it says how many of the run's findings carried no `id`. And when a
dismissal's fingerprint matches **more than one** finding it **refuses the
dismissal** rather than applying it — two different defects that a model worded
the same way in the same file collapse onto one fingerprint, and one `dismiss:`
entry would otherwise suppress both and report `clean` with no output at all.

## `set -o pipefail`, and the case it actually covers

Use it. But be clear about which failure it catches, because the obvious story
is wrong:

- **Model dies, prints nothing.** Without `pipefail` the script exits 0 — but
  stdout is *empty*, so rloop gets no parseable document and reports
  `malformed`, which blocks. Not silent, and not the reason to use `pipefail`.
- **Model prints a usable document *and* the pipeline fails** (a non-zero
  producer whose partial output still parses). Without `pipefail` the script
  exits 0, rloop sees a valid document and a clean exit, and reports **`clean`**.
  *This* is the case `pipefail` exists for: with it, the script exits non-zero,
  rloop sees the contradiction, and blocks.

## Two smaller walls

**Structured outputs and optional fields collide.** OpenAI requires every key
in `properties` to appear in `required`. rloop treats `id`/`path`/`line`/`body`
as optional but rejects unknown keys, and an empty string is a value, not an
absence — so ask the model for all six fields and strip the empty ones before
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
