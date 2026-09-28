import { constants, zstdCompressSync, zstdDecompressSync } from "node:zlib";
import type { TextBlock } from "./model.js";

/** Chunks close before exceeding this many UTF-16 units; a single larger block owns its chunk (SPEC §52.1). */
export const CHUNK_TARGET_UNITS = 65_536;

export interface BuiltChunk {
  /** Ordinal of the chunk's first block, so the chunk holding block N is the last one starting at or before N. */
  ordinal: number;
  /** zstd-compressed UTF-8 of the original block contents joined by "\n". */
  text: Uint8Array;
  layout: Uint8Array;
  /** Per-block NFKC + lower case contents joined by "\n", for the chunk index. */
  normalized: string;
}

export interface BlockMeta {
  ordinal: number;
  heading: string | null;
  locationKind: TextBlock["locationKind"];
  locationValue: string;
}

export interface ChunkBlock {
  ordinal: number;
  content: string;
}

export const normalizeText = (value: string): string => value.normalize("NFKC").toLowerCase();

export function derivedLocation(ordinal: number): string {
  return `第 ${ordinal + 1} 行`;
}

/** Plain text lines carry no heading and a location equal to their ordinal; nothing needs storing. */
export function metadataDerivable(block: Pick<TextBlock, "ordinal" | "heading" | "locationKind" | "locationValue">): boolean {
  return block.locationKind === "line" && block.heading === null && block.locationValue === derivedLocation(block.ordinal);
}

function putVarint(bytes: number[], value: number): void {
  while (value > 127) { bytes.push((value & 127) | 128); value = Math.floor(value / 128); }
  bytes.push(value);
}

function readVarints(buffer: Uint8Array): number[] {
  const values: number[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    let value = 0, scale = 1, byte: number;
    do { byte = buffer[offset++]!; value += (byte & 127) * scale; scale *= 128; } while (byte & 128);
    values.push(value);
  }
  return values;
}

/** Split a document's blocks into chunks plus the metadata rows that cannot be derived. */
export function buildChunks(blocks: readonly TextBlock[]): { chunks: BuiltChunk[]; meta: BlockMeta[] } {
  const ordered = [...blocks].sort((a, b) => a.ordinal - b.ordinal);
  // A block ordinal identifies its location; duplicates must fail the whole write (the old UNIQUE constraint).
  for (let index = 1; index < ordered.length; index++) {
    if (ordered[index]!.ordinal === ordered[index - 1]!.ordinal) throw new Error(`段落序號重複：${ordered[index]!.ordinal}`);
  }
  const meta = ordered.filter(block => !metadataDerivable(block))
    .map(block => ({ ordinal: block.ordinal, heading: block.heading, locationKind: block.locationKind, locationValue: block.locationValue }));
  const chunks: BuiltChunk[] = [];
  let parts: string[] = [], normalized: string[] = [], layout: number[] = [], units = 0, previousOrdinal = 0, firstOrdinal = 0;
  const flush = () => {
    if (!parts.length) return;
    const bytes: number[] = [];
    putVarint(bytes, parts.length);
    for (const value of layout) putVarint(bytes, value);
    chunks.push({
      ordinal: firstOrdinal,
      text: zstdCompressSync(Buffer.from(parts.join("\n"), "utf8"), { params: { [constants.ZSTD_c_compressionLevel]: 3 } }),
      layout: Uint8Array.from(bytes),
      normalized: normalized.join("\n"),
    });
    parts = []; normalized = []; layout = []; units = 0;
  };
  for (const block of ordered) {
    if (!block.content) continue;
    if (parts.length && units + block.content.length > CHUNK_TARGET_UNITS) flush();
    // Start offset delta (UTF-16 units) from the previous block, then ordinal delta (first block: absolute).
    if (!parts.length) firstOrdinal = block.ordinal;
    const previousLength = parts.length ? parts[parts.length - 1]!.length + 1 : 0;
    layout.push(previousLength, parts.length ? block.ordinal - previousOrdinal : block.ordinal);
    parts.push(block.content);
    normalized.push(normalizeText(block.content));
    units += block.content.length + 1;
    previousOrdinal = block.ordinal;
  }
  flush();
  return { chunks, meta };
}

export function decodeLayout(layout: Uint8Array): { starts: number[]; ordinals: number[] } {
  const values = readVarints(layout);
  const count = values[0] ?? 0;
  const starts: number[] = new Array(count), ordinals: number[] = new Array(count);
  let start = 0, ordinal = 0;
  for (let index = 0; index < count; index++) {
    start += values[1 + 2 * index]!;
    ordinal = index ? ordinal + values[2 + 2 * index]! : values[2]!;
    starts[index] = start;
    ordinals[index] = ordinal;
  }
  return { starts, ordinals };
}

const ASCII = /^[\x00-\x7f]*$/u;

/** A chunk holds at most 64 Ki UTF-16 units (≤192 KiB UTF-8), so one 256 KiB output buffer avoids re-chunking (~30% faster). */
function decompressChunk(text: Uint8Array): string {
  return zstdDecompressSync(text, { chunkSize: 256 * 1024 }).toString("utf8");
}

/**
 * Ordinals of the blocks whose normalized content contains each term, as a
 * map term → ordinals (ascending). Equivalent to normalizing every block and
 * calling includes(), but first rejects the chunk on its normalized whole text
 * and, for ASCII chunks (normalization is 1:1 lower-casing), maps match offsets
 * straight to blocks. `firstOnly` stops at the first block per term.
 */
export function blocksContaining(text: Uint8Array, layout: Uint8Array, terms: readonly string[], firstOnly: boolean): Map<string, number[]> {
  const joined = decompressChunk(text);
  // NFKC leaves ASCII unchanged, so ASCII chunks only need lower-casing.
  const ascii = ASCII.test(joined);
  const normalizedJoined = ascii ? joined.toLowerCase() : normalizeText(joined);
  const wanted = terms.filter(term => normalizedJoined.includes(term));
  const hits = new Map<string, number[]>(terms.map(term => [term, []]));
  if (!wanted.length) return hits;
  const { starts, ordinals } = decodeLayout(layout);
  const endOf = (index: number) => index + 1 < starts.length ? starts[index + 1]! - 1 : joined.length;
  if (ascii) {
    for (const term of wanted) {
      const list = hits.get(term)!;
      let from = 0, block = 0;
      while (true) {
        const at = normalizedJoined.indexOf(term, from);
        if (at < 0) break;
        while (block + 1 < starts.length && starts[block + 1]! <= at) block++;
        if (at + term.length <= endOf(block)) {
          list.push(ordinals[block]!);
          if (firstOnly || block + 1 >= starts.length) break;
          from = starts[++block]!;
        } else from = at + 1;
      }
    }
    return hits;
  }
  for (let index = 0; index < starts.length; index++) {
    const content = normalizeText(joined.slice(starts[index], endOf(index)));
    for (const term of wanted) {
      const list = hits.get(term)!;
      if ((!firstOnly || !list.length) && content.includes(term)) list.push(ordinals[index]!);
    }
    if (firstOnly && wanted.every(term => hits.get(term)!.length)) break;
  }
  return hits;
}

/** Original block contents of one chunk, in ordinal order. */
export function decodeChunk(text: Uint8Array, layout: Uint8Array): ChunkBlock[] {
  const joined = decompressChunk(text);
  const { starts, ordinals } = decodeLayout(layout);
  return ordinals.map((ordinal, index) => ({
    ordinal,
    content: joined.slice(starts[index], index + 1 < starts.length ? starts[index + 1]! - 1 : joined.length),
  }));
}
