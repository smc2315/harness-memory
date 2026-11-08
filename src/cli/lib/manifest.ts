/**
 * `.harness-memory/install-manifest.json` (spec §8.7): what `install` touched, with hashes, so that
 * `uninstall` removes exactly those entries and `doctor` can compare the manifest with reality.
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type { HookForm, HookShell } from "./settings";

export const MANIFEST_SCHEMA = "install-manifest.v1";

export type ManifestFileRole = "settings" | "config" | "git_exclude" | "hook_script" | "worker_script";

export interface ManifestFile {
  path: string;
  role: ManifestFileRole;
  /** sha256 of the file right after install; null when the file did not exist (e.g. hook script missing). */
  sha256: string | null;
  /** True when install created the file (uninstall may delete it when it becomes empty). */
  created: boolean;
}

export interface InstallManifest {
  schema: typeof MANIFEST_SCHEMA;
  version: string;
  installed_at: string;
  host: "claude";
  scope: "project" | "user";
  root: string;
  node: string;
  hook_script: string;
  hook_form: HookForm;
  shell: HookShell | null;
  settings_file: string;
  /** Claude Code event names registered (`SessionStart`, …). */
  events: string[];
  claude_version: string | null;
  git_exclude: { path: string; line: string; added: boolean } | null;
  files: ManifestFile[];
}

export function isInstallManifest(value: unknown): value is InstallManifest {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    record.schema === MANIFEST_SCHEMA &&
    typeof record.version === "string" &&
    typeof record.root === "string" &&
    typeof record.node === "string" &&
    typeof record.hook_script === "string" &&
    typeof record.settings_file === "string" &&
    Array.isArray(record.events) &&
    Array.isArray(record.files)
  );
}

export function readManifest(file: string): InstallManifest | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    return isInstallManifest(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function writeManifest(file: string, manifest: InstallManifest): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${String(process.pid)}`;
  writeFileSync(tmp, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  renameSync(tmp, file);
}

export function sha256File(file: string): string | null {
  try {
    return createHash("sha256").update(readFileSync(file)).digest("hex");
  } catch {
    return null;
  }
}

export function sha256Text(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}
