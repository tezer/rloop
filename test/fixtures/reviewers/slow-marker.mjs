#!/usr/bin/env node
// Records start/end around a deliberate delay. Paired with fast-marker.mjs to
// detect concurrent execution: run sequentially the two runs cannot interleave.
import { appendFileSync } from 'node:fs';
const log = process.env.RLOOP_MARKER_LOG;
appendFileSync(log, 'slow-start\n');
await new Promise((r) => setTimeout(r, 400));
appendFileSync(log, 'slow-end\n');
process.stdout.write(JSON.stringify({ sha: process.env.RLOOP_HEAD_SHA, findings: [] }));
