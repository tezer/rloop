import { createHash } from 'node:crypto';

/**
 * Stable identity for a finding across runs.
 *
 * NEVER incorporates the line number. An edit anywhere above a finding moves
 * it, and an identity that changes on every unrelated edit would report each
 * finding as new and each fixed one as gone — destroying the only mechanism
 * local findings have for reaching zero.
 *
 * Eight hex characters is 32 bits. Collisions are a concern at millions of
 * items; a review produces tens. Short enough to type into a `dismiss` entry.
 */
export function fingerprint(input: {
  id?: string | null;
  path?: string | null;
  title: string;
}): string {
  // The domain tag keeps the two bases in separate spaces. Without it, the
  // real hazard isn't "an id can equal a path" -- those differ by construction
  // anyway. It's an id that CONTAINS the NUL separator used below: with the
  // tag removed, an id of 'src/a.ts' + NUL + 'x' (String.fromCharCode(0))
  // would concatenate to the same string as { path: 'src/a.ts', title: 'x' }
  // and hash identically.
  const basis = input.id
    ? `id\u0000${input.id}`
    : `pt\u0000${input.path ?? ''}\u0000${normalizeTitle(input.title)}`;

  return createHash('sha256').update(basis, 'utf8').digest('hex').slice(0, 8);
}

/** Case- and whitespace-insensitive, so a rewrap or re-case is the same finding. */
function normalizeTitle(title: string): string {
  return title.trim().replace(/\s+/g, ' ').toLowerCase();
}
