import { z } from 'zod';

/**
 * The document a `kind: command` provider prints on stdout.
 *
 * Strict, like every other schema here: a provider emitting a key rloop does
 * not know is a provider written against a different contract, and guessing
 * which half is right is how a blocking finding gets dropped.
 */
export const providerDocumentSchema = z
  .object({
    /** Echoed from RLOOP_HEAD_SHA. Proves the run is not cached; see the spec. */
    sha: z.string().min(7),
    findings: z
      .array(
        z
          .object({
            id: z.string().min(1).optional(),
            severity: z.enum(['critical', 'important', 'minor']),
            path: z.string().min(1).optional(),
            line: z.number().int().positive().optional(),
            title: z.string().min(1),
            body: z.string().optional(),
          })
          .strict(),
      )
      .default([]),
  })
  .strict();

export type ProviderDocument = z.infer<typeof providerDocumentSchema>;

export type ParseResult =
  | { ok: true; doc: ProviderDocument }
  | { ok: false; error: string };

/**
 * Parse and validate. Never throws — the caller turns a failure into a
 * `malformed` report, which is a verdict, not a crash.
 */
export function parseProviderDocument(text: string): ParseResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return { ok: false, error: `not valid JSON: ${(err as Error).message}` };
  }

  const parsed = providerDocumentSchema.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    return { ok: false, error: detail };
  }
  return { ok: true, doc: parsed.data };
}
