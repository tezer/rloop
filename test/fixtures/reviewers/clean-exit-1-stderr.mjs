#!/usr/bin/env node
// A usable document AND a failure — the `contradicted` path. The stderr line
// is the whole diagnosis; without it the operator gets a generic sentence.
process.stderr.write('codex: context_length_exceeded — the model never saw 60% of the diff\n');
process.stdout.write(JSON.stringify({ sha: process.env.RLOOP_HEAD_SHA, findings: [] }));
process.exit(1);
