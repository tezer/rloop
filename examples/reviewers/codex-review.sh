#!/usr/bin/env bash
#
# A model-backed `kind: command` reviewer, end to end.
#
# READ ./README.md FIRST. rloop sets exactly one variable (`RLOOP_HEAD_SHA`)
# and owns none of the five safety properties a provider needs; the fetch, the
# merge base, and the "I only reviewed part of it" exit code are all handled
# here, and getting any of them wrong produces a confident, well-formed, wrong
# verdict that rloop cannot detect.
#
# Written against the Codex CLI. Swapping the model is the `codex exec` line
# and the schema path; nothing else in this file is vendor-specific.

# `-e` so a failing step stops the script, `-u` so a typo'd variable is an
# error rather than an empty string, and `-o pipefail` for the specific case
# in README.md: a producer that prints a usable document AND fails. Without
# pipefail that combination exits 0, and rloop — seeing a parseable document
# and a clean exit — reports `clean`.
set -euo pipefail

BASE_BRANCH="${RLOOP_BASE_BRANCH:-main}"
SCHEMA="$(dirname "$0")/finding-schema.json"

# Narration goes to stderr. rloop captures the two streams separately, and
# anything on stdout that is not the JSON document corrupts it.
echo "reviewing ${BASE_BRANCH}...${RLOOP_HEAD_SHA}" >&2

# FATAL, deliberately. A tracking ref that was not updated is not detectably
# wrong downstream — the diff still applies and still describes real code, it
# is just about a base nobody is merging into. `set -e` turns this failure
# into a non-zero exit, which rloop classifies as `unavailable`. The explicit
# refspec rather than the bare `git fetch origin main` form: the bare form
# does update the tracking ref, but only via git's opportunistic update, which
# needs `remote.origin.fetch` configured — not guaranteed in a worktree or a
# CI checkout.
git fetch --no-tags --quiet origin \
  "+refs/heads/${BASE_BRANCH}:refs/remotes/origin/${BASE_BRANCH}" >&2

DIFF_FILE="$(mktemp)"
trap 'rm -f "$DIFF_FILE"' EXIT

# Three-dot: from the merge base, so a base branch that moved does not present
# its own new commits as reverts by this branch.
#
# `--no-ext-diff --text` is load-bearing, not tidiness. Without `--text`,
# `git diff` obeys `.gitattributes` — a file IN THE TREE UNDER REVIEW — so a
# PR that adds `* -diff` collapses every one of its own changed files to
# "Binary files a/x and b/x differ". Verified: a line adding
# `SECRET=…; eval(userInput)` is invisible without it. `--no-ext-diff` closes
# the same hole via a configured `diff.external`.
git diff --no-ext-diff --text "origin/${BASE_BRANCH}...HEAD" > "$DIFF_FILE"

DIFF_BYTES=$(wc -c < "$DIFF_FILE")
echo "diff is ${DIFF_BYTES} bytes" >&2

# Property 3. If the diff cannot fit the model's context, the review would
# cover part of the change — so refuse rather than review a prefix. Exiting
# non-zero with no blocking findings is what rloop classifies as
# `unavailable`, and it blocks.
#
# Keyed on WHETHER THE WHOLE DIFF WAS REVIEWED, never on what was found in it.
# rloop applies `dismiss:` after this process exits, so a finding count here
# is a number about a different question — see property 4 in README.md.
MAX_BYTES="${RLOOP_MAX_DIFF_BYTES:-400000}"
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
the only thing a dismissal can match on.

severity: "critical" (data loss, security, corruption), "important" (a bug
users will hit), "minor" (everything else). Only critical and important block
a merge.

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
# codex's stderr is NOT discarded: it is the only diagnosis of a failed model
# call, and rloop surfaces a provider's stderr in the blocker message.
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
# Sound HERE specifically because this provider reviews committed state (the
# diff above) and never reads the working tree. A provider that reads the tree
# should echo the sha instead — see the main README.
