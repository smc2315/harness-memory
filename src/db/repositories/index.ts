/**
 * v0.6 repositories over the tables added by migrations 018–019 (spec §4.2–§4.3).
 * Each class takes an open sql.js `Database`; all methods are synchronous and run inside whatever
 * transaction / savepoint the caller (Store.withWriteLock, reconcile) has opened.
 */

export {
  EpisodeRepository,
  episodeRecordToDescriptor,
  isCorrectionEpisode,
  mapEpisodeRow,
  type EpisodeRecord,
  type EpisodeRow,
  type LeaseOptions,
  type ListEpisodesOptions,
  type MarkFailedOptions,
} from "./episodes";
export {
  ExtractionRunRepository,
  mapRunRow,
  type CountRunsOptions,
  type ExtractionRunRecord,
  type FinishRunInput,
  type StartRunInput,
} from "./runs";
export {
  DEFAULT_PROPOSAL_DAYS,
  ProposalAlreadyOpenError,
  ProposalRepository,
  mapProposalRow,
  mapSupportRow,
  type AddSupportInput,
  type CreateProposalInput,
  type DecideProposalInput,
  type ListDecidedProposalsOptions,
  type ListOpenProposalsOptions,
  type ProposalDerivedCounts,
  type ProposalRecord,
  type ProposalSupportRecord,
} from "./proposals";
export {
  AUTO_CONFIDENCE_CAP,
  AUTO_CONFIDENCE_STEP,
  PROVENANCE_EXCERPT_MAX_CHARS,
  ProvenanceRepository,
  deriveAutoConfidence,
  mapProvenanceRow,
  recomputeDerived,
  type DerivedAggregate,
  type InsertProvenanceInput,
  type ProvenanceRecord,
  type RecomputeDerivedResult,
} from "./provenance";
export {
  TransitionRepository,
  mapTransitionRow,
  type InsertTransitionInput,
  type TransitionRecord,
} from "./transitions";
export { META_KEYS, MetaRepository } from "./meta";
export { WriteOpsRepository, mapWriteOpRow, type WriteOpRecord } from "./write-ops";
export {
  addDays,
  addSeconds,
  correctionEpisodeSql,
  laterIso,
  rowsChanged,
  selectAll,
  selectOne,
  type SqlParams,
  type SqlRow,
} from "./common";
