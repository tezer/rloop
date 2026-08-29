#!/usr/bin/env node
// An id-less finding whose title is far past the 60-char cap the id-less
// dismissal note applies — nothing else exercises `truncate`'s second arg.
process.stdout.write(JSON.stringify({
  sha: process.env.RLOOP_HEAD_SHA,
  findings: [{ severity: 'critical', path: 'src/a.ts', title: 'T'.repeat(500) }],
}));
