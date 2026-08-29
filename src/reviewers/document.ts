import { z } from 'zod';

/**
 * The document a `kind: command` provider prints on stdout.
 *
 * Strict, like every other schema here: a provider emitting a key rloop does
 * not know is a provider written against a different contract, and guessing
 * which half is right is how a blocking finding gets dropped.
 */
const findingsSchema = z
  .array(
    z
      .object({
        /**
         * A stable identity for this finding across runs, and the ONLY thing
         * that makes `dismiss:` work against a provider whose wording moves.
         * See `fingerprint.ts`: without an `id`, identity falls back to
         * `path` + normalized `title`, which is stable for a rule-based
         * linter and is NOT stable for a model. Optional because a linter
         * with fixed rule codes genuinely does not need it; `command.ts`
         * warns when a dismissal misses and the findings carried no ids.
         */
        id: z.string().min(1).optional(),
        severity: z.enum(['critical', 'important', 'minor']),
        path: z.string().min(1).optional(),
        line: z.number().int().positive().optional(),
        title: z.string().min(1),
        body: z.string().optional(),
      })
      .strict(),
  )
  .default([]);

export const providerDocumentSchema = z
  .object({
    /** Echoed from RLOOP_HEAD_SHA. Proves the run is not cached; see the spec. */
    sha: z.string().min(7),
    findings: findingsSchema,
  })
  .strict();

/**
 * The same document with the echo dropped, for `inject_sha: true` reviewers.
 *
 * Deliberately a second schema rather than making `sha` optional in the one
 * above. Which of the two applies is a per-reviewer decision the config
 * author made explicitly, and a single permissive schema would accept a
 * missing echo from a reviewer that never opted in — turning an opt-in
 * relaxation into a silent global one.
 */
const shaOptionalDocumentSchema = z
  .object({
    sha: z.string().min(7).optional(),
    findings: findingsSchema,
  })
  .strict();

/** `sha` is null only when the reviewer set `inject_sha` and omitted it. */
export type ProviderDocument = Omit<z.infer<typeof providerDocumentSchema>, 'sha'> & {
  sha: string | null;
};

export type ParseResult =
  | { ok: true; doc: ProviderDocument }
  | { ok: false; error: string };

/**
 * Parse and validate. Never throws — the caller turns a failure into a
 * verdict, not a crash. Which verdict depends on the exit code it saw
 * alongside this result: `malformed` on a zero exit, `unavailable` on a
 * non-zero one. See the classification table in `command.ts`.
 */
export function parseProviderDocument(
  text: string,
  opts: { shaOptional?: boolean } = {},
): ParseResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return { ok: false, error: `not valid JSON: ${(err as Error).message}` };
  }

  const schema = opts.shaOptional ? shaOptionalDocumentSchema : providerDocumentSchema;
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    return { ok: false, error: detail };
  }
  return { ok: true, doc: { ...parsed.data, sha: parsed.data.sha ?? null } };
}
