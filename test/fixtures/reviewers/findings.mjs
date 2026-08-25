#!/usr/bin/env node
process.stdout.write(JSON.stringify({
  sha: process.env.RLOOP_HEAD_SHA,
  findings: [
    { severity: 'critical', path: 'src/a.ts', line: 10, title: 'Unchecked null' },
    { severity: 'minor', path: 'src/b.ts', title: 'Wording' },
  ],
}));
