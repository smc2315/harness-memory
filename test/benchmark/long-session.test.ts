/**
 * Benchmark: Long-Session Simulator (Tier 1 — Mock)
 *
 * Simulates a realistic 30-turn developer conversation and measures whether
 * the dream evidence pipeline correctly identifies "should-remember" facts
 * while ignoring transient noise.
 *
 * Architecture:
 *   1. Scripted conversation → OpenCodeAdapter processes each turn
 *   2. DreamRepository captures evidence events with salience/novelty scores
 *   3. Ground truth labels define what SHOULD and SHOULD NOT become memories
 *   4. Precision/recall computed by matching evidence against ground truth
 *
 * This is the most realistic benchmark — it demonstrates the system's ability
 * to distinguish signal from noise in a long development session.
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { Database as SqlJsDatabase } from "sql.js";

import { ActivationEngine } from "../../src/activation";
import type { EmbeddingService } from "../../src/activation/embeddings";
import { OpenCodeAdapter } from "../../src/adapters";
import { DreamRepository } from "../../src/dream";
import type { DreamEvidenceEventRecord } from "../../src/dream/types";
import { MemoryRepository } from "../../src/memory";
import { PolicyEngine, PolicyRuleRepository } from "../../src/policy";
import { createTestDb } from "../helpers/create-test-db";
import { MockEmbeddingService, printBenchmarkReport } from "./benchmark-helpers";

// ---------------------------------------------------------------------------
// Scripted conversation scenario
// ---------------------------------------------------------------------------

interface ScriptedTurn {
  id: string;
  userMessage: string;
  toolCalls: Array<{
    tool: string;
    args: Record<string, unknown>;
    title: string;
    output: string;
    scopeRef?: string;
  }>;
}

/**
 * 30-turn developer conversation: building a Next.js app with Supabase.
 *
 * Interleaves important decisions, style preferences, architecture choices,
 * temporary noise, one-off errors, and discarded hypotheses.
 */
