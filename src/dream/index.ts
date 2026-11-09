// v0.6 write path: ledger lines → episodes → extraction (providers, prompt, schema, validate) → reconcile →
// consolidate, driven by the detached worker (implementation-plan.md §3–§4, Phases A3/B1).
// Hooks never import this barrel (it reaches sql.js-backed repositories); they import src/dream/ledger.ts
// and src/dream/episode.ts directly so the hook bundle stays free of the database.
export * from "./ledger";
export * from "./episode";
export * from "./extract/schema";
export * from "./extract/prompt";
export * from "./extract/validate";
export * from "./extract/providers";
export * from "./reconcile";
export * from "./consolidate";
export * from "./worker";
export * from "./legacy-reader";
