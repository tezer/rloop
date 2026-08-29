#!/usr/bin/env bash
#
# A model-backed `kind: command` reviewer, end to end.
#
# READ ./README.md FIRST. rloop sets exactly one variable (`RLOOP_HEAD_SHA`)
# and owns none of the five safety properties a provider needs; the fetch, the
# merge base, the commit identity, and the "I only reviewed part of it" exit
# code are all handled here, and getting any of them wrong produces a
# confident, well-formed, wrong verdict that rloop cannot detect.
#
# Written against the Codex CLI. Swapping the model is the `codex exec` line
# and the schema path; nothing else in this file is vendor-specific.

# `-e` so a failing step stops the script, `-u` so a typo'd variable is an
# error rather than an empty string, and `-o pipefail` for the specific case
# in README.md: a producer that prints a usable document AND fails. Without
# pipefail that combination exits 0, and rloop — seeing a parseable document
# and a clean exit — reports `clean`.
set -euo pipefail

# THIS SCRIPT'S OWN KNOBS. Deliberately NOT `RLOOP_`-prefixed: rloop sets
# `RLOOP_HEAD_SHA` and nothing else, and a variable that looks like rloop's
# reads as though rloop validates it. Nobody validates these but the lines
# immediately below.
BASE_BRANCH="${REVIEW_BASE_BRANCH:-main}"
MAX_BYTES="${REVIEW_MAX_DIFF_BYTES:-400000}"

# `set -e` does NOT apply inside an `if` condition, so a later
# `[ "$n" -gt "$MAX_BYTES" ]` with a non-numeric MAX_BYTES returns 2, the `if`
# reads it as false, and the size guard is skipped entirely — a partial review
# reported as a pass, arriving through the guard written to prevent it.
# Measured with `REVIEW_MAX_DIFF_BYTES=400k`. Validate it here instead.
case "$MAX_BYTES" in
  '' | *[!0-9]*)
    echo "refusing: REVIEW_MAX_DIFF_BYTES must be a plain byte count, got '${MAX_BYTES}'" >&2
    exit 1
    ;;
esac

# Resolve relative to THIS FILE, not to $0: a copier who puts the script on
# PATH or behind a symlink otherwise gets `dirname` of the wrapper.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCHEMA="$SCRIPT_DIR/finding-schema.json"

# Narration goes to stderr. rloop captures the two streams separately, and
# anything on stdout that is not the JSON document corrupts it.
echo "reviewing ${BASE_BRANCH}...${RLOOP_HEAD_SHA}" >&2

# FATAL, deliberately. A tracking ref that was not updated is not detectably
# wrong downstream — the diff still applies and still describes real code, it
# is just about a base nobody is merging into. `set -e` turns this failure
# into a non-zero exit with no stdout, which rloop classifies `unavailable`
# (`crashed`). The explicit refspec rather than the bare `git fetch origin
# main` form: the bare form does update the tracking ref, but only via git's
# opportunistic update, which needs `remote.origin.fetch` configured — not
# guaranteed in a worktree or a CI checkout.
git fetch --no-tags --quiet origin \
  "+refs/heads/${BASE_BRANCH}:refs/remotes/origin/${BASE_BRANCH}" >&2

DIFF_FILE="$(mktemp)"
# EXIT only, and SIGKILL cannot be trapped — so when rloop's `timeout_seconds`
# fires it kills the whole process group and this file survives. A real leak,
# stated rather than papered over: a timed-out 900s model call leaves up to
# MAX_BYTES in $TMPDIR.
trap 'rm -f "$DIFF_FILE"' EXIT

# Diff `$RLOOP_HEAD_SHA`, NOT `HEAD`. They are not the same thing:
# `RLOOP_HEAD_SHA` is the FORGE's PR head, and local HEAD is whatever is
# checked out — routinely divergent in an agent loop (a commit made but not
# pushed, a stale checkout, a push from elsewhere). Reviewing local HEAD while
# `inject_sha` stamps the forge's sha reports a verdict for a commit this
# review never covered.
#
# Naming the sha also fails SAFE: if it is not present locally, git errors,
# `set -e` exits non-zero, and rloop reports `unavailable` rather than
# reviewing the wrong tree.
#
# Three-dot: from the merge base, so a base branch that moved does not present
# its own new commits as reverts by this branch.
#
# `--no-ext-diff --text` is load-bearing, not tidiness. Without `--text`,
# `git diff` obeys `.gitattributes` — a file IN THE TREE UNDER REVIEW — so a
# PR that adds `* -diff` collapses every one of its own changed files to
# "Binary files a/x and b/x differ". Verified: a line adding
# `SECRET=…; eval(userInput)` was invisible without it. `--no-ext-diff` closes
# the same hole via a configured `diff.external`.
git diff --no-ext-diff --text \
  "origin/${BASE_BRANCH}...${RLOOP_HEAD_SHA}" > "$DIFF_FILE"

