#!/usr/bin/env node
// Reports what rloop handed it, as findings, so a test can assert on the
// contract rather than on this script. Deliberately reads RLOOP_DIFF_FILE
// from disk: a test that only checked the variable was set would pass with a
// path pointing at nothing.
import { readFileSync } from 'node:fs';

const findings = [];
const push = (title) => findings.push({ severity: 'minor', title });

push(`base=${process.env.RLOOP_BASE_REF ?? 'UNSET'}`);
push(`truncated=${process.env.RLOOP_DIFF_TRUNCATED ?? 'UNSET'}`);
push(`bytes=${process.env.RLOOP_DIFF_BYTES ?? 'UNSET'}`);
try {
  const diff = readFileSync(process.env.RLOOP_DIFF_FILE, 'utf8');
  push(`diff-bytes=${Buffer.byteLength(diff)}`);
  push(`mentions-added-file=${diff.includes('added-on-branch.txt')}`);
  push(`mentions-base-only-file=${diff.includes('added-on-base.txt')}`);
} catch (err) {
  push(`diff-read-failed=${err.code ?? err.message}`);
}

process.stdout.write(JSON.stringify({ sha: process.env.RLOOP_HEAD_SHA, findings }));
