#!/usr/bin/env node
// No `id` on the finding: identity falls back to path + normalized title,
// which is what makes a model-backed provider undismissable across rewordings.
process.stdout.write(JSON.stringify({
  sha: process.env.RLOOP_HEAD_SHA,
  findings: [{ severity: 'critical', path: 'src/a.ts', title: 'Injection in the prompt path' }],
}));