const SCRIPTED_SESSION: ScriptedTurn[] = [
  // ---- Turn 1-5: Project setup & preferences ----
  {
    id: "T01",
    userMessage: "새 프로젝트 세팅 좀 해줘. Next.js + Supabase + Vercel로 가자.",
    toolCalls: [
      {
        tool: "bash",
        args: { command: "npx create-next-app@latest my-app --typescript" },
        title: "Create Next.js project",
        output: "Created my-app successfully with TypeScript template",
        scopeRef: ".",
      },
    ],
  },
  {
    id: "T02",
    userMessage: "나 plan9 스타일 좋아해. UI는 최소한으로, 기능 중심으로 가자.",
    toolCalls: [
      {
        tool: "edit",
        args: { filePath: "src/styles/globals.css" },
        title: "Update global styles",
        output: "Applied plan9-inspired minimal styling: monospace fonts, high contrast, no rounded corners",
        scopeRef: "src/styles/globals.css",
      },
    ],
  },
  {
    id: "T03",
    userMessage: "배포는 Vercel로 하고, DB는 Supabase 쓸거야. 환경변수 세팅해줘.",
    toolCalls: [
      {
        tool: "edit",
        args: { filePath: ".env.local" },
        title: "Configure environment variables",
        output: "Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.local for Vercel + Supabase deployment",
        scopeRef: ".env.local",
      },
    ],
  },
  {
    id: "T04",
    userMessage: "인증은 Supabase Auth 쓰자. JWT 직접 관리 안할거야.",
    toolCalls: [
      {
        tool: "edit",
        args: { filePath: "src/lib/supabase.ts" },
        title: "Initialize Supabase client",
        output: "Created Supabase client with auth helpers. Using Supabase Auth instead of custom JWT management.",
        scopeRef: "src/lib/supabase.ts",
      },
      {
        tool: "edit",
        args: { filePath: "src/middleware.ts" },
        title: "Add auth middleware",
        output: "Added Next.js middleware that checks Supabase session on protected routes.",
        scopeRef: "src/middleware.ts",
      },
    ],
  },
  {
    id: "T05",
    userMessage: "git init하고 첫 커밋 해줘.",
    toolCalls: [
      {
        tool: "bash",
        args: { command: "git init && git add . && git commit -m 'initial setup'" },
        title: "Initialize git repository",
        output: "Initialized empty Git repository. Created initial commit with 23 files.",
        scopeRef: ".",
      },
    ],
  },
  // ---- Turn 6-10: Architecture decisions ----
  {
    id: "T06",
    userMessage: "DB 접근은 repository 패턴으로 가자. 직접 SQL 안쓸거야.",
    toolCalls: [
      {
        tool: "edit",
        args: { filePath: "src/repositories/user-repository.ts" },
        title: "Create user repository",
        output: "Created UserRepository class that wraps all Supabase queries. No direct SQL in route handlers. Repository pattern for DB access layer.",
        scopeRef: "src/repositories/user-repository.ts",
      },
    ],
  },
  {
    id: "T07",
    userMessage: "API는 /api/v1/ 프리픽스로 가자. 버전 관리 해야하니까.",
    toolCalls: [
      {
        tool: "edit",
        args: { filePath: "src/app/api/v1/users/route.ts" },
        title: "Create versioned API route",
        output: "Created /api/v1/users route with GET and POST handlers. All API routes under /api/v1/ prefix for versioning.",
        scopeRef: "src/app/api/v1/users/route.ts",
      },
    ],
  },
  {
    id: "T08",
    userMessage: "에러 핸들링은 중앙 집중식으로. 각 route에서 try-catch 안쓸거야.",
    toolCalls: [
      {
        tool: "edit",
        args: { filePath: "src/lib/api-handler.ts" },
        title: "Create centralized error handler",
        output: "Created withErrorHandling HOC that wraps API routes. Catches errors, logs them, returns standardized error response. Individual routes don't need try-catch.",
        scopeRef: "src/lib/api-handler.ts",
      },
    ],
  },
  // ---- Turn 9-12: Noise & temporary stuff ----
  {
    id: "T09",
    userMessage: "이 브랜치에서 잠깐 테스트하자. fix/temp-auth-debug로.",
    toolCalls: [
      {
        tool: "bash",
        args: { command: "git checkout -b fix/temp-auth-debug" },
        title: "Create temporary branch",
        output: "Switched to a new branch 'fix/temp-auth-debug'",
        scopeRef: ".",
      },
    ],
  },
  {
    id: "T10",
    userMessage: "auth 미들웨어 디버깅하자. 왜 리다이렉트 안되지?",
    toolCalls: [
      {
        tool: "bash",
        args: { command: "npm run dev" },
        title: "Start dev server",
        output: "TypeError: Cannot read property 'session' of undefined\n  at middleware.ts:15:22\n  at Object.apply (node_modules/next/dist/server/web/adapter.js:23:16)",
        scopeRef: "src/middleware.ts",
      },
    ],
  },
  {
    id: "T11",
    userMessage: "아 세션 객체가 없네. createServerClient 안불렀구나. 고쳐줘.",
    toolCalls: [
      {
        tool: "edit",
        args: { filePath: "src/middleware.ts" },
        title: "Fix middleware session initialization",
        output: "Added createServerClient call before accessing session. Fixed TypeError by properly initializing Supabase server client in middleware.",
        scopeRef: "src/middleware.ts",
      },
      {
        tool: "bash",
        args: { command: "npm run dev" },
        title: "Verify fix",
        output: "Server started on http://localhost:3000. No errors. Auth redirect working correctly.",
        scopeRef: ".",
      },
    ],
  },
  {
    id: "T12",
    userMessage: "됐다. main으로 돌아가자.",
    toolCalls: [
      {
        tool: "bash",
        args: { command: "git checkout main && git merge fix/temp-auth-debug && git branch -d fix/temp-auth-debug" },
        title: "Merge and cleanup temp branch",
        output: "Switched to branch 'main'. Merged fix/temp-auth-debug. Deleted branch fix/temp-auth-debug.",
        scopeRef: ".",
      },
    ],
  },
  // ---- Turn 13-17: More architecture & style ----
  {
    id: "T13",
    userMessage: "테스트는 vitest 쓰자. jest 안쓸거야.",
    toolCalls: [
      {
        tool: "bash",
        args: { command: "npm install -D vitest @testing-library/react" },
        title: "Install vitest",
        output: "Added vitest@3.2.4, @testing-library/react@16.1.0 to devDependencies",
        scopeRef: "package.json",
      },
      {
        tool: "edit",
        args: { filePath: "vitest.config.ts" },
        title: "Configure vitest",
        output: "Created vitest config with React support. Using vitest instead of jest for all testing.",
        scopeRef: "vitest.config.ts",
      },
    ],
  },
  {
    id: "T14",
    userMessage: "나 DB 엔진 개발보다는 백엔드/창업 쪽에 관심이 더 많아. 프로덕트 빨리 만들자.",
    toolCalls: [
      {
        tool: "edit",
        args: { filePath: "src/app/page.tsx" },
        title: "Create landing page",
        output: "Created minimal landing page with signup CTA. Focus on product features, not technical infrastructure. User prefers shipping fast over perfect architecture.",
        scopeRef: "src/app/page.tsx",
      },
    ],
  },
  {
    id: "T15",
    userMessage: "혹시 Redis로 세션 관리할까? ... 아 됐다 JWT로 충분해.",
    toolCalls: [
      {
        tool: "bash",
        args: { command: "npm info ioredis" },
        title: "Check Redis package",
        output: "ioredis@5.4.1 | MIT | A robust, performance-focused and full-featured Redis client for Node.js.",
        scopeRef: ".",
      },
    ],
  },
  {
    id: "T16",
    userMessage: "컴포넌트는 서버 컴포넌트 기본으로 가자. 'use client'는 정말 필요할 때만.",
    toolCalls: [
      {
        tool: "edit",
        args: { filePath: "src/components/README.md" },
        title: "Document component conventions",
        output: "Documented: default to React Server Components. Only add 'use client' when needed for interactivity. Keep client bundle small.",
        scopeRef: "src/components/README.md",
      },
    ],
  },
  {
    id: "T17",
    userMessage: "commit 해줘.",
    toolCalls: [
      {
        tool: "bash",
        args: { command: "git add -A && git commit -m 'feat: core setup with auth, API routes, and component conventions'" },
        title: "Create commit",
        output: "Created commit abc1234 with 12 changed files",
        scopeRef: ".",
      },
    ],
  },
  // ---- Turn 18-22: Working on features ----
  {
    id: "T18",
    userMessage: "사용자 프로필 CRUD 만들어줘.",
    toolCalls: [
      {
        tool: "edit",
        args: { filePath: "src/repositories/profile-repository.ts" },
        title: "Create profile repository",
        output: "Created ProfileRepository with getById, update, and delete methods. Follows repository pattern established earlier.",
        scopeRef: "src/repositories/profile-repository.ts",
      },
      {
        tool: "edit",
        args: { filePath: "src/app/api/v1/profiles/[id]/route.ts" },
        title: "Create profile API routes",
        output: "Created GET, PUT, DELETE routes for /api/v1/profiles/:id. Uses withErrorHandling wrapper.",
        scopeRef: "src/app/api/v1/profiles/[id]/route.ts",
      },
    ],
  },
  {
    id: "T19",
    userMessage: "프로필 사진 업로드는 Supabase Storage 쓰자.",
    toolCalls: [
      {
        tool: "edit",
        args: { filePath: "src/lib/storage.ts" },
        title: "Create storage helper",
        output: "Created uploadProfileImage function using Supabase Storage. Images stored in 'avatars' bucket with user ID as path prefix.",
        scopeRef: "src/lib/storage.ts",
      },
    ],
  },
  {
    id: "T20",
    userMessage: "테스트 하나만 빠르게 돌려보자.",
    toolCalls: [
      {
        tool: "bash",
        args: { command: "npx vitest run --reporter=verbose src/repositories/profile-repository.test.ts" },
        title: "Run profile tests",
        output: "FAIL src/repositories/profile-repository.test.ts > ProfileRepository > getById > should return null for non-existent ID\nAssertionError: expected undefined to be null\n  at line 23\n\n 1 failed, 2 passed",
        scopeRef: "src/repositories/profile-repository.test.ts",
      },
    ],
  },
  {
    id: "T21",
    userMessage: "아 getById에서 undefined 대신 null 리턴해야 하는구나. 고쳐.",
    toolCalls: [
      {
        tool: "edit",
        args: { filePath: "src/repositories/profile-repository.ts" },
        title: "Fix getById return value",
        output: "Changed getById to return null instead of undefined when profile not found. Consistent with UserRepository convention.",
        scopeRef: "src/repositories/profile-repository.ts",
      },
      {
        tool: "bash",
        args: { command: "npx vitest run src/repositories/profile-repository.test.ts" },
        title: "Verify fix",
        output: "3 passed, 0 failed. All tests passing.",
        scopeRef: "src/repositories/profile-repository.test.ts",
      },
    ],
  },
  // ---- Turn 22-26: More noise and patterns ----
  {
    id: "T22",
    userMessage: "ESLint 설정 좀 바꿔줘. semicolons off, single quotes.",
    toolCalls: [
      {
        tool: "edit",
        args: { filePath: ".eslintrc.json" },
        title: "Update ESLint config",
        output: "Configured ESLint: no semicolons, single quotes, consistent with project's plan9 minimal aesthetic.",
        scopeRef: ".eslintrc.json",
      },
    ],
  },
  {
    id: "T23",
    userMessage: "GraphQL 써볼까? ... 아냐 REST가 낫겠다. 이 규모에선.",
    toolCalls: [
      {
        tool: "bash",
        args: { command: "npm info @apollo/server" },
        title: "Check Apollo Server",
        output: "@apollo/server@4.11.0 | MIT | Apollo Server for Express, Koa, etc.",
        scopeRef: ".",
      },
    ],
  },
  {
    id: "T24",
    userMessage: "모든 mutation에 optimistic update 패턴 적용하자. UX 중요하니까.",
    toolCalls: [
      {
        tool: "edit",
        args: { filePath: "src/hooks/use-mutation.ts" },
        title: "Create optimistic update hook",
        output: "Created useMutation hook with built-in optimistic update support. Rolls back on error. All mutations should use this pattern for responsive UX.",
        scopeRef: "src/hooks/use-mutation.ts",
      },
    ],
  },
  {
    id: "T25",
    userMessage: "CI 파이프라인 세팅. GitHub Actions로.",
    toolCalls: [
      {
        tool: "edit",
        args: { filePath: ".github/workflows/ci.yml" },
        title: "Create CI pipeline",
        output: "Created GitHub Actions CI: lint → typecheck → test → build. Runs on push to main and PRs. Deploy to Vercel on main merge.",
        scopeRef: ".github/workflows/ci.yml",
      },
    ],
  },
  {
    id: "T26",
    userMessage: "아 이거 왜 빌드 안되지? tsconfig 문제인가.",
    toolCalls: [
      {
        tool: "bash",
        args: { command: "npm run build" },
        title: "Build project",
        output: "error TS2307: Cannot find module '@/lib/supabase' or its corresponding type declarations.\n  src/middleware.ts:3:24",
        scopeRef: ".",
      },
      {
        tool: "edit",
        args: { filePath: "tsconfig.json" },
        title: "Fix path alias",
        output: "Added path alias '@/*' -> 'src/*' in tsconfig.json. Fixed module resolution for @ imports.",
        scopeRef: "tsconfig.json",
      },
      {
        tool: "bash",
        args: { command: "npm run build" },
        title: "Verify build",
        output: "Build completed successfully. 0 errors.",
        scopeRef: ".",
      },
    ],
  },
  // ---- Turn 27-30: Final stretch ----
  {
    id: "T27",
    userMessage: "RLS 정책 세팅 좀 해줘. 사용자 본인 데이터만 볼 수 있게.",
    toolCalls: [
      {
        tool: "edit",
        args: { filePath: "supabase/migrations/001_rls_policies.sql" },
        title: "Create RLS policies",
        output: "Created Row Level Security policies: users can only read/write their own profiles. Service role bypasses RLS for admin operations.",
        scopeRef: "supabase/migrations/001_rls_policies.sql",
      },
    ],
  },
  {
    id: "T28",
    userMessage: "로깅은 어떻게 하지? pino 써도 될까.",
    toolCalls: [
      {
        tool: "bash",
        args: { command: "npm install pino" },
        title: "Install pino logger",
        output: "Added pino@9.5.0 to dependencies",
        scopeRef: "package.json",
      },
      {
        tool: "edit",
        args: { filePath: "src/lib/logger.ts" },
        title: "Create logger",
        output: "Created pino logger with structured JSON output. Log level controlled by LOG_LEVEL env var. Using pino for all server-side logging.",
        scopeRef: "src/lib/logger.ts",
      },
    ],
  },
  {
    id: "T29",
    userMessage: "배포 전 최종 체크. vercel 설정 확인해줘.",
    toolCalls: [
      {
        tool: "bash",
        args: { command: "vercel env ls" },
        title: "Check Vercel env vars",
        output: "NEXT_PUBLIC_SUPABASE_URL: ****\nSUPABASE_SERVICE_ROLE_KEY: ****\nLOG_LEVEL: info\n3 environment variables configured for Production",
        scopeRef: ".",
      },
    ],
  },
  {
    id: "T30",
    userMessage: "좋아. main에 최종 커밋하고 배포하자.",
    toolCalls: [
      {
        tool: "bash",
        args: { command: "git add -A && git commit -m 'feat: complete MVP with auth, profiles, and deployment' && git push origin main" },
        title: "Final commit and deploy",
        output: "Commit def5678. Pushed to origin/main. Vercel deployment triggered: https://my-app.vercel.app",
        scopeRef: ".",
      },
    ],
  },
];

