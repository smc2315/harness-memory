import { ActivationEngine, type RankedMemory } from "../activation";
import type { EvidenceMetadata, SignalTag } from "../db/schema/types";
import { DreamRepository } from "../dream";
import { PolicyEngine, type PolicyWarning } from "../policy";
import { classifyQueryType } from "../retrieval/query-router";
import { scanMemoryContent } from "../security";

import type {
  AdapterAfterToolInput,
  AdapterAfterToolOutput,
  AdapterAfterToolResult,
  AdapterBeforeModelInput,
  AdapterBeforeModelResult,
  AdapterBeforeToolInput,
  AdapterBeforeToolResult,
  AdapterSessionContext,
  AdapterSessionMetadata,
  AdapterSessionStartInput,
  AdapterToolEvidenceCapture,
  AdapterToolPolicyCheck,
} from "./types";

const MEMORY_TYPE_ORDER = [
  "policy",
  "workflow",
  "pitfall",
  "architecture_constraint",
  "decision",
] as const;

interface MemoryTypePresentation {
  heading: string;
  tag: string;
}

type PresentedMemoryType = typeof MEMORY_TYPE_ORDER[number];
type DisclosureTier = "full" | "summary" | "hint";

const MEMORY_TYPE_PRESENTATION: Record<PresentedMemoryType, MemoryTypePresentation> = {
  policy: { heading: "Policies", tag: "POLICY" },
  workflow: { heading: "Workflows", tag: "WORKFLOW" },
  pitfall: { heading: "Pitfalls", tag: "PITFALL" },
  architecture_constraint: {
    heading: "Architecture Constraints",
    tag: "CONSTRAINT",
  },
  decision: { heading: "Decisions", tag: "DECISION" },
};

const DEFAULT_SCOPE_REF = ".";
const DEFAULT_EVIDENCE_EXCERPT_MAX_CHARS = 2000;
const DEFAULT_SALIENCE_BOUNDARY_INTERVAL = 10;
const DEFAULT_SALIENCE_BOUNDARY_BOOST = 0.15;

export interface OpenCodeAdapterOptions {
  activationEngine: ActivationEngine;
  policyEngine: PolicyEngine;
  dreamRepository?: DreamRepository;
  defaultScopeRef?: string;
  evidenceExcerptMaxChars?: number;
  salienceBoundaryInterval?: number;
  salienceBoundaryBoost?: number;
}

function buildDreamTopicGuess(
  input: AdapterAfterToolInput,
  scopeRef: string,
  excerpt: string,
  typeGuess: "policy" | "workflow" | "pitfall" | "architecture_constraint" | "decision"
): string {
  const normalizedScope = scopeRef.replace(/\\/g, "/");
  const text = `${input.tool} ${excerpt}`.toLowerCase();

  if (typeGuess === "pitfall") {
    const signature =
      text.match(/(enoent|eaddr|refused|timeout|assertion|not found|permission|secret)/)?.[1] ??
      input.tool;
    return `${typeGuess}:${normalizedScope}:${signature}`;
  }

  if (typeGuess === "policy") {
    const signature =
      text.match(/(gdpr|consent|secret|permission|warning|forbid|compliance)/)?.[1] ??
      "policy";
    return `${typeGuess}:${normalizedScope}:${signature}`;
  }

  if (typeGuess === "decision") {
    const signature =
      text.match(/(switch to|migrate to|use .* instead|standardize)/)?.[1]?.replace(/\s+/g, "-") ??
      input.tool;
    return `${typeGuess}:${normalizedScope}:${signature}`;
  }

  if (typeGuess === "architecture_constraint") {
    const signature =
      text.match(/(repository|adapter|boundary|interface|layer|constraint)/)?.[1] ??
      "structure";
    return `${typeGuess}:${normalizedScope}:${signature}`;
  }

  const workflowSignature = /passed|resolved|fixed|migrated/.test(text) ? "verified-flow" : input.tool;
  return `${typeGuess}:${normalizedScope}:${workflowSignature}`;
}

