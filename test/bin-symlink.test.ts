import { execFileSync, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * `npm install` writes every `bin` entry as a symlink into `node_modules/.bin`,
 * so the published binaries are ALWAYS invoked through one. The MCP server
 * decides whether to connect its stdio transport by asking "was I executed
 * directly?", and the obvious way to ask that (`path.resolve(argv[1]) ===
 * fileURLToPath(import.meta.url)`) answers "no" through a symlink, because
 * `path.resolve` normalizes paths without resolving links.
 *
 * The failure is silent: the process starts, connects nothing, and exits 0. An
 * MCP host reports only that the server died. It cannot be reproduced from a
 * clone, which is how it shipped as far as a packed tarball before anyone saw
 * it, so it is pinned here against the REAL built file rather than a copy of
 * the guard logic.
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const built = path.join(root, 'dist', 'mcp', 'server.js');

let dir: string;

beforeAll(() => {
  // Test the artifact users actually run. Build it if this is a fresh clone.
  if (!existsSync(built)) {
    execFileSync('npx', ['tsc', '-p', 'tsconfig.json'], { cwd: root, stdio: 'inherit' });
  }
  dir = mkdtempSync(path.join(tmpdir(), 'rloop-bin-'));
}, 120_000);

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

/** Speak just enough MCP over stdio to prove a transport is attached. */
function initializeThroughSymlink(entry: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    const done = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`no response in 15s; stdout was ${JSON.stringify(out)}`));
    }, 15_000);

    child.stdout.on('data', (c) => {
      out += String(c);
      if (out.includes('\n')) {
        clearTimeout(done);
        child.kill('SIGKILL');
        resolve(out);
      }
    });
    // Exiting without ever answering is the exact bug this guards.
    child.on('exit', (code) => {
      clearTimeout(done);
      if (!out) reject(new Error(`server exited (code ${code}) without answering`));
    });
    child.on('error', reject);

    child.stdin.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'symlink-probe', version: '1.0.0' },
        },
      }) + '\n',
    );
  });
}

describe('published binary', () => {
  it('connects stdio when launched through a node_modules/.bin symlink', async () => {
    const link = path.join(dir, 'rloop-mcp');
    symlinkSync(built, link);

    const out = await initializeThroughSymlink(link);

    const reply = JSON.parse(out.split('\n')[0]);
    expect(reply.id).toBe(1);
    expect(reply.result.serverInfo.name).toBeTruthy();
  }, 30_000);

  it('still connects when launched by its real path', async () => {
    const out = await initializeThroughSymlink(built);
    expect(JSON.parse(out.split('\n')[0]).id).toBe(1);
  }, 30_000);
});

describe('reported version', () => {
  it('matches package.json, so a host never shows a stale one', async () => {
    const pkg = createRequire(import.meta.url)('../package.json');
    const out = await initializeThroughSymlink(built);
    expect(JSON.parse(out.split('\n')[0]).result.serverInfo.version).toBe(pkg.version);
  }, 30_000);
});
