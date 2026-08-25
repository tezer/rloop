#!/usr/bin/env node
import { spawn } from 'node:child_process';

// Background something WITHOUT redirecting its stdio: the grandchild
// inherits this process's stdout/stderr, which are the very pipes
// readProviderJson reads from. A real-world provider that shells out to
// `some-tool &` and forgets `>/dev/null` produces exactly this shape — a
// process that outlives the provider itself and keeps the pipe's write end
// open. `.unref()` so this process's own event loop does not wait on it,
// letting it exit immediately like the fast, well-behaved provider it is
// pretending to be.
spawn('sleep', ['2'], { stdio: 'inherit' }).unref();

process.stdout.write(JSON.stringify({ sha: process.env.RLOOP_HEAD_SHA, findings: [] }));
