import type { DreamEvidenceTypeGuess } from "../db/schema/types";
import type { DreamEvidenceEventRecord } from "../dream/types";

const SUMMARY_TYPE_ORDER: readonly DreamEvidenceTypeGuess[] = [
  "workflow",
  "pitfall",
  "policy",
  "decision",
  "architecture_constraint",
];

const MAX_SHORT_SUMMARY_LENGTH = 400;
const MAX_MEDIUM_SUMMARY_LENGTH = 1000;
const MAX_TOPICS = 5;
const MAX_SOURCE_EVENT_IDS = 20;
const MAX_TYPE_SNIPPETS = 2;
const MAX_SNIPPET_LENGTH = 120;

export interface SessionSummaryInput {
  sessionId: string;
  events: readonly DreamEvidenceEventRecord[];
}

export interface GeneratedSessionSummary {
  summaryShort: string;
  summaryMedium: string;
  toolNames: string[];
  typeDistribution: Record<string, number>;
  sourceEventIds: string[];
  eventCount: number;
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

function formatTypeLabel(typeGuess: string): string {
  return typeGuess.replace(/_/g, " ");
}

function createEmptyTypeDistribution(): Record<string, number> {
  const distribution: Record<string, number> = {};

  for (const typeGuess of SUMMARY_TYPE_ORDER) {
    distribution[typeGuess] = 0;
  }

  return distribution;
}

function rankTypes(
  typeDistribution: Record<string, number>
): Array<{ typeGuess: DreamEvidenceTypeGuess; count: number }> {
  return SUMMARY_TYPE_ORDER.map((typeGuess) => ({
    typeGuess,
    count: typeDistribution[typeGuess] ?? 0,
  }))
    .filter((entry) => entry.count > 0)
    .sort((left, right) => {
      if (right.count !== left.count) {
        return right.count - left.count;
      }

      return formatTypeLabel(left.typeGuess).localeCompare(formatTypeLabel(right.typeGuess));
    });
}

function formatTypeSummary(
  rankedTypes: ReadonlyArray<{ typeGuess: DreamEvidenceTypeGuess; count: number }>,
  limit: number
): string {
  if (rankedTypes.length === 0) {
    return "no strong type signal";
  }

  return rankedTypes
    .slice(0, limit)
    .map((entry) => `${formatTypeLabel(entry.typeGuess)} (${entry.count})`)
    .join(", ");
}

function collectToolNames(events: readonly DreamEvidenceEventRecord[]): string[] {
  const toolNames = new Set<string>();

  for (const event of events) {
    const toolName = normalizeText(event.toolName);
    if (toolName.length > 0) {
      toolNames.add(toolName);
    }
  }

  return [...toolNames].sort((left, right) => left.localeCompare(right));
}

function collectTopTopics(events: readonly DreamEvidenceEventRecord[]): string[] {
  const topicCounts = new Map<string, { topic: string; count: number; firstSeen: number }>();

  events.forEach((event, index) => {
    const topic = normalizeText(event.topicGuess);
    if (topic.length === 0) {
      return;
    }

    const key = topic.toLowerCase();
    const existing = topicCounts.get(key);
    if (existing !== undefined) {
      existing.count += 1;
      return;
    }

    topicCounts.set(key, { topic, count: 1, firstSeen: index });
  });

  return [...topicCounts.values()]
    .sort((left, right) => {
      if (right.count !== left.count) {
        return right.count - left.count;
      }

      if (left.firstSeen !== right.firstSeen) {
        return left.firstSeen - right.firstSeen;
      }

      return left.topic.localeCompare(right.topic);
    })
    .slice(0, MAX_TOPICS)
    .map((entry) => entry.topic);
}

function formatList(items: readonly string[], fallback: string): string {
  return items.length > 0 ? items.join(", ") : fallback;
}

function compareEventsForSummary(
  left: DreamEvidenceEventRecord,
  right: DreamEvidenceEventRecord
): number {
  const leftScore = left.salience + left.novelty + left.salienceBoost;
  const rightScore = right.salience + right.novelty + right.salienceBoost;
  if (rightScore !== leftScore) {
    return rightScore - leftScore;
  }

  const createdAtDelta = Date.parse(right.createdAt) - Date.parse(left.createdAt);
  if (createdAtDelta !== 0) {
    return createdAtDelta;
  }

  return right.id.localeCompare(left.id);
}

function buildSnippet(event: DreamEvidenceEventRecord): string {
  const excerpt = normalizeText(event.excerpt);
  if (excerpt.length > 0) {
    return truncateText(excerpt, MAX_SNIPPET_LENGTH);
  }

  return truncateText(normalizeText(event.title), MAX_SNIPPET_LENGTH);
}

function buildTypeSection(
  typeGuess: DreamEvidenceTypeGuess,
  events: readonly DreamEvidenceEventRecord[],
  count: number
): string {
  const snippets = events
    .filter((event) => event.typeGuess === typeGuess)
    .sort(compareEventsForSummary)
    .map((event) => buildSnippet(event))
    .filter((snippet, index, allSnippets) => {
      return snippet.length > 0 && allSnippets.indexOf(snippet) === index;
    })
    .slice(0, MAX_TYPE_SNIPPETS);

  const body = snippets.length > 0 ? snippets.join(" | ") : "No representative excerpts.";
  return `${formatTypeLabel(typeGuess)} (${count}): ${body}`;
}

function buildMediumSummary(lines: readonly string[]): string {
  let summary = "";

  for (const line of lines) {
    const nextSummary = summary.length === 0 ? line : `${summary}\n${line}`;
    if (nextSummary.length <= MAX_MEDIUM_SUMMARY_LENGTH) {
      summary = nextSummary;
      continue;
    }

    if (summary.length > 0) {
      return truncateText(summary, MAX_MEDIUM_SUMMARY_LENGTH);
    }

    return truncateText(line, MAX_MEDIUM_SUMMARY_LENGTH);
  }

  return summary;
}

function selectSourceEventIds(events: readonly DreamEvidenceEventRecord[]): string[] {
  return [...events]
    .sort((left, right) => {
      const createdAtDelta = Date.parse(right.createdAt) - Date.parse(left.createdAt);
      if (createdAtDelta !== 0) {
        return createdAtDelta;
      }

      return right.id.localeCompare(left.id);
    })
    .slice(0, MAX_SOURCE_EVENT_IDS)
    .map((event) => event.id);
}

export function generateSessionSummary(
  input: SessionSummaryInput
): GeneratedSessionSummary {
  const typeDistribution = createEmptyTypeDistribution();

  for (const event of input.events) {
    typeDistribution[event.typeGuess] = (typeDistribution[event.typeGuess] ?? 0) + 1;
  }

  const rankedTypes = rankTypes(typeDistribution);
  const toolNames = collectToolNames(input.events);
  const topTopics = collectTopTopics(input.events);
  const eventCount = input.events.length;
  const sourceEventIds = selectSourceEventIds(input.events);

  const summaryShort = truncateText(
    `[Session] ${eventCount} events: ${formatTypeSummary(rankedTypes, 3)}. Tools: ${formatList(toolNames, "none")}. Topics: ${formatList(topTopics, "none")}.`,
    MAX_SHORT_SUMMARY_LENGTH
  );

  const mediumLines = [
    `Session ${input.sessionId} overview`,
    `Events: ${eventCount}`,
    `Tools: ${formatList(toolNames, "none")}`,
    `Topics: ${formatList(topTopics, "none")}`,
  ];

  if (rankedTypes.length === 0) {
    mediumLines.push("Types: no representative evidence.");
  } else {
    for (const entry of rankedTypes) {
      mediumLines.push(buildTypeSection(entry.typeGuess, input.events, entry.count));
    }
  }

  return {
    summaryShort,
    summaryMedium: buildMediumSummary(mediumLines),
    toolNames,
    typeDistribution,
    sourceEventIds,
    eventCount,
  };
}