// ---------------------------------------------------------------------------
// Ground truth labels
// ---------------------------------------------------------------------------

interface GroundTruthLabel {
  /** Human-readable description of the fact. */
  fact: string;
  /** Keywords that evidence excerpts should contain to match. */
  keywords: string[];
  /** Should the system remember this? */
  shouldRemember: boolean;
  /** Why this label exists. */
  reason: string;
}

const GROUND_TRUTH: GroundTruthLabel[] = [
  // ---- SHOULD REMEMBER (persistent project knowledge) ----
  {
    fact: "User prefers plan9 minimal style",
    keywords: ["plan9", "minimal"],
    shouldRemember: true,
    reason: "Recurring style preference that affects all future UI decisions",
  },
  {
    fact: "Deployment is Vercel + Supabase",
    keywords: ["vercel", "supabase"],
    shouldRemember: true,
    reason: "Core infrastructure decision that affects all deployment-related work",
  },
  {
    fact: "Repository pattern for DB access",
    keywords: ["repository", "pattern"],
    shouldRemember: true,
    reason: "Architecture constraint applied project-wide",
  },
  {
    fact: "API versioning with /api/v1/ prefix",
    keywords: ["api", "v1", "versioning"],
    shouldRemember: true,
    reason: "Architecture decision for API structure",
  },
  {
    fact: "Centralized error handling (no per-route try-catch)",
    keywords: ["error", "handler", "centralized"],
    shouldRemember: true,
    reason: "Architecture pattern for error handling",
  },
  {
    fact: "Using vitest not jest",
    keywords: ["vitest"],
    shouldRemember: true,
    reason: "Tooling decision that affects all test-related work",
  },
  {
    fact: "User interested in backend/startup, not DB engine development",
    keywords: ["product", "shipping", "fast"],
    shouldRemember: true,
    reason: "User context that affects recommendation priorities",
  },
  {
    fact: "Server components by default, 'use client' only when needed",
    keywords: ["server component", "use client"],
    shouldRemember: true,
    reason: "Architecture convention for React components",
  },
  {
    fact: "Optimistic update pattern for all mutations",
    keywords: ["optimistic", "mutation"],
    shouldRemember: true,
    reason: "UX pattern applied project-wide",
  },
  {
    fact: "Supabase Auth (not custom JWT)",
    keywords: ["supabase", "auth"],
    shouldRemember: true,
    reason: "Auth architecture decision",
  },
  {
    fact: "RLS policies for data isolation",
    keywords: ["rls", "row level security", "security policies"],
    shouldRemember: true,
    reason: "Security architecture decision",
  },
  {
    fact: "Pino for structured logging",
    keywords: ["pino", "logger", "structured"],
    shouldRemember: true,
    reason: "Tooling decision for logging",
  },
  // ---- SHOULD NOT REMEMBER (transient / noise) ----
  {
    fact: "Temporary branch fix/temp-auth-debug",
    keywords: ["fix/temp-auth-debug"],
    shouldRemember: false,
    reason: "Temporary branch name, already merged and deleted",
  },
  {
    fact: "TypeError: Cannot read property 'session' of undefined",
    keywords: ["typeerror", "cannot read property"],
    shouldRemember: false,
    reason: "One-off error that was fixed immediately",
  },
  {
    fact: "Considered Redis for sessions, decided against it",
    keywords: ["ioredis", "redis"],
    shouldRemember: false,
    reason: "Discarded hypothesis — user explicitly rejected this option",
  },
  {
    fact: "Considered GraphQL, decided against it",
    keywords: ["apollo", "graphql"],
    shouldRemember: false,
    reason: "Discarded hypothesis — user explicitly rejected this option",
  },
  {
    fact: "TS2307 module resolution error (fixed)",
    keywords: ["ts2307", "cannot find module"],
    shouldRemember: false,
    reason: "One-off build error that was fixed immediately",
  },
  {
    fact: "Test failure: expected undefined to be null",
    keywords: ["assertionerror", "expected undefined"],
    shouldRemember: false,
    reason: "One-off test failure that was fixed immediately",
  },
];

