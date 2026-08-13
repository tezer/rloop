import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { loadConfig, type RloopConfig } from './config.js';

export const CONFIG_NAMES = ['rloop.yaml', 'rloop.yml', '.rloop.yaml', '.rloop.yml'];

export interface LocateOptions {
  configPath?: string;
  repoRoot?: string;
  startDir?: string;
  /**
   * Search upward from `startDir` when no config is given.
   *
   * Right for the CLI, where the user deliberately `cd`-ed somewhere. Wrong for
   * a server, whose cwd is chosen by the host — see `locateForServer`.
   */
  allowUpwardSearch?: boolean;
}

/** Find the config file: explicit path, else `RLOOP_CONFIG`, else upward search. */
export function findConfigPath(opts: LocateOptions = {}): string {
  const candidate = opts.configPath ?? process.env.RLOOP_CONFIG;
  if (candidate) {
    const resolved = path.resolve(candidate);
    if (!existsSync(resolved)) throw new Error(`config not found: ${resolved}`);
    return resolved;
  }

  const startDir = path.resolve(opts.startDir ?? process.cwd());

  if (opts.allowUpwardSearch === false) {
    throw new Error(
      `no config specified. Pass configPath, or set RLOOP_CONFIG when launching the server. ` +
        `Refusing to search upward from ${startDir}: in a server the working directory is chosen ` +
        `by the host, and an upward search can silently resolve to a DIFFERENT repository's ` +
        `config — which would run one project's gates with another project's markers.`,
    );
  }

  let dir = startDir;
  for (;;) {
    for (const name of CONFIG_NAMES) {
      const full = path.join(dir, name);
      if (existsSync(full)) return full;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  throw new Error(
    `no config found. Looked for ${CONFIG_NAMES.join(', ')} from ${startDir} upward. ` +
      `Set RLOOP_CONFIG or pass --config.`,
  );
}

export interface LocatedConfig {
  cfg: RloopConfig;
  configPath: string;
  repoRoot: string;
}

/** Resolve config + repo root. Repo root defaults to the config's directory. */
export async function locateConfig(opts: LocateOptions = {}): Promise<LocatedConfig> {
  const configPath = findConfigPath(opts);
  const cfg = loadConfig(await readFile(configPath, 'utf8'), configPath);
  const repoRoot = path.resolve(
    opts.repoRoot ?? process.env.RLOOP_REPO ?? path.dirname(configPath),
  );
  return { cfg, configPath, repoRoot };
}

/**
 * Resolve a project for a server request, in one of two modes.
 *
 * **Pinned** — `RLOOP_CONFIG` is set at launch. The server serves exactly that
 * project, and a request naming a different config is REFUSED rather than
 * honoured. This is what an operator wants when the server is scoped to one
 * repository: a caller cannot redirect it at another config, and since the
 * config carries the merge policy (base-branch allowlist, whether merging is
 * enabled at all), redirecting it means swapping the safety policy.
 *
 * **Multi-project** — `RLOOP_CONFIG` is unset. Each request must name its own
 * `configPath`. There is no cwd fallback, because guessing here fails silently
 * and wrongly rather than loudly.
 */
export async function locateForServer(args: {
  configPath?: string;
  repoRoot?: string;
}): Promise<LocatedConfig> {
  const pinnedConfig = process.env.RLOOP_CONFIG;

  if (pinnedConfig) {
    const pinned = path.resolve(pinnedConfig);
    if (args.configPath && path.resolve(args.configPath) !== pinned) {
      throw new Error(
        `this server is pinned to ${pinned} via RLOOP_CONFIG and will not serve ` +
          `${path.resolve(args.configPath)}. The config carries the merge policy, so redirecting ` +
          `it would swap that policy. Launch a second server for the other project, or unset ` +
          `RLOOP_CONFIG to run in multi-project mode.`,
      );
    }

    const pinnedRepo = process.env.RLOOP_REPO;
    if (args.repoRoot && pinnedRepo && path.resolve(args.repoRoot) !== path.resolve(pinnedRepo)) {
      throw new Error(
        `this server is pinned to repo ${path.resolve(pinnedRepo)} via RLOOP_REPO and will not ` +
          `serve ${path.resolve(args.repoRoot)}.`,
      );
    }

    return locateConfig({ configPath: pinned, repoRoot: pinnedRepo, allowUpwardSearch: false });
  }

  if (!args.configPath) {
    throw new Error(
      `this server runs in multi-project mode (RLOOP_CONFIG is not set), so every call must pass ` +
        `configPath — the absolute path to that project's rloop.yaml. ` +
        `Alternatively, relaunch the server with RLOOP_CONFIG set to pin it to one project.`,
    );
  }

  return locateConfig({
    configPath: args.configPath,
    repoRoot: args.repoRoot,
    allowUpwardSearch: false,
  });
}
