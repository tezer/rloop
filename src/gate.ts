import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import picomatch from 'picomatch';

import type { GateConfig, RloopConfig } from './config.js';
import { describeEvidence, evaluateEvidence } from './evidence.js';
import { runCommand } from './exec.js';
import { headSha, isDirty } from './git.js';
import type { GateResult, GateRunResult } from './types.js';

export interface RunOptions {
  /** Repo root. Gate `cwd` values resolve against this. */
  repoRoot: string;
  /**
   * Repo-relative paths in the PR diff, used to resolve `when_paths`.
   * When omitted, conditional gates RUN — an unknown diff must not silently
   * skip verification.
   */
  changedPaths?: string[];
  /**
   * Run only these gate names. Marks the result `partial`, which forces
   * `green: false` — a subset run is a development aid, never a merge verdict.
   */
  only?: string[];
  /** Called as each gate settles, for progress output. */
  onGateSettled?: (result: GateResult) => void;
}

function gateApplies(gate: GateConfig, changed: string[] | undefined): boolean {
  if (!gate.when_paths) return true;
  // Unknown diff → run it. Skipping on missing information is how a gate
  // silently stops protecting anything.
  if (changed === undefined) return true;
  const matches = picomatch(gate.when_paths);
  return changed.some((p) => matches(p));
}

async function runGate(
  gate: GateConfig,
  opts: { repoRoot: string; logDir: string },
): Promise<GateResult> {
  const logPath = path.join(opts.logDir, `${gate.name}.log`);
  const negativeEvidenceOnly = gate.require.length === 0;

  const outcome = await runCommand(gate.run, {
    cwd: path.resolve(opts.repoRoot, gate.cwd),
    timeoutMs: gate.timeout_seconds * 1000,
    env: gate.env,
  });

  await writeFile(logPath, outcome.output, 'utf8');

  const base = {
    name: gate.name,
    exitCode: outcome.exitCode,
    durationMs: outcome.durationMs,
    logPath,
    negativeEvidenceOnly,
  };

  if (outcome.spawnError) {
    return {
      ...base,
      status: 'error',
      reason: 'spawn_failed',
      summary: `${gate.name}: could not start — ${outcome.spawnError.message}`,
      evidence: null,
    };
  }

  if (outcome.timedOut) {
    return {
      ...base,
      status: 'error',
      reason: 'timeout',
      summary: `${gate.name}: killed after ${gate.timeout_seconds}s. Treated as UNRESOLVED, not skipped — inspect ${logPath}`,
      evidence: evaluateEvidence(outcome.output, gate.require, gate.forbid),
    };
  }

  const evidence = evaluateEvidence(outcome.output, gate.require, gate.forbid);

  // Evidence is checked BEFORE the exit code, so the reported reason names the
  // real cause. Under a masking runner the exit code is 0 on a broken build;
  // "forbidden pattern npm ERR! at line 412" is the useful message, not
  // "exit code 0".
  if (!evidence.satisfied) {
    return {
      ...base,
      status: 'fail',
      reason: evidence.forbiddenMatched.length > 0 ? 'forbidden_match' : 'required_missing',
      summary: describeEvidence(gate.name, evidence),
      evidence,
    };
  }

  if (gate.expect_exit !== null && outcome.exitCode !== gate.expect_exit) {
    return {
      ...base,
      status: 'fail',
      reason: 'exit_code',
      summary: `${gate.name}: markers looked clean but exit code was ${outcome.exitCode}, expected ${gate.expect_exit}`,
      evidence,
    };
  }

  return {
    ...base,
    status: 'pass',
    reason: null,
    summary: describeEvidence(gate.name, evidence),
    evidence,
  };
}

/** Names in `only` that match no configured gate — a typo, not an empty run. */
export function unknownGateNames(cfg: RloopConfig, only: string[]): string[] {
  const known = new Set(cfg.gates.map((g) => g.name));
  return only.filter((n) => !known.has(n));
}

/**
 * Run every applicable gate and bind the verdict to a single commit.
 *
 * The verdict is void — `green: false` regardless of gate outcomes — when the
 * worktree is dirty at the start or HEAD moves during the run. Both mean the
 * gates verified something other than the commit being claimed.
 */
export async function runGates(cfg: RloopConfig, opts: RunOptions): Promise<GateRunResult> {
  const startedAt = Date.now();
  const logDir = path.resolve(opts.repoRoot, cfg.log_dir);
  await mkdir(logDir, { recursive: true });

  const shaBefore = await headSha(opts.repoRoot);
  const dirty = await isDirty(opts.repoRoot);

  const selected = opts.only
    ? cfg.gates.filter((g) => opts.only!.includes(g.name))
    : cfg.gates;

  const applicable: GateConfig[] = [];
  const results: GateResult[] = [];

  for (const gate of selected) {
    if (gateApplies(gate, opts.changedPaths)) {
      applicable.push(gate);
    } else {
      const skipped: GateResult = {
        name: gate.name,
        status: 'skipped',
        reason: 'paths_unmatched',
        summary: `${gate.name}: skipped — diff touches none of ${JSON.stringify(gate.when_paths)}`,
        exitCode: null,
        durationMs: 0,
        logPath: null,
        evidence: null,
        negativeEvidenceOnly: gate.require.length === 0,
      };
      results.push(skipped);
      opts.onGateSettled?.(skipped);
    }
  }

  if (cfg.parallel_gates) {
    const settled = await Promise.all(
      applicable.map((g) =>
        runGate(g, { repoRoot: opts.repoRoot, logDir }).then((r) => {
          opts.onGateSettled?.(r);
          return r;
        }),
      ),
    );
    results.push(...settled);
  } else {
    for (const gate of applicable) {
      const result = await runGate(gate, { repoRoot: opts.repoRoot, logDir });
      results.push(result);
      opts.onGateSettled?.(result);
    }
  }

  const shaAfter = await headSha(opts.repoRoot);

  const invalidatedBy = dirty
    ? ('dirty_worktree' as const)
    : shaAfter !== shaBefore
      ? ('head_moved' as const)
      : null;

  const partial = opts.only !== undefined;
  const allPassed = results.every((r) => r.status === 'pass' || r.status === 'skipped');
  const ranSomething = results.some((r) => r.status === 'pass');

  return {
    // `green` is a MERGE verdict, so a partial run can never earn it, however
    // well the selected gates did. The CLI still exits 0 on a clean partial —
    // that is a developer signal, not a merge signal.
    green: !partial && invalidatedBy === null && allPassed && ranSomething,
    partial,
    sha: shaBefore,
    invalidatedBy,
    gates: results,
    durationMs: Date.now() - startedAt,
    logDir,
  };
}