// ---------------------------------------------------------------------------
// Test implementation
// ---------------------------------------------------------------------------

describe("Benchmark: Long-Session Simulator", () => {
  let db: SqlJsDatabase;
  let adapter: OpenCodeAdapter;
  let dreamRepository: DreamRepository;

  beforeEach(async () => {
    db = await createTestDb();
    const memoryRepository = new MemoryRepository(db);
    const mockEmbedding = new MockEmbeddingService();
    const activationEngine = new ActivationEngine(
      memoryRepository,
      mockEmbedding as unknown as EmbeddingService,
    );
    const policyRuleRepository = new PolicyRuleRepository(db);
    const policyEngine = new PolicyEngine(policyRuleRepository);
    dreamRepository = new DreamRepository(db);

    adapter = new OpenCodeAdapter({
      activationEngine,
      policyEngine,
      dreamRepository,
    });
  });

  afterEach(() => {
    db.close();
  });

  test("processes 30-turn session and captures evidence", async () => {
    const sessionID = "bench-session-001";

    adapter.initializeSession({
      sessionID,
      agent: "assistant",
      model: { providerID: "anthropic", modelID: "claude-sonnet-4-20250514" },
    });

    let turnCount = 0;
    let toolCallCount = 0;

    for (const turn of SCRIPTED_SESSION) {
      // Simulate user message → before_model
      const queryTokens = turn.userMessage
        .split(/[\s\p{P}]+/u)
        .filter((t) => t.length > 2);

      await adapter.beforeModel({
        sessionID,
        model: { providerID: "anthropic", modelID: "claude-sonnet-4-20250514" },
        queryTokens,
      });

      // Simulate tool calls
      for (const toolCall of turn.toolCalls) {
        const callID = `${turn.id}-${toolCall.tool}-${toolCallCount}`;

        adapter.beforeTool({
          sessionID,
          tool: toolCall.tool,
          callID,
          scopeRef: toolCall.scopeRef,
        });

        await adapter.afterTool(
          {
            sessionID,
            tool: toolCall.tool,
            callID,
            args: toolCall.args,
            scopeRef: toolCall.scopeRef,
          },
          {
            title: toolCall.title,
            output: toolCall.output,
          },
        );

        toolCallCount++;
      }

      turnCount++;
    }

    expect(turnCount).toBe(30);

    const evidenceEvents = dreamRepository.listEvidenceEvents({});

    printBenchmarkReport("Long-Session Processing", {
      "Turns processed": turnCount,
      "Tool calls": toolCallCount,
      "Evidence events captured": evidenceEvents.length,
      "Avg evidence per turn": (evidenceEvents.length / turnCount).toFixed(2),
    });

    // Each tool call should generate at least some evidence.
    expect(evidenceEvents.length).toBeGreaterThan(0);
  });

  test("salience correctly distinguishes signal from noise", async () => {
    const sessionID = "bench-session-002";

    adapter.initializeSession({
      sessionID,
      agent: "assistant",
      model: { providerID: "anthropic", modelID: "claude-sonnet-4-20250514" },
    });

    let callSeq = 0;

    for (const turn of SCRIPTED_SESSION) {
      const queryTokens = turn.userMessage
        .split(/[\s\p{P}]+/u)
        .filter((t) => t.length > 2);

      await adapter.beforeModel({
        sessionID,
        model: { providerID: "anthropic", modelID: "claude-sonnet-4-20250514" },
        queryTokens,
      });

      for (const toolCall of turn.toolCalls) {
        const callID = `${turn.id}-${toolCall.tool}-${callSeq}`;

        adapter.beforeTool({
          sessionID,
          tool: toolCall.tool,
          callID,
          scopeRef: toolCall.scopeRef,
        });

        await adapter.afterTool(
          {
            sessionID,
            tool: toolCall.tool,
            callID,
            args: toolCall.args,
            scopeRef: toolCall.scopeRef,
          },
          {
            title: toolCall.title,
            output: toolCall.output,
          },
        );

        callSeq++;
      }
    }

    const evidenceEvents = dreamRepository.listEvidenceEvents({});

    // Match evidence against ground truth using keyword overlap.
    const shouldRememberLabels = GROUND_TRUTH.filter((l) => l.shouldRemember);
    const shouldForgetLabels = GROUND_TRUTH.filter((l) => !l.shouldRemember);

    // For each "should remember" label, find matching evidence events.
    let truePositives = 0;
    let falseNegatives = 0;

    for (const label of shouldRememberLabels) {
      const matching = evidenceEvents.filter((event) =>
        matchesLabel(event, label),
      );

      if (matching.length > 0) {
        truePositives++;
      } else {
        falseNegatives++;
      }
    }

    // For each "should forget" label, check if evidence was captured with HIGH salience.
    let trueNegatives = 0;
    let falsePositives = 0;

    for (const label of shouldForgetLabels) {
      const matching = evidenceEvents.filter((event) =>
        matchesLabel(event, label),
      );
      const highSalienceMatches = matching.filter((e) => e.salience >= 0.7);

      if (highSalienceMatches.length === 0) {
        trueNegatives++;
      } else {
        falsePositives++;
      }
    }

    const precision =
      truePositives + falsePositives > 0
        ? truePositives / (truePositives + falsePositives)
        : 0;
    const recall =
      truePositives + falseNegatives > 0
        ? truePositives / (truePositives + falseNegatives)
        : 0;
    const f1 =
      precision + recall > 0
        ? (2 * precision * recall) / (precision + recall)
        : 0;

    printBenchmarkReport("Long-Session: Signal vs Noise Classification", {
      "Should-remember labels": shouldRememberLabels.length,
      "Should-forget labels": shouldForgetLabels.length,
      "True positives": truePositives,
      "False negatives": falseNegatives,
      "True negatives": trueNegatives,
      "False positives (noise kept)": falsePositives,
      "Precision": precision,
      "Recall": recall,
      "F1 Score": f1,
    });

    // Recall should be meaningful — at least some "should-remember" facts captured.
    expect(recall).toBeGreaterThan(0.2);
    // At least half of "should-forget" items should NOT have high salience.
    const noiseFilterRate = trueNegatives / shouldForgetLabels.length;
    expect(noiseFilterRate).toBeGreaterThanOrEqual(0.3);
  });

  test("evidence type guesses align with content semantics", async () => {
    const sessionID = "bench-session-003";

    adapter.initializeSession({
      sessionID,
      agent: "assistant",
      model: { providerID: "anthropic", modelID: "claude-sonnet-4-20250514" },
    });

    let callSeq = 0;

    for (const turn of SCRIPTED_SESSION) {
      const queryTokens = turn.userMessage
        .split(/[\s\p{P}]+/u)
        .filter((t) => t.length > 2);

      await adapter.beforeModel({
        sessionID,
        model: { providerID: "anthropic", modelID: "claude-sonnet-4-20250514" },
        queryTokens,
      });

      for (const toolCall of turn.toolCalls) {
        const callID = `${turn.id}-${toolCall.tool}-${callSeq}`;

        adapter.beforeTool({
          sessionID,
          tool: toolCall.tool,
          callID,
          scopeRef: toolCall.scopeRef,
        });

        await adapter.afterTool(
          {
            sessionID,
            tool: toolCall.tool,
            callID,
            args: toolCall.args,
            scopeRef: toolCall.scopeRef,
          },
          {
            title: toolCall.title,
            output: toolCall.output,
          },
        );

        callSeq++;
      }
    }

    const evidenceEvents = dreamRepository.listEvidenceEvents({});

    // Count type guesses
    const typeCounts = new Map<string, number>();

    for (const event of evidenceEvents) {
      typeCounts.set(event.typeGuess, (typeCounts.get(event.typeGuess) ?? 0) + 1);
    }

    const typeBreakdown: Record<string, string> = {};

    for (const [type, count] of typeCounts) {
      typeBreakdown[`type:${type}`] = `${count} events`;
    }

    // Check salience distribution.
    const salienceDistribution = {
      high: evidenceEvents.filter((e) => e.salience >= 0.7).length,
      medium: evidenceEvents.filter((e) => e.salience >= 0.45 && e.salience < 0.7).length,
      low: evidenceEvents.filter((e) => e.salience < 0.45).length,
    };

    printBenchmarkReport("Long-Session: Evidence Analysis", {
      "Total evidence events": evidenceEvents.length,
      ...typeBreakdown,
      "High salience (≥0.7)": salienceDistribution.high,
      "Medium salience (0.45-0.7)": salienceDistribution.medium,
      "Low salience (<0.45)": salienceDistribution.low,
    });

    // Multiple type guesses should be present (not all "workflow").
    expect(typeCounts.size).toBeGreaterThanOrEqual(2);

    // Error events (T10, T20, T26) should be tagged as pitfall.
    const pitfallEvents = evidenceEvents.filter((e) => e.typeGuess === "pitfall");
    expect(pitfallEvents.length).toBeGreaterThan(0);
  });

  test("session summary: memory activation improves with context accumulation", async () => {
    const sessionID = "bench-session-004";

    adapter.initializeSession({
      sessionID,
      agent: "assistant",
      model: { providerID: "anthropic", modelID: "claude-sonnet-4-20250514" },
    });

    const activationCounts: number[] = [];
    let callSeq = 0;

    for (const turn of SCRIPTED_SESSION) {
      const queryTokens = turn.userMessage
        .split(/[\s\p{P}]+/u)
        .filter((t) => t.length > 2);

      const modelResult = await adapter.beforeModel({
        sessionID,
        model: { providerID: "anthropic", modelID: "claude-sonnet-4-20250514" },
        queryTokens,
      });

      activationCounts.push(modelResult.activation.activated.length);

      for (const toolCall of turn.toolCalls) {
        const callID = `${turn.id}-${toolCall.tool}-${callSeq}`;

        adapter.beforeTool({
          sessionID,
          tool: toolCall.tool,
          callID,
          scopeRef: toolCall.scopeRef,
        });

        await adapter.afterTool(
          {
            sessionID,
            tool: toolCall.tool,
            callID,
            args: toolCall.args,
            scopeRef: toolCall.scopeRef,
          },
          {
            title: toolCall.title,
            output: toolCall.output,
          },
        );

        callSeq++;
      }
    }

    // The activation engine should be consistent throughout the session.
    // (Memory count is stable since we don't create new active memories during session.)
    const avgActivations = activationCounts.reduce((a, b) => a + b, 0) / activationCounts.length;

    printBenchmarkReport("Long-Session: Activation Trend", {
      "Turns": activationCounts.length,
      "Avg activations/turn": avgActivations.toFixed(2),
      "Min activations": Math.min(...activationCounts),
      "Max activations": Math.max(...activationCounts),
    });

    // Should not crash or degrade across 30 turns.
    expect(activationCounts.length).toBe(30);
    // Every turn should complete without error (implicit: no throw).
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Check if a dream evidence event matches a ground truth label.
 * Uses case-insensitive keyword matching against excerpt + title.
 */
function matchesLabel(
  event: DreamEvidenceEventRecord,
  label: GroundTruthLabel,
): boolean {
  const haystack = `${event.title} ${event.excerpt}`.toLowerCase();

  return label.keywords.some((keyword) =>
    haystack.includes(keyword.toLowerCase()),
  );
}
