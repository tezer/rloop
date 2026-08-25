#!/usr/bin/env node
// Valid JSON, wrong contract: ran fine, output unusable => malformed.
process.stdout.write(JSON.stringify({ sha: process.env.RLOOP_HEAD_SHA, results: [] }));
