import { LexicalIndex } from "../dist/activation/index.js";

const index = new LexicalIndex();

index.rebuild([
  {
    id: "memory-1",
    summary: "Prefer OpenAIResponsesClient for API calls",
    details: "Use OpenAIResponsesClient in the adapter layer for tool-safe retries.",
  },
  {
    id: "memory-2",
    summary: "Use PostgreSQL migrations",
    details: "All schema updates must include backward-compatible migration scripts.",
  },
  {
    id: "memory-3",
    summary: "OpenAI client testing strategy",
    details: "Mock OpenAIResponsesClient and assert response normalization behavior.",
  },
]);

const query = "openai client";
const results = index.search(query, 3);

console.log(`Query: ${query}`);
console.log("Results:");
for (const result of results) {
  console.log(`- ${result.id}: ${result.score.toFixed(4)}`);
}

if (results.length < 2) {
  throw new Error("Expected at least two lexical matches.");
}

for (let i = 1; i < results.length; i += 1) {
  if (results[i - 1].score < results[i].score) {
    throw new Error("Expected results to be ordered by descending score.");
  }
}

console.log("Lexical verification passed: scored results are ordered.");