function inferDreamTypeGuess(
  excerpt: string,
  title: string,
  toolName: string
): "policy" | "workflow" | "pitfall" | "architecture_constraint" | "decision" {
  const text = `${title} ${excerpt}`.toLowerCase();

  if (/(error|failed|exception|traceback|not found|enoent|eaddr|refused|timeout|assertion)/i.test(text)) {
    return "pitfall";
  }

  if (/(policy|warning|forbid|forbidden|must not|never |secret|gdpr|consent|compliance|permission)/i.test(text)) {
    return "policy";
  }

  if (/(decided|decision|choose|chosen|standardize|switch to|migrate to|use .* instead)/i.test(text)) {
    return "decision";
  }

  if (/(architecture|boundary|repository|adapter|interface|constraint|invariant|layer)/i.test(text)) {
    return "architecture_constraint";
  }

  if (toolName === "bash" && /(passed|completed|succeeded|migrated|fixed|resolved)/i.test(text)) {
    return "workflow";
  }

  return "workflow";
}

function estimateDreamSalience(
  typeGuess: "policy" | "workflow" | "pitfall" | "architecture_constraint" | "decision",
  title: string,
  excerpt: string,
  toolName: string,
  relatedMemoryCount: number,
  conflictCount: number
): number {
  let salience = 0.45;

  if (typeGuess === "pitfall") {
    salience += 0.25;
  }

  if (typeGuess === "policy" || typeGuess === "decision") {
    salience += 0.15;
  }

  if (typeGuess === "architecture_constraint") {
    salience += 0.1;
  }

  if (relatedMemoryCount > 0) {
    salience += 0.1;
  }

  if (conflictCount > 0) {
    salience += 0.1;
  }

  if (/fixed|completed|created|updated|migrated|passed|resolved/i.test(`${title} ${excerpt}`)) {
    salience += 0.1;
  }

  if (toolName === "bash") {
    salience += 0.05;
  }

  return Math.min(1, salience);
}

function estimateDreamNovelty(
  typeGuess: "policy" | "workflow" | "pitfall" | "architecture_constraint" | "decision",
  relatedMemoryCount: number,
  conflictCount: number
): number {
  let novelty = relatedMemoryCount === 0 ? 0.8 : 0.55;

  if (typeGuess === "decision" || typeGuess === "architecture_constraint") {
    novelty += 0.1;
  }

  if (conflictCount > 0) {
    novelty += 0.1;
  }

  return Math.min(1, novelty);
}

// ---------------------------------------------------------------------------
// Signal tag extraction — regex is a HINT provider, not a gatekeeper
// ---------------------------------------------------------------------------

