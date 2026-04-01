export { ActivationEngine } from "./engine";
export { createScopeMatcher, matchesScope, normalizeScopeRef } from "./scope";
export {
  type ActivationConflict,
  type ActivationConflictKind,
  DEFAULT_ACTIVE_STATUSES,
  DEFAULT_ACTIVATION_LIMITS,
  type ActivationBudgetSummary,
  type ActivationRequest,
  type ActivationResult,
  type ActivationSuppressionKind,
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
