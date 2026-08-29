import type { ConfigWarning } from './config.js';
import type { PreflightRunResult } from './preflight.js';
import type { Degradation } from './reviewers/collect.js';
import type { ReviewerReport } from './reviewers/types.js';
import type { GateResult, GateRunResult } from './types.js';

const useColor = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const paint = (code: string, s: string) => (useColor ? `[${code}m${s}[0m` : s);
const red = (s: string) => paint('31', s);
const green = (s: string) => paint('32', s);
const yellow = (s: string) => paint('33', s);
const dim = (s: string) => paint('2', s);
const bold = (s: string) => paint('1', s);

const MARK: Record<GateResult['status'], string> = {
  pass: '✓',
  fail: '✗',
  error: '!',
  skipped: '–',
};

const TINT: Record<GateResult['status'], (s: string) => string> = {
  pass: green,
  fail: red,
  error: yellow,
  skipped: dim,
};

const secs = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

export function formatWarnings(warnings: ConfigWarning[]): string {
  if (warnings.length === 0) return '';
  return warnings
    .map((w) => `${yellow('warning')} ${w.gate ? `[${w.gate}] ` : ''}${w.message}`)
    .join('\n');
}

export function formatPreflight(result: PreflightRunResult): string {
  const lines: string[] = [];
  for (const check of result.checks) {
    const mark = check.ok ? green('✓') : red('✗');
    lines.push(`  ${mark} ${check.name}`);
    if (!check.ok) {
      lines.push(`      ${check.message}`);
      if (check.detail) lines.push(dim(`      ${check.detail}`));
    }
  }
  for (const blocker of result.blockers) {
    lines.push(`  ${red('✗')} ${blocker}`);
  }
  return lines.join('\n');
}

function formatGate(gate: GateResult): string {
  const tint = TINT[gate.status];
  const timing = gate.status === 'skipped' ? '' : dim(` ${secs(gate.durationMs)}`);
  const lines = [`  ${tint(MARK[gate.status])} ${gate.name.padEnd(14)}${timing}`];

  if (gate.status === 'pass') {
    if (gate.negativeEvidenceOnly) {
      lines.push(dim('      passed on absence of failure strings only — no positive marker'));
    }
    return lines.join('\n');
  }

  lines.push(`      ${gate.summary}`);

  // Show the offending lines. This is the difference between "retry blindly"
  // and "go fix line 412".
  const hits = gate.evidence?.forbiddenMatched.slice(0, 3) ?? [];
  for (const hit of hits) {
    lines.push(dim(`      ${String(hit.line).padStart(5)} │ ${hit.text}`));
  }
  if ((gate.evidence?.forbiddenMatched.length ?? 0) > hits.length) {
    lines.push(dim(`            … ${gate.evidence!.forbiddenMatched.length - hits.length} more`));
  }

  if (gate.exitCode === 0 && gate.reason === 'forbidden_match') {
    lines.push(
      dim('      note: this command exited 0. The exit code was wrong; the output was not.'),
    );
  }
  if (gate.logPath) lines.push(dim(`      log: ${gate.logPath}`));

  return lines.join('\n');
}

/**
 * The in-band notification.
 *
 * rloop has no channel to the operator except its own output, so this is the
 * whole notification mechanism — it must be unmissable in a scrollback and
 * must state what rloop did and did not do, rather than leaving it inferred.
 */
export function formatDegradation(d: Degradation | null): string {
  if (!d) return '';
  const who = d.provider ? ` [${d.provider}]` : '';
  return [
    '',
    '  ⚠ EXTERNAL REVIEW DEGRADED — ' + d.reason + who,
    '    ' + d.message,
    '    Gates still ran. rloop will NOT merge without an external review stream.',
    '',
  ].join('\n');
}

