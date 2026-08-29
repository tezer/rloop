# A model-backed `kind: command` reviewer

`codex-review.sh` is a complete provider. Read this file before you copy it,
because the hard part of wiring a model into `reviewers:` is not the model
call — it is five safety properties that each fail **silently**, and **rloop
currently owns none of them.**

That is a statement about the current release, not a design position. An
attempt to move four of them into rloop was written, reviewed, and **withdrawn
from 0.4.0** with nine defects against it, every one in the git-interaction
layer it added. The work is tracked in #7. Until it lands, the list below is
yours.

## What rloop sets

| Variable | Value |
|---|---|
| `RLOOP_HEAD_SHA` | the commit under review |

That is the whole list. Your provider derives its own base and produces its
own diff.

## The config

```yaml
reviewers:
  - name: codex
    kind: command
    run: ./examples/reviewers/codex-review.sh
    timeout_seconds: 900

    # The provider does not echo the sha; rloop supplies it. Safe here because
    # this provider reads a diff of COMMITTED state. Leave it off for a
    # provider that reads the working tree — see the main README.
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
opportunistic update, which needs `remote.origin.fetch` configured. In a
worktree or a CI checkout where it is not, use the explicit refspec
`+refs/heads/main:refs/remotes/origin/main`.)

**2. Diff from the merge base — yours.** Use three-dot (`base...HEAD`). A
two-dot diff against a base that has moved presents the base's own new commits
as reverts by your branch.

**3. A diff you could not read in full must not report clean — yours.** If your
model hits its context limit, or you capped the diff, the review covered part
of the change. **Exit non-zero.** rloop's contract turns "no blocking findings
+ non-zero exit" into `unavailable`, which blocks — that is the only lever you
have here.

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
about the defect. rloop says so when a dismissal misses and the findings
carried no ids.

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
