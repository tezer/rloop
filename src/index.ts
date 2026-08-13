export { configSchema, loadConfig, collectWarnings } from './config.js';
export type { RloopConfig, GateConfig, ConfigWarning } from './config.js';

export { evaluateEvidence, describeEvidence, MAX_EVIDENCE_CHARS } from './evidence.js';
export { runGates, unknownGateNames } from './gate.js';
export type { RunOptions } from './gate.js';
export { runCommand } from './exec.js';
export type { CommandOutcome, CommandOptions } from './exec.js';
export { runPreflight } from './preflight.js';
export type { PreflightResult, PreflightRunResult } from './preflight.js';
export { formatRun, formatPreflight, formatPrStatus, formatWarnings } from './report.js';
export { headSha, isDirty, changedPaths } from './git.js';

export { GitHubForge } from './forge/github.js';
export { matchesReviewer, normalizeLogin } from './forge/types.js';
export type {
  Forge,
  MergeOptions,
  PullRequest,
  ReviewState,
  ReviewThread,
  ReviewVerdict,
} from './forge/types.js';

export { evaluateMergeGate } from './merge-gate.js';
export type { Blocker, BlockerCode, MergeDecision, MergeGateInput } from './merge-gate.js';

export { replyAndResolve, unresolvedThreads } from './threads.js';
export type { ReplyAndResolveResult } from './threads.js';

export { forgeFor, mergeIfAllowed, prStatus, requestReviewerVerified } from './pr.js';
export type { PrStatus } from './pr.js';

export type {
  EvidenceResult,
  GateResult,
  GateRunResult,
  GateStatus,
  MarkerMatch,
} from './types.js';