const ADAPTER_SIGNAL_PATTERNS: ReadonlyArray<{
  tag: SignalTag;
  pattern: RegExp;
  field: "excerpt" | "args";
}> = [
  { tag: "failure_signal", pattern: /error|failed|exception|timeout|refused/i, field: "excerpt" },
  { tag: "success_signal", pattern: /passed|resolved|fixed|completed|migrated|created|updated/i, field: "excerpt" },
  { tag: "decision_signal", pattern: /decided|chose|switched|replaced|deprecated|changed\s.*\sto/i, field: "excerpt" },
  { tag: "convention_signal", pattern: /always|never|convention|must|should|standard|rule/i, field: "excerpt" },
  { tag: "architecture_signal", pattern: /architecture|boundary|layer|component|module|structure/i, field: "excerpt" },
  { tag: "temporal_cue", pattern: /before|after|previously|used to|switched from/i, field: "excerpt" },
  { tag: "explicit_marker", pattern: /do not|always use|fixed by|known error/i, field: "excerpt" },
  { tag: "has_file_context", pattern: /path|file|src\//i, field: "args" },
];

function extractEvidenceSignalTags(excerpt: string, argsJson: string): SignalTag[] {
  const tags: SignalTag[] = [];
  for (const { tag, pattern, field } of ADAPTER_SIGNAL_PATTERNS) {
    const text = field === "excerpt" ? excerpt : argsJson;
    if (pattern.test(text)) {
      tags.push(tag);
    }
  }
  return tags;
}

/**
 * Structural noise filter — rejects evidence that has no informational content.
 * NO regex. Only structural checks: length, emptiness.
 * Returns true if evidence should be DISCARDED as noise.
 */
function isEvidenceNoise(excerpt: string): boolean {
  if (excerpt.length < 20) return true;
  if (excerpt.trim() === "") return true;
  return false;
}

function nowIsoString(): string {
  return new Date().toISOString();
}

function collapseWhitespace(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function mergeSessionMetadata(
  current: AdapterSessionMetadata,
  updates: AdapterSessionMetadata
): AdapterSessionMetadata {
  const next: AdapterSessionMetadata = { ...current };

  if (updates.agent !== undefined) {
    next.agent = updates.agent;
  }

  if (updates.messageID !== undefined) {
    next.messageID = updates.messageID;
  }

  if (updates.model !== undefined) {
    next.model = {
      providerID: updates.model.providerID,
      modelID: updates.model.modelID,
    };
  }

  if (updates.variant !== undefined) {
    next.variant = updates.variant;
  }

  return next;
}

function formatMemoryLine(memory: RankedMemory, tier: DisclosureTier): string {
  const presentation = MEMORY_TYPE_PRESENTATION[memory.type];
  const summaryText = collapseWhitespace(memory.summary);

  if (tier === "hint") {
    return `- [${presentation.tag}] ${summaryText} [expand: memory:view ${memory.id}]`;
  }

  if (tier === "summary") {
    return `- [${presentation.tag}] ${summaryText}`;
  }

  const detailText = collapseWhitespace(memory.details);

  if (detailText.length === 0) {
    return `- [${presentation.tag}] ${summaryText}`;
  }

  return `- [${presentation.tag}] ${summaryText}: ${detailText}`;
}

function getDisclosureTier(rank: number, totalCount: number): DisclosureTier {
  void totalCount;

  if (rank <= 5) {
    return "full";
  }

  if (rank <= 8) {
    return "summary";
  }

  return "hint";
}

/**
 * Format activated memories into prompt sections: static (baseline) and
 * dynamic (scoped/vector results). This separation enables LLM prompt
 * caching — the static section is identical across turns.
 */
function formatActivatedMemoryAdvisory(
  memories: readonly RankedMemory[]
): string | null {
  const safeMemories = memories.filter((memory) => {
    const result = scanMemoryContent(memory.summary, memory.details);
    return result.safe;
  });

  if (safeMemories.length === 0) {
    return null;
  }

  const baseline = safeMemories.filter((m) => m.activationClass === "baseline");
  const dynamic = safeMemories.filter((m) => m.activationClass !== "baseline");

  const sections: string[] = [];

  // Static section — baseline memories (cacheable, identical across turns)
  if (baseline.length > 0) {
    sections.push("## Project Baseline");

    for (const memoryType of MEMORY_TYPE_ORDER) {
      const matching = baseline.filter((m) => m.type === memoryType);

      if (matching.length > 0) {
        sections.push("");
        sections.push(`### ${MEMORY_TYPE_PRESENTATION[memoryType].heading}`);

        for (const memory of matching) {
          const tier: DisclosureTier = "full";
          sections.push(formatMemoryLine(memory, tier));
        }
      }
    }
  }

  // Dynamic section — scoped/vector/event memories (varies per turn)
  if (dynamic.length > 0) {
    if (baseline.length > 0) {
      sections.push("");
    }

    sections.push("## Context Memories");

    for (const memoryType of MEMORY_TYPE_ORDER) {
      const matching = dynamic.filter((m) => m.type === memoryType);

      if (matching.length > 0) {
        sections.push("");
        sections.push(`### ${MEMORY_TYPE_PRESENTATION[memoryType].heading}`);

        for (const memory of matching) {
          const tier = getDisclosureTier(memory.rank, safeMemories.length);
          sections.push(formatMemoryLine(memory, tier));
        }
      }
    }
  }

  return sections.join("\n");
}

function formatPolicyWarning(warning: PolicyWarning): string {
  return `- [${warning.severity.toUpperCase()}] ${warning.ruleCode}: ${collapseWhitespace(warning.message)}`;
}

function formatPolicyWarnings(warnings: readonly PolicyWarning[]): string | null {
  if (warnings.length === 0) {
    return null;
  }

  return ["## Tool Warnings", "", ...warnings.map(formatPolicyWarning)].join("\n");
}

function serializeUnknownValue(value: unknown): string {
  if (value === undefined) {
    return "undefined";
  }

  if (typeof value === "string") {
    return value;
  }

  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    value === null
  ) {
    return String(value);
  }

  try {
    const serialized = JSON.stringify(value);
    return serialized ?? String(value);
  } catch {
    return String(value);
  }
}

function truncateText(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }

  const truncatedLength = Math.max(0, maxChars - 3);
  return `${value.slice(0, truncatedLength)}...`;
}

