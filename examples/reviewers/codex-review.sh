#!/usr/bin/env bash
#
# A model-backed `kind: command` reviewer, end to end.
#
# Pair it with `needs_diff: true` (see ../reviewers.yaml). That is what makes
# this script short: rloop fetches the base, takes the diff from the merge
# base, caps it if you asked it to, and refuses to accept "clean" from a
# truncated one. None of that is here, because none of it can be done
# correctly from here.
#
# Written against the Codex CLI. Swapping the model is the `codex exec` line
# and the schema path; nothing else in this file is vendor-specific.

# `-e` so a failing step stops the script, `-u` so a typo'd variable is an
# error rather than an empty string, and `-o pipefail` because WITHOUT IT this
# whole file is a merge gate that passes when the model dies: the last command
# is a `jq` that exits 0 over a dead pipeline, and rloop would see exit 0 and
# a document it can parse. rloop's contract already says a non-zero exit can
# never be `clean` — pipefail is what makes the exit code true.
set -euo pipefail

# Narration goes to stderr. rloop captures the two streams separately, and
# anything on stdout that is not the JSON document corrupts it.
echo "reviewing ${RLOOP_BASE_REF}...${RLOOP_HEAD_SHA} (${RLOOP_DIFF_BYTES} bytes of diff)" >&2
if [ "${RLOOP_DIFF_TRUNCATED}" = "1" ]; then
  # Say so, but do NOT try to act on it. rloop applies the rule that matters
  # ("a truncated review may not be clean") after dismissals, which is a
  # number this script does not have. See the README.
  echo "note: rloop truncated the diff; this review covers part of the change" >&2
fi

SCHEMA="$(dirname "$0")/finding-schema.json"

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
{
  printf '%s\n\n--- DIFF ---\n' "$PROMPT"
  cat "$RLOOP_DIFF_FILE"
} | codex exec --output-schema "$SCHEMA" - 2>/dev/null |
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
# The alternative is asking a model to copy a 40-character hex string into a
# JSON field, and a model asked to copy a hex string will eventually not —
# arriving as `stale`, which sends you looking at commits instead of at this
# file.
