#!/usr/bin/env node
// A provider that reviewed the WRONG commit and found something. `stale`
// must win over `findings`: these findings describe a tree that is not head.
process.stdout.write(JSON.stringify({
  sha: 'c'.repeat(40),
  findings: [{ severity: 'critical', path: 'src/a.ts', line: 3, title: 'Unchecked null' }],
}));