function buildToolEvidenceExcerpt(
  input: AdapterAfterToolInput,
  output: AdapterAfterToolOutput,
  maxChars: number
): string {
  const lines = [
    `tool=${input.tool}`,
    `callID=${input.callID}`,
    `title=${output.title}`,
    `args=${serializeUnknownValue(input.args)}`,
    `output=${output.output}`,
  ];

  if (output.metadata !== undefined) {
    lines.push(`metadata=${serializeUnknownValue(output.metadata)}`);
  }

  return truncateText(lines.join("\n"), maxChars);
}

export class OpenCodeAdapter {
  readonly activationEngine: ActivationEngine;
  readonly policyEngine: PolicyEngine;
  readonly dreamRepository: DreamRepository | null;
  readonly defaultScopeRef: string;
  readonly evidenceExcerptMaxChars: number;
  readonly salienceBoundaryInterval: number;
  readonly salienceBoundaryBoost: number;

  private readonly sessions = new Map<string, AdapterSessionContext>();

  constructor(options: OpenCodeAdapterOptions) {
    this.activationEngine = options.activationEngine;
    this.policyEngine = options.policyEngine;
    this.dreamRepository = options.dreamRepository ?? null;
    this.defaultScopeRef = options.defaultScopeRef ?? DEFAULT_SCOPE_REF;
    this.evidenceExcerptMaxChars =
      options.evidenceExcerptMaxChars ?? DEFAULT_EVIDENCE_EXCERPT_MAX_CHARS;
    this.salienceBoundaryInterval =
      options.salienceBoundaryInterval ?? DEFAULT_SALIENCE_BOUNDARY_INTERVAL;
    this.salienceBoundaryBoost =
      options.salienceBoundaryBoost ?? DEFAULT_SALIENCE_BOUNDARY_BOOST;
  }

  getSession(sessionID: string): AdapterSessionContext | null {
    return this.sessions.get(sessionID) ?? null;
  }

  getOrCreateSession(sessionID: string): AdapterSessionContext {
    const existing = this.sessions.get(sessionID);

    if (existing !== undefined) {
      return existing;
    }

    const timestamp = nowIsoString();
    const session: AdapterSessionContext = {
      sessionID,
      createdAt: timestamp,
      lastUpdatedAt: timestamp,
      lastScopeRef: this.defaultScopeRef,
      metadata: {},
      lastBeforeModel: null,
      toolPolicyChecks: [],
      toolEvidence: [],
      beforeModelCount: 0,
      toolCallCount: 0,
    };

    this.sessions.set(sessionID, session);
    return session;
  }