export function formatPrStatus(s: {
  pr: { number: number; baseRef: string; headSha: string; state: string; isDraft: boolean; title: string };
  reviews: { author: string; state: string; sha: string }[];
  threads: { isResolved: boolean }[];
  decision: { allowed: boolean; blockers: { code: string; message: string }[] };
  reviewerReports?: ReviewerReport[];
  degradation?: Degradation | null;
}): string {
  const lines: string[] = [];
  const head = s.pr.headSha.slice(0, 7);
  lines.push(bold(`PR #${s.pr.number}`) + dim(` ${s.pr.title}`));
  lines.push(
    dim(`  ${s.pr.state}${s.pr.isDraft ? ' (draft)' : ''} · → ${s.pr.baseRef} · head ${head}`),
  );
  // Pushed conditionally: `formatDegradation` returns '' when nothing is
  // degraded, and pushing that unconditionally would still land as a blank
  // array entry — doubling up with the blank line below it.
  const banner = formatDegradation(s.degradation ?? null);
  if (banner) lines.push(banner);

  for (const r of s.reviewerReports ?? []) {
    const mark = r.status === 'clean' ? '✓' : r.status === 'findings' ? '✗' : '~';
    lines.push(`  ${mark} ${r.name} (${r.kind}): ${r.status}${r.detail ? ` — ${r.detail}` : ''}`);
    for (const f of r.findings) {
      const tag = f.dismissed ? 'dismissed' : f.severity;
      lines.push(`      ${f.fingerprint}  ${tag.padEnd(9)} ${f.title}`);
    }
  }
  lines.push('');

  if (s.reviews.length === 0) {
    lines.push(dim('  reviews: none'));
  } else {
    for (const r of s.reviews) {
      const stale = r.sha !== s.pr.headSha;
      const mark = stale ? yellow('~') : r.state === 'CHANGES_REQUESTED' ? red('✗') : green('✓');
      lines.push(
        `  ${mark} ${r.author} ${dim(r.state)}${stale ? yellow(` (stale: ${r.sha.slice(0, 7)})`) : ''}`,
      );
    }
  }

  const unresolved = s.threads.filter((t) => !t.isResolved).length;
  lines.push(
    `  ${unresolved === 0 ? green('✓') : red('✗')} threads: ${s.threads.length - unresolved}/${s.threads.length} resolved`,
  );
  lines.push('');

  if (s.decision.allowed) {
    lines.push(green(bold('MERGEABLE')) + ` — every condition holds on ${head}`);
  } else {
    lines.push(red(bold('BLOCKED')) + ` — ${s.decision.blockers.length} condition(s) not met:`);
    for (const b of s.decision.blockers) {
      lines.push(`  ${red('✗')} ${dim(`[${b.code}]`)} ${b.message}`);
    }
  }
  return lines.join('\n');
}

export function formatRun(run: GateRunResult): string {
  const lines: string[] = [];
  lines.push(bold(`rloop gate`) + dim(` — ${run.sha.slice(0, 7)}`));
  lines.push('');
  for (const gate of run.gates) lines.push(formatGate(gate));
  lines.push('');

  const failed = run.gates.filter((g) => g.status === 'fail').length;
  const errored = run.gates.filter((g) => g.status === 'error').length;
  const passed = run.gates.filter((g) => g.status === 'pass').length;
  const total = run.gates.length;

  // EXHAUSTIVE over `invalidatedBy`, so a fourth member is a compile error
  // rather than a silent fall-through to PARTIAL or GREEN. `gates_skipped` was
  // added without one and landed on "PARTIAL — 0 selected gate(s) passed" —
  // the same false "--only" sentence that was fixed in merge-gate.ts and left
  // stranded here. `formatRun` is exported from src/index.ts, so a library
  // consumer can hand it any GateRunResult.
  const VOID_REASON: Record<NonNullable<GateRunResult['invalidatedBy']>, string> = {
    dirty_worktree: `worktree was dirty. These gates did not verify ${run.sha.slice(0, 7)}. Do not merge.`,
    head_moved: 'HEAD moved during the run. The verdict is not bound to any commit. Do not merge.',
    gates_skipped: 'gates were skipped. Nothing was checked, which is not the same as nothing being wrong. Do not merge.',
  };

  if (run.invalidatedBy !== null) {
    lines.push(red(bold('VOID')) + ` — ${VOID_REASON[run.invalidatedBy]}`);
  } else if (errored > 0) {
    lines.push(
      yellow(bold('UNRESOLVED')) +
        ` — ${errored} gate(s) could not run to a conclusion. Not a failure and not a pass. Do not merge.`,
    );
  } else if (failed > 0) {
    lines.push(red(bold('RED')) + ` — ${failed} of ${total} gate(s) failed. Do not merge.`);
  } else if (run.partial) {
    lines.push(
      yellow(bold('PARTIAL')) +
        ` — ${passed} selected gate(s) passed, but not every gate ran. This is not a merge verdict.`,
    );
  } else if (passed === 0) {
    lines.push(yellow(bold('EMPTY')) + ` — no gate actually ran. Nothing was proven.`);
  } else if (!run.green) {
    // `green` is computed by `runGates` and is the authoritative verdict. This
    // branch used to be absent, so the headline was re-derived from the gate
    // array alone and could print GREEN over a run whose own flag said false.
    lines.push(
      yellow(bold('UNRESOLVED')) +
        ` — gates passed but the run is not green. Do not merge.`,
    );
  } else {
    lines.push(
      green(bold('GREEN')) + ` — ${passed} gate(s) proved on ${run.sha.slice(0, 7)}` + dim(` in ${secs(run.durationMs)}`),
    );
  }

  return lines.join('\n');
}
