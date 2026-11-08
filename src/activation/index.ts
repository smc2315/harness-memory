export { ActivationEngine } from "./engine";
export { createScopeMatcher, matchesScope, normalizeScopeRef } from "./scope";
export {
  type ActivationConflict,
  type ActivationConflictKind,
  type ActivationMode,
  DEFAULT_ACTIVE_STATUSES,
  DEFAULT_ACTIVATION_LIMITS,
  type ActivationBudgetSummary,
  type ActivationRequest,
  type ActivationResult,
  type ActivationSuppressionKind,
  type MemoryReader,
  type RankedMemory,
  type SuppressedMemory,
} from "./types";
export { LexicalIndex, type LexicalDocument, type LexicalSearchResult } from "./lexical";
export {
  EmbeddingService,
  cosineSimilarity,
  findTopK,
  EMBEDDING_DIMENSIONS,
} from "./embeddings";
export { rrfFusion, RRF_K } from "./fusion";
export type { FusionCandidate, RetrievalSource } from "./fusion";

// v0.6 snapshot read path (hooks import these files directly, never this barrel: `scope.ts` pulls minimatch).
export {
  LEXICAL_SNAPSHOT_FIELDS,
  LEXICAL_TOKENIZER_ID,
  codeAwareTokenize,
  lexicalDefaultOptions,
  lexicalOptionsFor,
  lexicalSnapshotOptions,
  normalizeLexicalScore,
  snapshotTokenize,
  stripHangulParticles,
  toLexicalDocument,
  type LexicalSnapshotDocument,
} from "./lexical-snapshot";
export {
  REINDEX_THROTTLE_MS,
  compileSnapshotRegexes,
  defaultSpawnWorker,
  isActiveSnapshot,
  isSnapshotStale,
  readActiveSnapshot,
  readLexicalSnapshot,
  requestReindex,
  resolveWorkerScript,
  scopeMatches,
  type LexicalHit,
  type LexicalSearcher,
  type LoadedSnapshot,
  type ReadSnapshotOptions,
  type SpawnWorkerFn,
} from "./snapshot-reader";
export {
  applyBudget,
  isHostLoadedFile,
  isTtlExpired,
  itemFromSnapshotMemory,
  renderItemText,
  renderReason,
  renderSystemMessage,
  stripControlCharacters,
  type BudgetedInjection,
  type InjectedItem,
  type InjectionSource,
} from "./injection";
export { compareSnapshotMemories, freshnessMultiplier, snapshotMemoryScore, trustMultiplier } from "./scoring";
export {
  BEFORE_TOOL_TYPE_QUOTAS,
  NON_INTERACTIVE_PERMISSION_MODES,
  SIGNATURELESS_BEFORE_TOOL_TYPES,
  compareBeforeToolItems,
  decideBeforeTool,
  type BeforeToolDecision,
  type BeforeToolInput,
  type BeforeToolSuppression,
  type BeforeToolSuppressionKind,
  type DecideBeforeToolParams,
  type FiredPayload,
} from "./before-tool";
export {
  DENSE_HIT_THRESHOLD,
  activateBeforeModel,
  type BeforeModelParams,
  type BeforeModelResult,
  type BeforeModelSuppression,
  type DenseClient,
  type DenseHits,
} from "./before-model";
export {
  SESSION_START_TYPES,
  buildDigestMessage,
  isSessionStartRow,
  selectSessionStartItems,
  type SessionStartParams,
  type SessionStartResult,
} from "./session-start";
export { selectAfterToolHints, type AfterToolParams, type AfterToolResult } from "./after-tool";
export {
  CANONICAL_CACHE_SIZE,
  canonicalCommandFor,
  canonicalizeCommand,
  checkSpecificity,
  compileGlobSource,
  compileSignature,
  compileSignatureKey,
  globMatchesPath,
  globRegexFlags,
  globToRegExp,
  matchSignature,
  matchSignatureKey,
  parseSignatureKey,
  primaryProgramToken,
  signatureKey,
  type CanonicalCommand,
  type CompileSignatureResult,
} from "./signature";
export {
  canonicalizeHostTool,
  extractScopeRefs,
  pickTarget,
  relativizeToRoot,
  toolGlobFamilies,
  toolGlobMatches,
  type HostToolCanonicalization,
  type PickTargetOptions,
  type PickedTarget,
} from "./tool-vocabulary";
