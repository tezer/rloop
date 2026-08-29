#!/usr/bin/env node
// The model managed an id for the minor finding and dropped it for the
// critical one — so a warning keyed on "no finding has an id" goes quiet
// about the finding that actually matters.
process.stdout.write(JSON.stringify({
  sha: process.env.RLOOP_HEAD_SHA,
  findings: [
    { id: 'RULE042', severity: 'minor', path: 'src/b.ts', title: 'Wording' },
    { severity: 'critical', path: 'src/a.ts', title: 'Unchecked input' },
  ],
}));
