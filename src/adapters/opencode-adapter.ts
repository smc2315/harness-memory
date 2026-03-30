import { ActivationEngine, type RankedMemory } from "../activation";
import { DreamRepository } from "../dream";
import { PolicyEngine, type PolicyWarning } from "../policy";

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

export interface OpenCodeAdapterOptions {
  activationEngine: ActivationEngine;
  policyEngine: PolicyEngine;
  dreamRepository?: DreamRepository;
  defaultScopeRef?: string;
  evidenceExcerptMaxChars?: number;
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

function formatMemoryLine(memory: RankedMemory): string {
  const presentation = MEMORY_TYPE_PRESENTATION[memory.type];
  const summaryText = collapseWhitespace(memory.summary);
  const detailText = collapseWhitespace(memory.details);

  if (detailText.length === 0) {
    return `- [${presentation.tag}] ${summaryText}`;
  }

  return `- [${presentation.tag}] ${summaryText}: ${detailText}`;
}

function formatActivatedMemoryAdvisory(
  memories: readonly RankedMemory[]
): string | null {
  if (memories.length === 0) {
    return null;
  }

  const sections: string[] = ["## Active Memories"];

  for (const memoryType of MEMORY_TYPE_ORDER) {
    const matchingMemories = memories.filter((memory) => memory.type === memoryType);

    if (matchingMemories.length === 0) {
      continue;
    }

    sections.push("");
    sections.push(`### ${MEMORY_TYPE_PRESENTATION[memoryType].heading}`);

    for (const memory of matchingMemories) {
      sections.push(formatMemoryLine(memory));
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

  private readonly sessions = new Map<string, AdapterSessionContext>();

  constructor(options: OpenCodeAdapterOptions) {
    this.activationEngine = options.activationEngine;
    this.policyEngine = options.policyEngine;
    this.dreamRepository = options.dreamRepository ?? null;
    this.defaultScopeRef = options.defaultScopeRef ?? DEFAULT_SCOPE_REF;
    this.evidenceExcerptMaxChars =
      options.evidenceExcerptMaxChars ?? DEFAULT_EVIDENCE_EXCERPT_MAX_CHARS;
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

  beforeModel(input: AdapterBeforeModelInput): AdapterBeforeModelResult {
    const session =
      input.sessionID === undefined ? null : this.getOrCreateSession(input.sessionID);
    const scopeRef = this.resolveScopeRef(input.scopeRef, session);
    const activation = this.activationEngine.activate({
      lifecycleTrigger: "before_model",
      scopeRef,
      types: input.types,
      maxMemories: input.maxMemories,
      maxPayloadBytes: input.maxPayloadBytes,
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
      session.lastUpdatedAt = nowIsoString();
    }

    return {
      session,
      advisoryText,
      system: advisoryText === null ? [] : [advisoryText],
      activation,
    };
  }

  beforeTool(input: AdapterBeforeToolInput): AdapterBeforeToolResult {
    const session = this.getOrCreateSession(input.sessionID);
    const scopeRef = this.resolveScopeRef(input.scopeRef, session);
    const evaluation = this.policyEngine.evaluate({
      lifecycleTrigger: "before_tool",
      scopeRef,
    });
    const warningText = formatPolicyWarnings(evaluation.warnings);
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
      evaluatedAt: evaluation.evaluatedAt,
      blocked: false,
    };
  }

  afterTool(
    input: AdapterAfterToolInput,
    output: AdapterAfterToolOutput
  ): AdapterAfterToolResult {
    const session = this.getOrCreateSession(input.sessionID);
    const scopeRef = this.resolveScopeRef(input.scopeRef, session);
    const activation = this.activationEngine.activate({
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
      const typeGuess = inferDreamTypeGuess(excerpt, output.title, input.tool);
      this.dreamRepository.createEvidenceEvent({
        sessionId: input.sessionID,
        callId: input.callID,
        toolName: input.tool,
        scopeRef,
        sourceRef,
        title: output.title,
        excerpt,
        args: input.args,
        metadata: output.metadata,
        topicGuess: buildDreamTopicGuess(input, scopeRef, excerpt, typeGuess),
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
        contradictionSignal: activation.conflicts.length > 0,
        createdAt,
      });
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
