import { z } from 'zod';
import { parse as parseYaml } from 'yaml';

/**
 * A single verification gate.
 *
 * The core premise: an exit code is a BELT, not the proof. Some toolchains
 * mask a failing child's non-zero exit (npm 9 does this for any package that
 * is a WORKSPACE MEMBER — the `--workspace` flag is not the trigger, and
 * `cd`-ing into the package does not escape it: it prints `npm ERR!` and
 * returns 0), so a naive `cmd && echo OK` prints OK over a broken build.
 * See test/npm-masking.test.ts for the measured matrix. The proof of green is
 * therefore OUTPUT: positive end-of-run success markers, plus negative guards
 * for failure strings that print even when the exit code lies.
 */
const gateSchema = z
  .object({
    /** Unique, stable identifier. Appears in results and log filenames. */
    name: z
      .string()
      .min(1)
      .regex(/^[a-zA-Z0-9._-]+$/, 'name must be filename-safe: [a-zA-Z0-9._-]'),

    /** Shell command. Run via `bash -c` from `cwd`. */
    run: z.string().min(1),

    /**
     * Patterns that MUST each match at least one output line. These are the
     * load-bearing proof. Choose a marker the tool prints only at the very END
     * of a fully successful run — `next build` logs "Compiled successfully"
     * after webpack but before type-check and prerender, so the real marker is
     * the closing route table (`^Route \(`).
     */
    require: z.array(z.string()).default([]),

    /** Patterns that must match NOTHING. Backstop for the masked-exit case. */
    forbid: z.array(z.string()).default([]),

    /**
     * Run only when the PR diff touches at least one of these globs.
     * Omit to always run. An empty array is rejected — it reads like
     * "run always" but would mean "never run".
     */
    when_paths: z.array(z.string().min(1)).min(1).optional(),

    /** Working directory, relative to the config file. */
    cwd: z.string().default('.'),

    /**
     * Hard wall-clock cap. On expiry the process tree is killed and the gate
     * is `error`, never `skipped` — an unrunnable gate is surfaced, not waved
     * through. (A testcontainers image pull that hangs is the motivating case.)
     */
    timeout_seconds: z.number().int().positive().max(21_600).default(1800),

    /**
     * Additionally require this exit code. Kept on by default: where exit
     * codes ARE propagated it adds strictness, and where they are masked it
     * simply never fires. It can only make a gate redder, never greener.
     */
    expect_exit: z.number().int().nullable().default(0),

    env: z.record(z.string()).default({}),
  })
  .strict()
  .superRefine((gate, ctx) => {
    if (gate.require.length === 0 && gate.forbid.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          `gate "${gate.name}" has neither "require" nor "forbid" patterns, so it ` +
          `proves nothing and would pass on exit code alone — the exact shape ` +
          `this tool exists to prevent. Add at least one marker.`,
      });
    }
  });

const mergeSchema = z
  .object({
    /**
     * Merging is OPT-IN. The default posture is dry-run: evaluate everything,
     * report the verdict, change nothing.
     */
    enabled: z.boolean().default(false),

    /**
     * ALLOWLIST of base branches this tool may ever merge into. Never a
     * denylist — a branch nobody remembered to add stays protected by default.
     * Must be non-empty when `enabled` is true.
     */
    allowed_base_branches: z.array(z.string().min(1)).default([]),

    method: z.enum(['squash', 'merge', 'rebase']).default('squash'),
    delete_branch: z.boolean().default(true),

    /** Require zero unresolved review threads before merging. */
    require_threads_resolved: z.boolean().default(true),

    /**
     * External reviewer logins whose verdict must be present and clean, bound
     * to the same head SHA (e.g. `copilot-pull-request-reviewer`). A missing
     * verdict is NEVER treated as clean.
     */
    required_reviewers: z.array(z.string().min(1)).default([]),

    /**
     * What a required reviewer must actually have SAID.
     *
     * This exists because "a review exists" and "the reviewer approved" are
     * different facts, and conflating them was a real hole. GitHub review
     * states are APPROVED, CHANGES_REQUESTED and COMMENTED — and a bot that
     * files findings as inline comments submits COMMENTED whether it found
     * nothing or found ten things. GitHub Copilot never submits APPROVED at
     * all. So a gate that blocks only on CHANGES_REQUESTED is really checking
     * "did the reviewer turn up", which is a weaker claim than it reads as.
     *
     * - `approved` — only APPROVED clears the gate. Correct for humans and any
     *   reviewer that actually approves. Makes a comment-only bot permanently
     *   blocking, which is why it cannot be the universal default.
     * - `any_verdict` — APPROVED or COMMENTED clears it; CHANGES_REQUESTED
     *   still blocks. Correct ONLY when the reviewer's findings arrive as
     *   review threads and `require_threads_resolved` is what actually gates
     *   them. Understand what that leans on: thread resolution is usually
     *   performed by the same agent being gated, so this setting delegates the
     *   real check to a party with an interest in the answer.
     *
     * No default, deliberately. With `merge.enabled` the choice decides what
     * "the reviewer was happy" means, and inheriting that silently is the
     * mistake this field was added to prevent.
     */
    required_reviewer_state: z.enum(['approved', 'any_verdict']).optional(),

    /** Bound on polling for those verdicts before giving up and surfacing. */
    reviewer_timeout_seconds: z.number().int().positive().default(600),
  })
  .strict()
  .superRefine((merge, ctx) => {
    if (merge.enabled && merge.allowed_base_branches.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'merge.enabled is true but merge.allowed_base_branches is empty. ' +
          'List every branch that may be merged into, explicitly.',
      });
    }
    if (
      merge.enabled &&
      merge.required_reviewers.length > 0 &&
      merge.required_reviewer_state === undefined
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'merge.enabled is true with required_reviewers but no ' +
          'merge.required_reviewer_state. Say which verdicts count: "approved" ' +
          '(only an APPROVED review clears the gate) or "any_verdict" (APPROVED ' +
          'or COMMENTED clears it, CHANGES_REQUESTED still blocks — for bots ' +
          'like Copilot that never approve and file findings as threads, where ' +
          'require_threads_resolved is the real gate). There is no safe default: ' +
          'one of them blocks a comment-only bot forever, the other accepts a ' +
          'review that raised findings.',
      });
    }
  });

