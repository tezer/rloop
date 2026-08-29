#!/usr/bin/env node
// Omits the sha echo entirely — accepted only under `inject_sha: true`.
process.stdout.write(JSON.stringify({ findings: [] }));
