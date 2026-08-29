#!/usr/bin/env node
// TWO DISTINCT defects, same file, worded identically — the expected shape from
// a model, and the reason one dismissal must not be allowed to cover both.
// Identity falls back to path + normalized title, so these share a fingerprint.
process.stdout.write(JSON.stringify({
  sha: process.env.RLOOP_HEAD_SHA,
  findings: [
    { severity: 'critical', path: 'src/a.ts', line: 10, title: 'Unchecked input' },
    { severity: 'critical', path: 'src/a.ts', line: 402, title: 'Unchecked  INPUT ' },
  ],
}));