  updateSessionMetadata(
    sessionID: string,
    metadata: AdapterSessionMetadata
  ): AdapterSessionContext {
    const session = this.getOrCreateSession(sessionID);
    session.metadata = mergeSessionMetadata(session.metadata, metadata);
    session.lastUpdatedAt = nowIsoString();
    return session;
  }

  initializeSession(input: AdapterSessionStartInput): AdapterSessionContext {
    return this.updateSessionMetadata(input.sessionID, input);
  }

  async beforeModel(input: AdapterBeforeModelInput): Promise<AdapterBeforeModelResult> {
    const session =
      input.sessionID === undefined ? null : this.getOrCreateSession(input.sessionID);
    const scopeRef = this.resolveScopeRef(input.scopeRef, session);
    const messageText = input.messageText ?? "";
    const queryMode = classifyQueryType(messageText);
    const activationMode =
      session !== null && session.toolCallCount === 0 && session.beforeModelCount === 0
        ? "startup"
        : queryMode;
    const activation = await this.activationEngine.activate({
      lifecycleTrigger: "before_model",
      scopeRef,
      types: input.types,
      queryTokens: input.queryTokens,
      repoFingerprint: input.repoFingerprint,
      maxMemories: input.maxMemories,
      maxPayloadBytes: input.maxPayloadBytes,
      activationMode,
    });
    const advisoryText = formatActivatedMemoryAdvisory(activation.activated);

    if (session !== null) {
      session.metadata = {
        ...session.metadata,
        model: {
          providerID: input.model.providerID,
          modelID: input.model.modelID,
        },
      };
      session.lastScopeRef = scopeRef;
      session.lastBeforeModel = {
        scopeRef,
        model: {
          providerID: input.model.providerID,
          modelID: input.model.modelID,
        },
        advisoryText,
        activation,
        createdAt: nowIsoString(),
      };
      session.beforeModelCount += 1;
      session.lastUpdatedAt = nowIsoString();
    }

    return {
      session,
      advisoryText,
      system: advisoryText === null ? [] : [advisoryText],
      activation,
    };
  }

  expandMemory(memoryId: string): string | null {
    const memory = this.activationEngine.repository.getById(memoryId);
    if (memory === null) {
      return null;
    }

    const scanResult = scanMemoryContent(memory.summary, memory.details);
    if (!scanResult.safe) {
      return null;
    }

    const presentation = MEMORY_TYPE_PRESENTATION[memory.type];
    if (presentation === undefined) {
      return null;
    }

    return [
      `## ${presentation.heading}: ${memory.summary}`,
      "",
      memory.details,
      "",
      `Type: ${memory.type} | Scope: ${memory.scopeGlob} | Confidence: ${memory.confidence}`,
    ].join("\n");
  }

  async beforeTool(input: AdapterBeforeToolInput): Promise<AdapterBeforeToolResult> {
    const session = this.getOrCreateSession(input.sessionID);
    const scopeRef = this.resolveScopeRef(input.scopeRef, session);
    const evaluation = this.policyEngine.evaluate({
      lifecycleTrigger: "before_tool",
      scopeRef,
    });
    const warningText = formatPolicyWarnings(evaluation.warnings);
    const activation = await this.activationEngine.activate({
      lifecycleTrigger: "before_tool",
      scopeRef,
      toolName: input.tool,
      activationMode: "default",
    });
    const advisoryText = formatActivatedMemoryAdvisory(activation.activated);
    const policyCheck: AdapterToolPolicyCheck = {
      toolName: input.tool,
      callID: input.callID,
      scopeRef,
      evaluatedAt: evaluation.evaluatedAt,
      warnings: evaluation.warnings,
      warningText,
    };

    session.toolPolicyChecks.push(policyCheck);
    session.lastScopeRef = scopeRef;
    session.lastUpdatedAt = nowIsoString();

    return {
      session,
      warnings: evaluation.warnings,
      warningText,
      advisoryText,
      activation,
      evaluatedAt: evaluation.evaluatedAt,
      blocked: false,
    };
  }

