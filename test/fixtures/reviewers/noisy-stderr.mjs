#!/usr/bin/env node
// The case that forbids reusing exec.ts::runCommand: real tools narrate on
// stderr. Interleaved into one buffer, this document stops being parseable.
process.stderr.write('analysing 41 files...\n');
process.stdout.write(JSON.stringify({ sha: process.env.RLOOP_HEAD_SHA, findings: [] }));
process.stderr.write('done in 2.1s\n');
