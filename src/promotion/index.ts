// v0.6 promotion: the status state machine and TTL/revalidation math. The v0.5 auto-promoter
// (runAutoPromotionCycle / demoteOnContradiction) was retired; tiering is decided by decideTier
// (authority.ts, Phase A3) and applied through transitionMemory.
// authority.ts duplicates baseTtlDays/addDays on purpose (pure module, no A2 dependency); the
// barrel exports the revalidate.ts copies of those two names.
export {
  ACTIVATION_MIN_CONFIDENCE,
  ACTIVATION_MIN_EVIDENCE,
  decideTier,
  enforcementDefault,
  isReachableTrigger,
  type DecideTierInput,
  type DecideTierMemory,
  type EnforcementDefaultInput,
  type TierDecision,
  type TierReason,
} from "./authority";
export {
  TRANSITION_EDGES,
  defaultStatusReason,
  findTransitionEdge,
  isActorBoundByAuthority,
  isAllowedTransition,
  transitionMemory,
  type TransitionContext,
  type TransitionEdge,
  type TransitionInput,
} from "./transitions";
export {
  CORRECTION_TTL_DAYS,
  FIRE_TTL_EXTENSION_DAYS,
  TTL_BASE_DAYS,
  TTL_MAX_DAYS,
  baseTtlDays,
  computeRevalidation,
  extendTtlOnFire,
  revalidateMemory,
  trustMultiplier,
  ttlDays,
  type ExtendTtlOnFireOptions,
  type RevalidateOptions,
  type RevalidateResult,
  type RevalidateSkipReason,
  type RevalidationPlan,
} from "./revalidate";
