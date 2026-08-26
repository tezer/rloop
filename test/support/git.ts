import { devNull } from 'node:os';

/**
 * Environment for every `git` call a test makes to build a fixture repo.
 *
 * Identity is set here because a machine without `user.email` cannot commit at
 * all. The config isolation is the part that is easy to leave out and expensive
 * to debug: without it a fixture repo inherits the developer's global gitconfig,
 * and anything in there that affects committing breaks the suite on that machine
 * only. Observed: `commit.gpgsign = true` with a signing agent that is not
 * running fails `git commit` with "failed to write commit object", taking 12
 * tests down at once and pointing at nothing.
 *
 * `GIT_CONFIG_GLOBAL`/`GIT_CONFIG_SYSTEM` at the null device is git's supported
 * way to say "no config file"; a missing or empty file reads as empty config.
 *
 * Note this is the OPPOSITE direction from `GIT_ENV_OVERRIDES` in src/git.ts,
 * which UNSETS these so a leaked value cannot redirect rloop. Both are right:
 * rloop must never inherit them, and a test must never inherit the developer's.
 * A test that deliberately sets one (git-env.test.ts) spreads its own env last
 * and still wins.
 */
export const HERMETIC_GIT_ENV: Record<string, string> = {
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@e',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@e',
  GIT_CONFIG_GLOBAL: devNull,
  GIT_CONFIG_SYSTEM: devNull,
};
