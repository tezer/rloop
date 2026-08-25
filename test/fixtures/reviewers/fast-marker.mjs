#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
const log = process.env.RLOOP_MARKER_LOG;
appendFileSync(log, 'fast-start\n');
appendFileSync(log, 'fast-end\n');
process.stdout.write(JSON.stringify({ sha: process.env.RLOOP_HEAD_SHA, findings: [] }));
