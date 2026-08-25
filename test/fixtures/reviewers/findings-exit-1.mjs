#!/usr/bin/env node
// A blocking finding AND a non-zero exit — the linter convention: many
// linters exit non-zero BECAUSE they found something. The document is
// trusted over the code, so this must classify as `findings`, not
// `unavailable`.
process.stdout.write(JSON.stringify({
  sha: process.env.RLOOP_HEAD_SHA,
  findings: [{ severity: 'critical', path: 'src/a.ts', line: 10, title: 'Unchecked null' }],
}));
process.exit(1);
