#!/usr/bin/env node
// Two colliding id-less findings AND a failing exit: reaches the
// `contradicted` early return with dismissal notes outstanding.
process.stdout.write(JSON.stringify({
  sha: process.env.RLOOP_HEAD_SHA,
  findings: [
    { severity: 'minor', path: 'src/a.ts', title: 'Wording' },
    { severity: 'minor', path: 'src/a.ts', title: 'wording' },
  ],
}));
process.exit(1);
