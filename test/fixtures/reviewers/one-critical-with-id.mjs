#!/usr/bin/env node
process.stdout.write(JSON.stringify({
  sha: process.env.RLOOP_HEAD_SHA,
  findings: [{ id: 'RULE042', severity: 'critical', path: 'src/a.ts', title: 'Unchecked null' }],
}));
