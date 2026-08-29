#!/usr/bin/env node
// Exit 0 with junk on stdout — `malformed` — while stderr carries the cause.
process.stderr.write('codex: auth token expired\n');
process.stdout.write('not json at all');
