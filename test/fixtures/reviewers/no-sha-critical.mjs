#!/usr/bin/env node
process.stdout.write(JSON.stringify({
  findings: [{ severity: 'critical', path: 'src/a.ts', title: 'Unchecked null' }],
}));
