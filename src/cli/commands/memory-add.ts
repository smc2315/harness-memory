/**
 * `hm memory:add --type <t> --summary <text> [--scope <glob>] [--details <text>] [--triggers a,b]
 *   [--signature tool:target:kind:pattern] [--tools bash,edit] [--enforce <level>] [--aliases a,b] [--active]`
 * (spec §7.1, §4.7): a human / manual memory. It is inserted as a `candidate` (a human candidate never expires
 * and shows up in `hm review`); `--active` promotes it in the same lock session through transitionMemory.
 * Re-adding a fact whose earlier rows are rejected/superseded revives it (`reviveTerminal`).
 */

import { compileSignature } from "../../activation/signature";
import { toolGlobFamilies } from "../../activation/tool-vocabulary";
import { EXIT_CODES } from "../../core/errors";
import { normalizeScopeGlob } from "../../core/ids";
import {
  CANONICAL_TOOL_FAMILIES,
  ENFORCEMENTS,
  isGlobalScope,
  LIFECYCLE_TRIGGERS,
  MEMORY_TYPES,
  PATTERN_KINDS,
  SIGNATURE_TARGETS,
  type Enforcement,
  type LifecycleTrigger,
  type MemoryType,
  type PatternKind,
  type SignatureTarget,
  type TriggerSignature,
} from "../../core/vocabulary";
import { MemoryRepository, type CreateMemoryInput, type MemoryRecord } from "../../memory/repository";
import { enforcementDefault } from "../../promotion/authority";
import type { CommandContext } from "../context";
import { flagBoolean, flagNumber, flagString, type OptionSpecs } from "../lib/args";
import { guard, usageError } from "../lib/cli-error";
import { writeDb } from "../lib/db-access";
import { promoteMemory } from "../lib/memory-actions";
import { memoryLine, memoryToJson, type MemoryJson } from "../lib/memory-render";
import { parseEnum, parseEnumList, splitList } from "../lib/options";

export const memoryAddOptions: OptionSpecs = {
  type: { type: "string", description: `Memory type (${MEMORY_TYPES.join(" | ")})`, placeholder: "<t>" },
  summary: { type: "string", description: "One-sentence imperative summary (≥ 12 chars)", placeholder: "<text>" },
  details: { type: "string", description: "Longer explanation", placeholder: "<text>" },
  scope: { type: "string", description: "Scope glob (default **/*)", placeholder: "<glob>" },
  triggers: { type: "string", description: `Comma list of lifecycle triggers (${LIFECYCLE_TRIGGERS.join(", ")}); default by type/signature`, placeholder: "<a,b>" },
  signature: { type: "string", description: "Trigger signature `tool:target:kind:pattern` (e.g. bash:command:cmd:npm test; prefix ! to negate)", placeholder: "<spec>" },
  tools: { type: "string", description: "Comma list of relevant canonical tools (default: the signature's tool family)", placeholder: "<a,b>" },
  enforce: { type: "string", description: `Enforcement (${ENFORCEMENTS.join(" | ")}); default from §7.3`, placeholder: "<level>" },
  aliases: { type: "string", description: "Comma list of synonyms / other-language keywords for lexical recall", placeholder: "<a,b>" },
  "policy-subtype": { type: "string", description: "hard | soft (policies only)", placeholder: "<s>" },
  confidence: { type: "number", description: "0..1 (default 0.9)", placeholder: "<n>" },
  importance: { type: "number", description: "0..1 (default 0.7)", placeholder: "<n>" },
  active: { type: "boolean", description: "Promote to active right away (default: human candidate for `hm review`)" },
};

export const MEMORY_ADD_SOURCE_REF = "cli:memory:add";

/** `[!]tool:target:kind:pattern` → TriggerSignature (the pattern may itself contain colons). */
export function parseSignatureSpec(spec: string): TriggerSignature {
  let text = spec.trim();
  let negate = false;
  if (text.startsWith("!")) {
    negate = true;
    text = text.slice(1);
  }
  const parts = text.split(":");
  if (parts.length < 4) throw usageError(`--signature needs tool:target:kind:pattern, got '${spec}'`, "example: bash:command:cmd:npm test");
  const [tool, target, kind, ...rest] = parts;
  const pattern = rest.join(":").trim();
  if (tool!.trim().length === 0 || pattern.length === 0) throw usageError(`--signature needs a tool and a pattern, got '${spec}'`);
  const signature: TriggerSignature = {
    tool: tool!.trim().toLowerCase(),
    target: parseEnum<SignatureTarget>(target!, SIGNATURE_TARGETS, "--signature target"),
    pattern_kind: parseEnum<PatternKind>(kind!, PATTERN_KINDS, "--signature kind"),
    pattern,
  };
  if (negate) signature.negate = true;
  return signature;
}

export function defaultTriggers(type: MemoryType, hasSignature: boolean, scopeGlob: string): LifecycleTrigger[] {
  if (hasSignature) return ["before_tool"];
  if (type === "decision" || type === "architecture_constraint") return ["session_start", "before_model"];
  if ((type === "policy" || type === "pitfall") && !isGlobalScope(scopeGlob)) return ["before_tool", "before_model"];
  return ["before_model"];
}

function isCanonicalToolPattern(value: string): boolean {
  return (CANONICAL_TOOL_FAMILIES as readonly string[]).includes(value) || /^mcp:[^/\s]+\/[^\s]+$/.test(value) || value === "*";
}

