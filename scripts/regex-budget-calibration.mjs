#!/usr/bin/env node
// Calibration of the V5 regex time budget (src/activation/signature.ts) on the machine this runs on.
//
// Bundles the signature module with esbuild (a dependency of vitest / tsup, so present after `npm ci`), then:
//   1. times the linear reference candidates over the same samples the validator uses (512 B and 4 KB);
//   2. times every fixture pattern (min of five sweeps) at 128 B, 512 B and 4 KB — a size is skipped once the
//      previous one is already expensive, since a dense high-degree pattern would not finish at 4 KB — and prints
//      the 4 KB ratio to each reference;
//   3. runs the real `checkRegexSafety` on each fixture and prints the verdict, the refusing stage and the wall time.
// Run it on every architecture the budget must hold on (x64 and arm64, Windows / Linux / macOS) and with
// `node --regexp-interpret-all` for the no-JIT case; `.github/workflows/calibrate.yml` does that on the CI matrix.
// Usage: node scripts/regex-budget-calibration.mjs [--repeat N]
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const { build } = require("esbuild");

const repeat = Number(process.argv[process.argv.indexOf("--repeat") + 1] || 3);
const outDir = mkdtempSync(join(os.tmpdir(), "hm-calibrate-"));
const bundle = join(outDir, "signature.mjs");
await build({
  entryPoints: [fileURLToPath(new URL("../src/activation/signature.ts", import.meta.url))],
  bundle: true,
  platform: "node",
  format: "esm",
  outfile: bundle,
  logLevel: "silent",
});
const sig = await import(pathToFileURL(bundle).href);

// Mirrors regexSamples() in src/activation/signature.ts (not exported).
function regexSamples(source, size) {
  const literal = source.replace(/\\[dwsDWSbB]|[\\^$.*+?()[\]{}|]/g, "");
  const seed = literal.length > 0 ? literal : "a";
  return [
    "a".repeat(size),
    `${"a".repeat(size - 1)}!`,
    " ".repeat(size),
    "ab ".repeat(Math.ceil(size / 3)).slice(0, size),
    `${seed.repeat(Math.ceil(size / seed.length)).slice(0, size - 1)}\u0001`,
  ];
}
const passesFor = (size) => Math.max(1, Math.ceil(131_072 / (5 * size)));
const fmt = (ms) => (ms === null ? "—" : ms.toFixed(3));

// The first entry is the validator's own reference (REGEX_REFERENCE_SOURCE, a quadratic pattern of the accepted shape);
// the others are linear scans kept for comparison — their ratios shift ~3× between x64 and arm64.
const REFERENCES = [sig.REGEX_REFERENCE_SOURCE ?? "ref .*\\.x", "[a-z]!", "[a-z]{2,8}\\d"];
const ACCEPT = [
  "^npm\\s+(run\\s+)?test\\b", "rm\\s+-rf\\s+/", "git push.*--force", "(foo|bar)\\.ts$", "\\d+\\s+\\d+",
  "^[a-z]+\\s+[0-9]+", "^DROP TABLE", "(foo|bar)+\\s*=", "curl .* \\| (ba)?sh", "cat .*\\.env", "curl .*\\|.*sh",
  "sudo .* apt(-get)? .* install", "docker run .* --privileged", "rm -rf .*", "\\bpython[23]? .*\\.py\\b",
];
const REJECT = ["[a-z]+\\s+[0-9]+", "[a-z]+[0-9]*\\s+x", ".*\\.env.*", "echo .* > .*\\.env", "docker .* run .* -v .* /var/run/docker\\.sock", "a.*b.*c.*d\\.e", "a.*b.*c.*d.*e\\.f", "a.*b.*c.*d.*e.*f\\.g"];

const interpret = process.execArgv.includes("--regexp-interpret-all");
console.log(`node ${process.version} ${process.platform} ${os.arch()} ${os.cpus()[0]?.model ?? "?"} x${os.cpus().length} interpret-all=${interpret}`);
console.log(`constants: REGEX_BUDGET_MS=${sig.REGEX_BUDGET_MS} REGEX_BUDGET_RATIO=${sig.REGEX_BUDGET_RATIO} REGEX_BUDGET_ROUNDS=${sig.REGEX_BUDGET_ROUNDS} REGEX_STAGE_BYTES=${JSON.stringify(sig.REGEX_STAGE_BYTES)}`);