  async afterTool(
    input: AdapterAfterToolInput,
    output: AdapterAfterToolOutput
  ): Promise<AdapterAfterToolResult> {
    const session = this.getOrCreateSession(input.sessionID);
    const scopeRef = this.resolveScopeRef(input.scopeRef, session);
    const activation = await this.activationEngine.activate({
      lifecycleTrigger: "after_tool",
      scopeRef,
      types: input.types,
    });
    const excerpt = buildToolEvidenceExcerpt(
      input,
      output,
      this.evidenceExcerptMaxChars
    );
    const sourceRef = `${input.sessionID}:${input.callID}:${input.tool}`;
    const createdAt = nowIsoString();
    session.toolCallCount += 1;
    const salienceBoost =
      session.toolCallCount % this.salienceBoundaryInterval === 0
        ? this.salienceBoundaryBoost
        : 0;
    const createdEvidence = activation.activated.map((memory) =>
      this.activationEngine.repository.createEvidence({
        memoryId: memory.id,
        sourceKind: "session",
        sourceRef,
        excerpt,
        createdAt,
      })
    );

    if (this.dreamRepository !== null) {
      // Structural noise filter — NO regex, only length/emptiness checks
      if (!isEvidenceNoise(excerpt)) {
        const typeGuess = inferDreamTypeGuess(excerpt, output.title, input.tool);
        const topicGuess = buildDreamTopicGuess(input, scopeRef, excerpt, typeGuess);

        // Extract signal tags from evidence — these are HINTS, not gates
        const signalTags = extractEvidenceSignalTags(
          excerpt,
          JSON.stringify(input.args).toLowerCase()
        );

        // Build enriched metadata with signal tags and hint fields
        const evidenceMetadata: EvidenceMetadata = {
          ...(output.metadata !== undefined && typeof output.metadata === "object" && output.metadata !== null
            ? (output.metadata as Record<string, unknown>)
            : {}),
          signalTags,
          hintType: typeGuess,
          hintTopic: topicGuess,
        };

        this.dreamRepository.createEvidenceEvent({
          sessionId: input.sessionID,
          callId: input.callID,
          toolName: input.tool,
          scopeRef,
          sourceRef,
          title: output.title,
          excerpt,
          args: input.args,
          metadata: evidenceMetadata,
          // typeGuess and topicGuess still stored in columns for backward compat,
          // but the worker no longer uses them for gating or grouping decisions
          topicGuess,
          typeGuess,
          salience: estimateDreamSalience(
            typeGuess,
            output.title,
            excerpt,
            input.tool,
            activation.activated.length,
            activation.conflicts.length
          ),
          novelty: estimateDreamNovelty(
            typeGuess,
            activation.activated.length,
            activation.conflicts.length
          ),
          salienceBoost,
          contradictionSignal: activation.conflicts.length > 0,
          createdAt,
        });
      }
    }

    const evidenceCapture: AdapterToolEvidenceCapture = {
      toolName: input.tool,
      callID: input.callID,
      scopeRef,
      args: input.args,
      title: output.title,
      output: output.output,
      metadata: output.metadata,
      capturedAt: createdAt,
      activation,
      relatedMemoryIds: activation.activated.map((memory) => memory.id),
      evidence: createdEvidence,
      excerpt,
    };

    session.toolEvidence.push(evidenceCapture);
    session.lastScopeRef = scopeRef;
    session.lastUpdatedAt = createdAt;

    return {
      session,
      activation,
      relatedMemoryIds: evidenceCapture.relatedMemoryIds,
      createdEvidence,
      excerpt,
    };
  }

  private resolveScopeRef(
    scopeRef: string | undefined,
    session: AdapterSessionContext | null
  ): string {
    if (scopeRef !== undefined) {
      return scopeRef;
    }

    if (session !== null) {
      return session.lastScopeRef;
    }

    return this.defaultScopeRef;
  }
}
