#!/usr/bin/env node
// A well-formed document reporting NOTHING blocking, paired with a non-zero
// exit. The provider's own signals contradict each other — this must
// classify as `unavailable`, never `clean`.
process.stdout.write(JSON.stringify({ sha: process.env.RLOOP_HEAD_SHA, findings: [] }));
process.exit(1);