// The validator's reference is swept over its OWN samples (its seed sample is what makes it quadratic); the linear
// scans are swept over neutral samples so their numbers stay comparable with earlier calibrations.
const refSamples = (ref, size) => (ref === REFERENCES[0] ? regexSamples(ref, size) : regexSamples("x", size));
const refMs = {};
for (const size of [128, 512, 4096]) {
  for (const ref of REFERENCES) {
    refMs[`${ref}@${size}`] = sig.fastestSweepMs(new RegExp(ref), refSamples(ref, size), { passes: ref === REFERENCES[0] ? 1 : passesFor(size) });
  }
}
console.log("\nreference sweeps (ms per sweep, quick):");
for (const ref of REFERENCES) console.log(`  ${ref.padEnd(32)} 128B=${refMs[`${ref}@128`].toFixed(5)} 512B=${refMs[`${ref}@512`].toFixed(4)} 4096B=${refMs[`${ref}@4096`].toFixed(4)}`);
console.log(`validator's own quick reference: 128B=${sig.referenceSweepMs(128).toFixed(5)} 512B=${sig.referenceSweepMs(512).toFixed(4)} 4096B=${sig.referenceSweepMs(4096).toFixed(4)}`);

// Raw sweeps: 128 B always; 512 B unless 128 B already costs > 1 ms; 4 KB unless 512 B costs > 5 ms.
console.log(`\n${"kind".padEnd(6)} ${"pattern".padEnd(44)} ${"128B ms".padStart(8)} ${"512B ms".padStart(8)} ${"4KB ms".padStart(9)} ${REFERENCES.map((ref) => `4KB x[${ref}]`.padStart(20)).join("")}`);
const rows = [...ACCEPT.map((p) => ["accept", p]), ...REJECT.map((p) => ["reject", p])];
for (const [kind, source] of rows) {
  const regex = new RegExp(source);
  const ms128 = sig.fastestSweepMs(regex, regexSamples(source, 128), { rounds: 5 });
  // A quadratic pattern costs ≤ 0.7 ms at 512 B; anything above 5 ms there is of a higher degree and would take
  // minutes at 4 KB (a dense quartic took 105 s), so the larger sizes are skipped once the smaller one is expensive.
  const ms512 = ms128 > 1 ? null : sig.fastestSweepMs(regex, regexSamples(source, 512), { rounds: 5 });
  const ms4 = ms512 === null || ms512 > 5 ? null : sig.fastestSweepMs(regex, regexSamples(source, 4096), { rounds: 5 });
  const ratios = REFERENCES.map((ref) => (ms4 === null ? "—" : (ms4 / refMs[`${ref}@4096`]).toFixed(ms4 / refMs[`${ref}@4096`] < 10 ? 2 : 0)).padStart(20));
  console.log(`${kind.padEnd(6)} ${source.padEnd(44)} ${fmt(ms128).padStart(8)} ${fmt(ms512).padStart(8)} ${fmt(ms4).padStart(9)} ${ratios.join("")}`);
}

console.log("\nreal checkRegexSafety (verdict, refusing stage, wall ms per run):");
let unexpected = 0;
for (const [kind, source] of rows) {
  const runs = [];
  for (let i = 0; i < repeat; i += 1) {
    const started = performance.now();
    const result = sig.checkRegexSafety(source);
    runs.push({ ms: performance.now() - started, result });
  }
  const bad = runs.some((run) => (kind === "accept") !== run.result.ok);
  if (bad) unexpected += 1;
  const cells = runs.map((run) => `${(run.result.ok ? "ok" : run.result.detail.replace(/^exceeded the budget on a /, "").replace(/ B sample:.*$/, "B")).padStart(6)} ${run.ms.toFixed(1).padStart(7)}`);
  console.log(`${kind.padEnd(6)} ${source.padEnd(44)} ${cells.join(" |")}${bad ? "  <-- UNEXPECTED" : ""}`);
  const last = runs[runs.length - 1].result;
  if (!last.ok) console.log(`       ${last.detail}`);
}
console.log(`\n${unexpected === 0 ? "all verdicts as expected" : `${unexpected} pattern(s) with an unexpected verdict`}`);
rmSync(outDir, { recursive: true, force: true });
process.exitCode = unexpected === 0 ? 0 : 1;
