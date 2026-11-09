/**
 * `snapshot/dense.v1.bin` codec (spec §4.8): 4-byte little-endian header length, UTF-8 JSON
 * `DenseSnapshotHeader`, then a Float32 little-endian matrix of `ids.length × dims`. Written by the
 * snapshot builder (worker), read by the embedding helper. Shared here so both sides agree byte for byte.
 */

import { readFileSync, statSync } from "node:fs";

import { DENSE_SNAPSHOT_SCHEMA, type DenseSnapshotHeader } from "../core/snapshot-types";

export interface DenseMatrix {
  header: DenseSnapshotHeader;
  /** Row-major `rows × dims`. */
  data: Float32Array;
  rows: number;
  dims: number;
  /** L2 norm of every row (0 for an all-zero row). */
  norms: Float32Array;
  mtimeMs: number | null;
}

const HEADER_LENGTH_BYTES = 4;

export function encodeDenseSnapshot(header: DenseSnapshotHeader, vectors: readonly ArrayLike<number>[]): Buffer {
  if (vectors.length !== header.ids.length) {
    throw new Error(`dense snapshot: ${vectors.length} vectors for ${header.ids.length} ids`);
  }
  const headerJson = Buffer.from(JSON.stringify(header), "utf8");
  const matrix = Buffer.alloc(vectors.length * header.dims * 4);
  let offset = 0;
  for (const vector of vectors) {
    if (vector.length !== header.dims) throw new Error(`dense snapshot: vector of ${vector.length} dims, header says ${header.dims}`);
    for (let index = 0; index < header.dims; index += 1) {
      matrix.writeFloatLE(vector[index] ?? 0, offset);
      offset += 4;
    }
  }
  const lengthPrefix = Buffer.alloc(HEADER_LENGTH_BYTES);
  lengthPrefix.writeUInt32LE(headerJson.length, 0);
  return Buffer.concat([lengthPrefix, headerJson, matrix]);
}

function isHeader(value: unknown): value is DenseSnapshotHeader {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    record.schema === DENSE_SNAPSHOT_SCHEMA &&
    typeof record.dims === "number" &&
    Number.isInteger(record.dims) &&
    record.dims > 0 &&
    Array.isArray(record.ids) &&
    record.ids.every((id) => typeof id === "string") &&
    typeof record.model === "string"
  );
}

export function decodeDenseSnapshot(buffer: Buffer, mtimeMs: number | null = null): DenseMatrix | null {
  if (buffer.length < HEADER_LENGTH_BYTES) return null;
  const headerLength = buffer.readUInt32LE(0);
  const headerEnd = HEADER_LENGTH_BYTES + headerLength;
  if (headerEnd > buffer.length) return null;
  let header: unknown;
  try {
    header = JSON.parse(buffer.subarray(HEADER_LENGTH_BYTES, headerEnd).toString("utf8"));
  } catch {
    return null;
  }
  if (!isHeader(header)) return null;
  const rows = header.ids.length;
  const dims = header.dims;
  const expectedBytes = rows * dims * 4;
  if (buffer.length - headerEnd < expectedBytes) return null;

  // Copy into an aligned ArrayBuffer; a Buffer slice may start at any byte offset.
  const aligned = new ArrayBuffer(expectedBytes);
  new Uint8Array(aligned).set(buffer.subarray(headerEnd, headerEnd + expectedBytes));
  const data = new Float32Array(aligned);
  const norms = new Float32Array(rows);
  for (let row = 0; row < rows; row += 1) {
    let sum = 0;
    const base = row * dims;
    for (let index = 0; index < dims; index += 1) {
      const value = data[base + index]!;
      sum += value * value;
    }
    norms[row] = Math.sqrt(sum);
  }
  return { header, data, rows, dims, norms, mtimeMs };
}

/** Null when the file is missing or malformed. */
export function readDenseSnapshot(path: string): DenseMatrix | null {
  try {
    const stat = statSync(path);
    return decodeDenseSnapshot(readFileSync(path), stat.mtimeMs);
  } catch {
    return null;
  }
}

export interface DenseTopK {
  ids: string[];
  scores: number[];
}

/** Cosine similarity against every row; ties broken by row order. Rows with a zero norm never match. */
export function denseTopK(matrix: DenseMatrix, query: ArrayLike<number>, k: number): DenseTopK {
  if (query.length !== matrix.dims || k <= 0 || matrix.rows === 0) return { ids: [], scores: [] };
  let queryNorm = 0;
  for (let index = 0; index < query.length; index += 1) queryNorm += query[index]! * query[index]!;
  queryNorm = Math.sqrt(queryNorm);
  if (queryNorm === 0) return { ids: [], scores: [] };

  const scored: Array<{ row: number; score: number }> = [];
  for (let row = 0; row < matrix.rows; row += 1) {
    const norm = matrix.norms[row]!;
    if (norm === 0) continue;
    let dot = 0;
    const base = row * matrix.dims;
    for (let index = 0; index < matrix.dims; index += 1) dot += matrix.data[base + index]! * query[index]!;
    scored.push({ row, score: dot / (norm * queryNorm) });
  }
  scored.sort((left, right) => (right.score !== left.score ? right.score - left.score : left.row - right.row));
  const top = scored.slice(0, k);
  return { ids: top.map((entry) => matrix.header.ids[entry.row]!), scores: top.map((entry) => entry.score) };
}