DIFF_BYTES=$(wc -c < "$DIFF_FILE")
echo "diff is ${DIFF_BYTES} bytes" >&2

# Property 3. If the diff cannot fit the model's context, the review would
# cover part of the change — so refuse rather than review a prefix.
#
# Keyed on WHETHER THE WHOLE DIFF WAS REVIEWED, never on what was found in it.
# rloop applies `dismiss:` after this process exits, so a finding count here
# answers a different question — see property 4 in README.md.
#
# Nothing has been written to stdout at this point, so the classification is
# `unavailable`/`crashed` (non-zero exit, no usable document) — NOT the
# `contradicted` rule, which needs a parseable document alongside the failure.
# Either way it blocks; the operator sees "ran but crashed before producing a
# usable review" plus the stderr below.
if [ "$DIFF_BYTES" -gt "$MAX_BYTES" ]; then
  echo "refusing: diff is ${DIFF_BYTES} bytes, over the ${MAX_BYTES} this reviewer can read in one pass." >&2
  echo "A partial review reported as a pass is worse than no review. Split the PR." >&2
  exit 1
fi

PROMPT=$(cat <<'PROMPT'
You are reviewing a pull request diff. Report only defects you can point at in
the diff: correctness, security, data loss, silent failure. Do not report
style, and do not restate what the change does.

Every finding needs a STABLE id: a short slug naming the DEFECT, not your
sentence about it (e.g. "unvalidated-redirect-in-login", not
"the login handler does not validate"). The same defect must produce the same
id on a later run even if you word the finding differently, because that id is
the only thing a dismissal can match on. Two findings must never share an id.

severity: "critical" (data loss, security, corruption), "important" (a bug
users will hit), "minor" (everything else). Only critical and important block
a merge.

`line` must be a single line number as a string, or "". Not a range.
Leave path/line/body as empty strings if you have nothing for them.
PROMPT
)

# The diff arrives on STDIN, never as an argument. An argv element is capped at
# MAX_ARG_STRLEN — 131072 bytes on a 4K-page Linux, about 32 pages of diff —
# and passing more fails at spawn with E2BIG, which reads like "the reviewer is
# broken" rather than "the diff is big".
#
# `--output-schema` forces a shape, and OpenAI structured outputs require every
# key in `properties` to also be in `required` — so the schema asks for all six
# fields and the `jq` below strips the empty ones. rloop's document schema is
# strict about unknown keys but treats id/path/line/body as optional, so an
# empty string left in would be a value, not an absence.
#
# ALL OR NOTHING, deliberately: one unusable `line` (a range like "12-15", or
# "0", which rloop's schema rejects as non-positive) fails the whole document
# rather than dropping that finding. Discarding one finding silently from an
# otherwise-accepted review is the worse outcome — the run blocks as
# `malformed`, which is a provider defect the operator should see.
#
# codex's stderr is NOT discarded: it is the only diagnosis of a failed model
# call, and rloop appends a provider's stderr to the `crashed`, `contradicted`
# and `malformed` details.
{
  printf '%s\n\n--- DIFF ---\n' "$PROMPT"
  cat "$DIFF_FILE"
} | codex exec --output-schema "$SCHEMA" - |
  jq -c '
    {
      findings: [
        .findings[]
        | with_entries(select(.value != "" and .value != null))
        | if has("line") then .line |= tonumber else . end
      ]
    }
  '

# No `sha` in that output, and no `jq --arg` grafting one in. The config sets
# `inject_sha: true`, so rloop supplies the sha it spawned this process with.
#
# Sound HERE because of the `git diff` line above: this provider reviews
# exactly `$RLOOP_HEAD_SHA`, or exits non-zero trying. That — not "it reads
# committed state" — is the precondition. A provider that diffs plain `HEAD`,
# or that reads the working tree, must echo the sha instead.