export interface MemoryAddReport {
  memory: MemoryJson;
  promoted: boolean;
  signature_key: string;
}

export function buildMemoryAddInput(ctx: CommandContext): { input: CreateMemoryInput; signatureKey: string } {
  const typeRaw = flagString(ctx.args, "type");
  const summary = flagString(ctx.args, "summary")?.trim() ?? "";
  if (typeRaw === null) throw usageError("--type is required", `one of ${MEMORY_TYPES.join(", ")}`);
  if (summary.length < 12) throw usageError("--summary is required and must be at least 12 characters");
  const type = parseEnum<MemoryType>(typeRaw, MEMORY_TYPES, "--type");
  const scopeGlob = normalizeScopeGlob(flagString(ctx.args, "scope") ?? "**/*");
  const details = flagString(ctx.args, "details")?.trim() ?? "";

  let triggerSignature: TriggerSignature | null = null;
  let signatureKey = "";
  const signatureSpec = flagString(ctx.args, "signature");
  if (signatureSpec !== null) {
    triggerSignature = parseSignatureSpec(signatureSpec);
    const compiled = compileSignature(triggerSignature);
    if (!compiled.ok) throw usageError(`--signature rejected (${compiled.code}): ${compiled.detail}`);
    signatureKey = compiled.compiled.signature_key;
    triggerSignature = { ...triggerSignature, tool: compiled.compiled.tool };
  }
  const hasSignature = triggerSignature !== null;

  const triggersRaw = flagString(ctx.args, "triggers");
  const lifecycleTriggers = triggersRaw === null ? defaultTriggers(type, hasSignature, scopeGlob) : parseEnumList<LifecycleTrigger>(triggersRaw, LIFECYCLE_TRIGGERS, "--triggers");
  if (lifecycleTriggers.length === 0) throw usageError("--triggers must name at least one trigger");

  const toolsRaw = splitList(flagString(ctx.args, "tools")).map((tool) => tool.toLowerCase());
  for (const tool of toolsRaw) {
    if (!isCanonicalToolPattern(tool)) throw usageError(`--tools: '${tool}' is not a canonical tool`, `use ${CANONICAL_TOOL_FAMILIES.join(", ")} or mcp:<server>/<tool>`);
  }
  const relevantTools = toolsRaw.length > 0 ? toolsRaw : hasSignature ? toolGlobFamilies(triggerSignature!.tool) : null;

  const subtypeRaw = flagString(ctx.args, "policy-subtype");
  const policySubtype = subtypeRaw === null ? null : parseEnum<"hard" | "soft">(subtypeRaw, ["hard", "soft"], "--policy-subtype");
  if (policySubtype !== null && type !== "policy") throw usageError("--policy-subtype applies to --type policy only");

  const enforceRaw = flagString(ctx.args, "enforce");
  const enforcement: Enforcement =
    enforceRaw === null
      ? enforcementDefault({ type, authority: "human", policySubtype, hasSignature, specificityOk: hasSignature, knowledgeKind: "manual", importUnconfirmed: 0, config: ctx.config, summary })
      : parseEnum<Enforcement>(enforceRaw, ENFORCEMENTS, "--enforce");

  const confidence = flagNumber(ctx.args, "confidence");
  const importance = flagNumber(ctx.args, "importance");
  for (const [name, value] of [
    ["--confidence", confidence],
    ["--importance", importance],
  ] as const) {
    if (value !== null && (value < 0 || value > 1)) throw usageError(`${name} must be between 0 and 1`);
  }

  const now = ctx.clock();
  const input: CreateMemoryInput = {
    type,
    summary,
    details,
    scopeGlob,
    activationClass: hasSignature ? "event" : isGlobalScope(scopeGlob) ? "baseline" : "scoped",
    lifecycleTriggers,
    confidence: confidence ?? 0.9,
    importance: importance ?? 0.7,
    status: "candidate",
    relevantTools,
    promotionSource: "manual",
    policySubtype,
    authority: "human",
    sourceKind: "manual",
    knowledgeKind: "manual",
    enforcement,
    triggerSignature,
    ...(hasSignature ? { signatureKey } : {}),
    aliases: splitList(flagString(ctx.args, "aliases")),
    sourceRef: MEMORY_ADD_SOURCE_REF,
    createdAt: now,
    updatedAt: now,
    lastVerifiedAt: now,
    reviveTerminal: true,
  };
  return { input, signatureKey };
}

export async function runMemoryAdd(ctx: CommandContext): Promise<number> {
  return guard(ctx, async () => {
    const { input, signatureKey } = buildMemoryAddInput(ctx);
    const promote = flagBoolean(ctx.args, "active");
    const { value } = await writeDb(ctx, { purpose: "memory:add", kind: "memory:add", subject: input.type }, (db, write) => {
      const repository = new MemoryRepository(db, { clock: () => write.now });
      let memory: MemoryRecord = repository.create(input);
      if (promote) memory = promoteMemory(db, memory, write.now, "cli:memory:add --active");
      return memory;
    });
    const report: MemoryAddReport = { memory: memoryToJson(value), promoted: promote, signature_key: signatureKey };
    ctx.out.result(report, () => {
      const lines = [`created ${memoryLine(value)}`];
      if (!promote) lines.push(`  candidate: \`hm memory:promote ${value.id.slice(0, 8)}\` activates it (or answer p in \`hm review\`)`);
      return lines;
    });
    return EXIT_CODES.ok;
  });
}