const forgeSchema = z
  .object({
    provider: z.literal('github').default('github'),
    /** `owner/name`. */
    slug: z
      .string()
      .regex(/^[^/\s]+\/[^/\s]+$/, 'slug must be "owner/name"'),
  })
  .strict();

/** A cheap environment check that must pass before any gate is attempted. */
const preflightSchema = z
  .object({
    name: z.string().min(1),
    run: z.string().min(1),
    /** Shown verbatim when the check fails. Say what is broken and why it matters. */
    message: z.string().min(1),
    timeout_seconds: z.number().int().positive().max(600).default(60),
  })
  .strict();

export const configSchema = z
  .object({
    version: z.literal(1),
    forge: forgeSchema.optional(),

    /**
     * Refuse to commit or merge unless the local git identity matches.
     * Guards against an unattended loop authoring under the wrong name.
     */
    committer: z
      .object({ name: z.string().min(1), email: z.string().min(1) })
      .strict()
      .optional(),

    preflight: z.array(preflightSchema).default([]),
    gates: z.array(gateSchema).min(1),
    merge: mergeSchema.default({}),

    /**
     * Gates run sequentially by default and you should keep it that way:
     * concurrent runs sharing a container runtime, a port, or a test database
     * produce spurious greens. Opt in only when every gate is provably
     * isolated.
     */
    parallel_gates: z.boolean().default(false),

    /** Where captured logs are written. Created if absent. */
    log_dir: z.string().default('.rloop/logs'),
  })
  .strict()
  .superRefine((cfg, ctx) => {
    const seen = new Set<string>();
    for (const gate of cfg.gates) {
      if (seen.has(gate.name)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `duplicate gate name "${gate.name}" — names must be unique (they key the log files)`,
        });
      }
      seen.add(gate.name);
    }
  });

export type RloopConfig = z.infer<typeof configSchema>;
export type GateConfig = RloopConfig['gates'][number];

/** Non-fatal findings worth printing. A config can be valid and still risky. */
export interface ConfigWarning {
  gate?: string;
  message: string;
}

export function collectWarnings(cfg: RloopConfig): ConfigWarning[] {
  const warnings: ConfigWarning[] = [];

  for (const gate of cfg.gates) {
    if (gate.require.length === 0) {
      warnings.push({
        gate: gate.name,
        message:
          'no "require" patterns: this gate passes on the ABSENCE of failure strings alone. ' +
          'Valid for tools that print nothing on success (tsc -b), but any new failure ' +
          'mode this tool has not seen will read as green. Add a positive marker if one exists.',
      });
    }
  }

  if (cfg.parallel_gates) {
    warnings.push({
      message:
        'parallel_gates is enabled: gates sharing a container runtime, port, or test ' +
        'database can green each other spuriously. Confirm every gate is isolated.',
    });
  }

  if (cfg.merge.enabled && cfg.merge.required_reviewers.length === 0) {
    warnings.push({
      message:
        'merge.enabled is true with no required_reviewers: local gates are the only ' +
        'thing standing between a generated PR and the base branch.',
    });
  }

  return warnings;
}

/** Parse and validate YAML config text. Throws with a readable message. */
export function loadConfig(yamlText: string, sourcePath = '<config>'): RloopConfig {
  let raw: unknown;
  try {
    raw = parseYaml(yamlText);
  } catch (err) {
    throw new Error(`${sourcePath}: YAML parse error — ${(err as Error).message}`);
  }

  const parsed = configSchema.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`${sourcePath}: invalid config\n${detail}`);
  }
  return parsed.data;
}
