import type { Tier2GroundTruthLabel } from "./tier2.types";

export const TIER2_GROUND_TRUTH: readonly Tier2GroundTruthLabel[] = [
  {
    queryId: "q-first-turn-01",
    relevantMemoryIds: ["web-app-01", "cli-tool-01"],
    forbiddenMemoryIds: [],
    rationale:
      "TypeScript configuration guidance is explicitly documented in web-app and cli-tool strict-mode policies.",
  },
  {
    queryId: "q-first-turn-02",
    relevantMemoryIds: ["web-app-06", "cli-tool-18"],
    forbiddenMemoryIds: [],
    rationale:
      "Test framework choice is directly covered by web-app's Vitest workflow and cli-tool's Vitest-over-Jest decision.",
  },
  {
    queryId: "q-first-turn-03",
    relevantMemoryIds: ["web-app-09", "web-app-10", "cli-tool-06"],
    forbiddenMemoryIds: [],
    rationale:
      "Deployment conventions are concretely captured in preview deployment, migration-before-deploy, and provenance publish workflows.",
  },
  {
    queryId: "q-first-turn-04",
    relevantMemoryIds: ["web-app-21", "cli-tool-21", "ai-ml-18"],
    forbiddenMemoryIds: [],
    rationale:
      "Each domain defines a specific database access/storage pattern that directly answers broad DB pattern questions.",
  },
  {
    queryId: "q-first-turn-05",
    relevantMemoryIds: ["web-app-22", "cli-tool-05", "ai-ml-20"],
    forbiddenMemoryIds: [],
    rationale:
      "Error handling is represented by centralized API errors, deterministic exit codes, and retry-with-backoff architecture.",
  },
  {
    queryId: "q-first-turn-06",
    relevantMemoryIds: ["web-app-11", "cli-tool-11", "ai-ml-11", "ai-ml-14"],
    forbiddenMemoryIds: [],
    rationale:
      "These are concrete high-impact pitfalls from each domain that a developer would want surfaced early.",
  },
  {
    queryId: "q-first-turn-07",
    relevantMemoryIds: ["web-app-16", "web-app-02"],
    forbiddenMemoryIds: [],
    rationale:
      "Styling approach is only defined in web-app via Tailwind decision and no-inline-style policy.",
  },
  {
    queryId: "q-first-turn-08",
    relevantMemoryIds: ["web-app-17", "web-app-21", "web-app-22"],
    forbiddenMemoryIds: [],
    rationale:
      "API endpoint structure is governed by web-app REST design plus repository and centralized error constraints.",
  },
  {
    queryId: "q-first-turn-09",
    relevantMemoryIds: ["ai-ml-04", "ai-ml-16", "ai-ml-23"],
    forbiddenMemoryIds: [],
    rationale:
      "Embedding configuration questions require dimension validation, chosen embedding model, and reindex workflow context.",
  },
  {
    queryId: "q-first-turn-10",
    relevantMemoryIds: ["cli-tool-06", "cli-tool-07", "cli-tool-10"],
    forbiddenMemoryIds: [],
    rationale:
      "Version publishing is explicitly documented only in cli-tool release and publish workflows.",
  },
  {
    queryId: "q-first-turn-11",
    relevantMemoryIds: ["web-app-01", "cli-tool-01", "ai-ml-04"],
    forbiddenMemoryIds: [],
    rationale:
      "A broad project setup question is best answered by high-signal baseline configuration memories across domains.",
  },
  {
    queryId: "q-first-turn-12",
    relevantMemoryIds: ["web-app-06", "cli-tool-09", "ai-ml-06", "ai-ml-08"],
    forbiddenMemoryIds: [],
    rationale:
      "How tests are run is covered by explicit execution workflows in all three domains.",
  },

  {
    queryId: "q-cross-language-01",
    relevantMemoryIds: ["web-app-01", "cli-tool-01"],
    forbiddenMemoryIds: [],
    rationale:
      "The Korean query asks for TypeScript setup, and the relevant guidance lives in English strict-mode memories.",
  },
  {
    queryId: "q-cross-language-02",
    relevantMemoryIds: ["web-app-22", "cli-tool-05", "ai-ml-20"],
    forbiddenMemoryIds: [],
    rationale:
      "Error handling patterns are explicitly documented in English across all domains.",
  },
  {
    queryId: "q-cross-language-03",
    relevantMemoryIds: ["web-app-09", "cli-tool-06", "web-app-10"],
    forbiddenMemoryIds: [],
    rationale:
      "Deployment method in Korean should retrieve the English deployment/publish workflows that define actual process.",
  },
  {
    queryId: "q-cross-language-04",
    relevantMemoryIds: ["web-app-21", "cli-tool-21", "ai-ml-18"],
    forbiddenMemoryIds: [],
    rationale:
      "Database access approach is represented by English memories that describe per-domain storage boundaries.",
  },
  {
    queryId: "q-cross-language-05",
    relevantMemoryIds: ["web-app-23"],
    forbiddenMemoryIds: [],
    rationale:
      "Component naming conventions are specifically covered by the Korean PascalCase naming policy.",
  },
  {
    queryId: "q-cross-language-06",
    relevantMemoryIds: ["web-app-24"],
    forbiddenMemoryIds: [],
    rationale:
      "The environment-variable deployment note is directly captured by the Korean Supabase Edge Function workflow.",
  },
  {
    queryId: "q-cross-language-07",
    relevantMemoryIds: ["cli-tool-23"],
    forbiddenMemoryIds: [],
    rationale:
      "Build artifact output location is explicitly documented in the Korean dist-only policy.",
  },
  {
    queryId: "q-cross-language-08",
    relevantMemoryIds: ["ai-ml-23"],
    forbiddenMemoryIds: [],
    rationale:
      "Embedding model reindexing is exactly the Korean full-reindex workflow memory.",
  },

  {
    queryId: "q-scoped-01",
    relevantMemoryIds: ["web-app-01"],
    forbiddenMemoryIds: ["cli-tool-01"],
    rationale:
      "Within a web-app component scope, only web strict TypeScript policy is relevant while cli strict config is a near-neighbor from the wrong domain.",
  },
  {
    queryId: "q-scoped-02",
    relevantMemoryIds: ["web-app-22"],
    forbiddenMemoryIds: ["cli-tool-05", "ai-ml-20"],
    rationale:
      "For a web API route file, centralized web error handling applies and non-web error memories should be excluded.",
  },
  {
    queryId: "q-scoped-03",
    relevantMemoryIds: ["web-app-09", "web-app-10"],
    forbiddenMemoryIds: ["cli-tool-06"],
    rationale:
      "In web middleware scope, web deployment conventions are relevant while CLI publish workflow is a topical but wrong-domain neighbor.",
  },
  {
    queryId: "q-scoped-04",
    relevantMemoryIds: ["web-app-21"],
    forbiddenMemoryIds: ["cli-tool-21", "ai-ml-18"],
    rationale:
      "A web repository-layer question should return the web repository constraint, not CLI migration or AI storage decisions.",
  },
  {
    queryId: "q-scoped-05",
    relevantMemoryIds: ["cli-tool-06", "cli-tool-07", "cli-tool-10"],
    forbiddenMemoryIds: ["web-app-09"],
    rationale:
      "Release publishing in a cli-tool file maps to cli release workflow memories, not web preview deployment conventions.",
  },
  {
    queryId: "q-scoped-06",
    relevantMemoryIds: ["cli-tool-21"],
    forbiddenMemoryIds: ["web-app-21", "ai-ml-18"],
    rationale:
      "CLI migration rules are SQL-file architecture constraints and should exclude similarly themed DB memories from other domains.",
  },
  {
    queryId: "q-scoped-07",
    relevantMemoryIds: ["ai-ml-18"],
    forbiddenMemoryIds: ["web-app-21", "cli-tool-21"],
    rationale:
      "In ai-ml embeddings scope, the relevant database pattern is SQLite BLOB storage, not web repository or CLI migration access patterns.",
  },
  {
    queryId: "q-scoped-08",
    relevantMemoryIds: ["ai-ml-20", "ai-ml-19"],
    forbiddenMemoryIds: ["web-app-22", "cli-tool-05"],
    rationale:
      "AI inference stream scope needs AI retry/backoff and streaming decisions while other domains' error conventions are near-neighbors only.",
  },

  {
    queryId: "q-negative-01",
    relevantMemoryIds: [],
    forbiddenMemoryIds: [],
    rationale:
      "The corpus has no AWS Lambda-specific deployment memory, so no memory should be treated as relevant.",
  },
  {
    queryId: "q-negative-02",
    relevantMemoryIds: [],
    forbiddenMemoryIds: [],
    rationale:
      "The dataset states REST preference but does not define any GraphQL schema details to retrieve.",
  },
  {
    queryId: "q-negative-03",
    relevantMemoryIds: [],
    forbiddenMemoryIds: [],
    rationale:
      "There are no Ruby on Rails memories in this corpus, so relevance should be empty.",
  },
  {
    queryId: "q-negative-04",
    relevantMemoryIds: [],
    forbiddenMemoryIds: [],
    rationale:
      "No iOS or Swift UI constraints are represented in any project domain memories.",
  },

  {
    queryId: "q-ambiguous-01",
    relevantMemoryIds: ["web-app-01", "cli-tool-01"],
    forbiddenMemoryIds: [],
    rationale:
      "With broad scope, strict TypeScript guidance legitimately comes from both web-app and cli-tool domains.",
  },
  {
    queryId: "q-ambiguous-02",
    relevantMemoryIds: ["web-app-06", "cli-tool-18", "ai-ml-08"],
    forbiddenMemoryIds: [],
    rationale:
      "Testing strategy is intentionally multi-domain and should include each domain's core testing approach.",
  },
  {
    queryId: "q-ambiguous-03",
    relevantMemoryIds: ["web-app-21", "cli-tool-21", "ai-ml-18"],
    forbiddenMemoryIds: [],
    rationale:
      "Database access patterns are domain-specific but all relevant when the query is unscoped and broad.",
  },
  {
    queryId: "q-ambiguous-04",
    relevantMemoryIds: ["web-app-22", "cli-tool-05", "ai-ml-20"],
    forbiddenMemoryIds: [],
    rationale:
      "Error handling best practices span multiple domains and should surface all major domain-level error strategies.",
  },
];
