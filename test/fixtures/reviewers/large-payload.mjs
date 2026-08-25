#!/usr/bin/env node
// Regression guard for resolving on 'exit' rather than 'close' (see
// read-json.ts and exec.ts): a several-hundred-KB document, printed in one
// shot, to pin that the switch does not truncate output. A deterministic,
// checkable body — repeated filler ending in a distinctive tail — rather
// than a length assertion alone, so a truncated OR reordered stream fails
// loudly instead of merely reading "shorter than expected".
const size = 400 * 1024;
const body = 'x'.repeat(size - 'END-OF-BODY'.length) + 'END-OF-BODY';
process.stdout.write(JSON.stringify({
  sha: process.env.RLOOP_HEAD_SHA,
  findings: [{ severity: 'minor', title: 'large payload', body }],
}));
