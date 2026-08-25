#!/usr/bin/env node
// Schema-invalid output AND a non-zero exit. Pins the precedence: the exit
// code wins, so this is `unavailable` (the provider says it failed), not
// `malformed` (which means "claimed success, output unusable").
process.stdout.write(JSON.stringify({ sha: process.env.RLOOP_HEAD_SHA, results: [] }));
process.exit(1);
