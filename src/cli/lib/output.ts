/**
 * Text / JSON output for the CLI. Every command computes a plain result object and hands it to
 * `Printer.result(value, render)`: `--json` prints the object as one JSON document, otherwise the
 * renderer's lines go to stdout. Diagnostics always go to stderr so `--json` stays parseable.
 */

export interface CliStreams {
  stdout(text: string): void;
  stderr(text: string): void;
}

export const processStreams: CliStreams = {
  stdout: (text) => {
    process.stdout.write(text);
  },
  stderr: (text) => {
    process.stderr.write(text);
  },
};

export class Printer {
  constructor(
    private readonly streams: CliStreams,
    readonly json: boolean
  ) {}

  /** The command's one result: JSON document in `--json` mode, rendered text lines otherwise. */
  result<T>(value: T, render: (value: T) => readonly string[]): void {
    if (this.json) {
      this.streams.stdout(`${JSON.stringify(value, null, 2)}\n`);
      return;
    }
    const lines = render(value);
    if (lines.length > 0) this.streams.stdout(`${lines.join("\n")}\n`);
  }

  /** Plain text that is only meaningful in text mode (progress, hints). Suppressed under `--json`. */
  line(text: string): void {
    if (!this.json) this.streams.stdout(`${text}\n`);
  }

  warn(text: string): void {
    this.streams.stderr(`warning: ${text}\n`);
  }

  error(text: string): void {
    this.streams.stderr(`error: ${text}\n`);
  }

  /** Raw stderr line (usage text, hints). */
  note(text: string): void {
    this.streams.stderr(`${text}\n`);
  }
}

const UNITS_MS: Array<[number, string]> = [
  [365 * 24 * 60 * 60 * 1000, "y"],
  [30 * 24 * 60 * 60 * 1000, "mo"],
  [24 * 60 * 60 * 1000, "d"],
  [60 * 60 * 1000, "h"],
  [60 * 1000, "m"],
  [1000, "s"],
];

/** `2h ago`, `in 3d`, `just now`; `never` for null and `?` for an unparseable stamp. */
export function formatRelative(iso: string | null | undefined, nowMs: number): string {
  if (iso === null || iso === undefined) return "never";
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return "?";
  const delta = nowMs - then;
  const abs = Math.abs(delta);
  if (abs < 5_000) return "just now";
  for (const [size, unit] of UNITS_MS) {
    if (abs >= size) {
      const count = Math.floor(abs / size);
      return delta >= 0 ? `${count}${unit} ago` : `in ${count}${unit}`;
    }
  }
  return "just now";
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "?";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatMs(ms: number | null): string {
  return ms === null ? "-" : `${Math.round(ms)}ms`;
}

/** Fixed-width table; `header` is optional, columns are left-aligned, no trailing spaces. */
export function renderTable(rows: readonly (readonly string[])[], header?: readonly string[]): string[] {
  const all = header === undefined ? rows : [header, ...rows];
  const widths: number[] = [];
  for (const row of all) {
    row.forEach((cell, index) => {
      widths[index] = Math.max(widths[index] ?? 0, cell.length);
    });
  }
  const render = (row: readonly string[]): string =>
    row
      .map((cell, index) => (index === row.length - 1 ? cell : cell.padEnd(widths[index] ?? cell.length)))
      .join("  ")
      .trimEnd();
  const lines = all.map(render);
  if (header !== undefined && rows.length > 0) {
    lines.splice(1, 0, widths.map((width) => "-".repeat(width)).join("  "));
  }
  return lines;
}

export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}
