#!/usr/bin/env node
// The real shape of a failed model call: pages of progress narration, then the
// one line that explains it, LAST. A head-biased stderr cap keeps the noise
// and discards the diagnosis.
for (let i = 0; i < 40; i++) {
  process.stderr.write(`[codex] thinking... ${i} tokens_in=12043 tokens_out=88\n`);
}
process.stderr.write('codex: context_length_exceeded\n');
process.stdout.write(JSON.stringify({ sha: process.env.RLOOP_HEAD_SHA, findings: [] }));
process.exit(1);
