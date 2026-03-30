import type { ActivationResult } from "../activation";
import type { MemoryType } from "../db/schema/types";
import type { EvidenceRecord } from "../memory";
import type { PolicyWarning } from "../policy";

export interface AdapterModelRef {
  providerID: string;
  modelID: string;
}

export interface AdapterSessionMetadata {
  agent?: string;
  model?: AdapterModelRef;
  messageID?: string;
  variant?: string;
}

export interface AdapterSessionStartInput extends AdapterSessionMetadata {
  sessionID: string;
}

export interface AdapterBeforeModelInput {
  sessionID?: string;
  model: AdapterModelRef;
  scopeRef?: string;
  types?: readonly MemoryType[];
  maxMemories?: number;
  maxPayloadBytes?: number;
}

export interface AdapterBeforeModelRecord {
  scopeRef: string;
  model: AdapterModelRef;
  advisoryText: string | null;
  activation: ActivationResult;
  createdAt: string;
}

export interface AdapterBeforeModelResult {
  session: AdapterSessionContext | null;
  advisoryText: string | null;
  system: string[];
  activation: ActivationResult;
}

export interface AdapterBeforeToolInput {
  sessionID: string;
  tool: string;
  callID: string;
  scopeRef?: string;
}

export interface AdapterToolPolicyCheck {
  toolName: string;
  callID: string;
  scopeRef: string;
  evaluatedAt: string;
  warnings: PolicyWarning[];
  warningText: string | null;
}

export interface AdapterBeforeToolResult {
  session: AdapterSessionContext;
  warnings: PolicyWarning[];
  warningText: string | null;
  evaluatedAt: string;
  blocked: false;
}

export interface AdapterAfterToolInput {
  sessionID: string;
  tool: string;
  callID: string;
  args: unknown;
  scopeRef?: string;
  types?: readonly MemoryType[];
}

export interface AdapterAfterToolOutput {
  title: string;
  output: string;
  metadata?: unknown;
}

export interface AdapterToolEvidenceCapture {
  toolName: string;
  callID: string;
  scopeRef: string;
  args: unknown;
  title: string;
  output: string;
  metadata?: unknown;
  capturedAt: string;
  activation: ActivationResult;
  relatedMemoryIds: string[];
  evidence: EvidenceRecord[];
  excerpt: string;
}

export interface AdapterAfterToolResult {
  session: AdapterSessionContext;
  activation: ActivationResult;
  relatedMemoryIds: string[];
  createdEvidence: EvidenceRecord[];
  excerpt: string;
}

export interface AdapterSessionContext {
  sessionID: string;
  createdAt: string;
  lastUpdatedAt: string;
  lastScopeRef: string;
  metadata: AdapterSessionMetadata;
  lastBeforeModel: AdapterBeforeModelRecord | null;
  toolPolicyChecks: AdapterToolPolicyCheck[];
  toolEvidence: AdapterToolEvidenceCapture[];
}
