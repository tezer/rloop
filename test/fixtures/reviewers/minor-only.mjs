#!/usr/bin/env node
process.stdout.write(JSON.stringify({
  sha: process.env.RLOOP_HEAD_SHA,
  findings: [{ severity: 'minor', path: 'src/b.ts', title: 'Wording' }],
}));
