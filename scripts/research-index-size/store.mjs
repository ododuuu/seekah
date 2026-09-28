// Chunk store shared by all engines: normalized UTF-8 chunk text (zstd) + byte offsets of blocks.
import { existsSync, rmSync, statSync } from "node:fs";
import { zstdCompressSync, zstdDecompressSync, constants } from "node:zlib";
import { chunkDocument, corpusDocuments, dataPath, openDb } from "./common.mjs";

export function storePath(chunkChars, level) { return dataPath(`store-${chunkChars}-z${level}.db`); }

function varints(values) {
  const bytes = [];
  for (const v0 of values) { let v = v0; while (v > 127) { bytes.push((v & 127) | 128); v >>>= 7; } bytes.push(v); }
  return Buffer.from(bytes);
}
export function unvarints(buffer) {
  const out = []; let offset = 0;
  while (offset < buffer.length) { let v = 0, s = 0, b; do { b = buffer[offset++]; v |= (b & 127) << s; s += 7; } while (b & 128); out.push(v >>> 0); }
  return out;
}

/** Build chunks(id, doc_id, text zstd, layout varints[count, (byteStartDelta, ordinalDelta)*]). Calls onChunk(id, chunk) for index builders. */
export function buildStore(chunkChars, level, onChunk) {
  const file = storePath(chunkChars, level);
  if (existsSync(file)) rmSync(file);
  const store = openDb(file);
  store.exec("CREATE TABLE chunks(id INTEGER PRIMARY KEY, doc_id INTEGER NOT NULL, text BLOB NOT NULL, layout BLOB NOT NULL)");
  const insert = store.prepare("INSERT INTO chunks(id, doc_id, text, layout) VALUES (?, ?, ?, ?)");
  const corpus = openDb(dataPath("corpus.db"), { readOnly: true });
  let id = 0, rawBytes = 0;
  store.exec("BEGIN");
  for (const document of corpusDocuments(corpus)) {
    for (const chunk of chunkDocument(document, chunkChars)) {
      id++;
      const raw = Buffer.from(chunk.text, "utf8");
      rawBytes += raw.length;
      // Byte offsets of each block start, for block-boundary checks on UTF-8.
      const layout = [chunk.starts.length];
      let previousOrdinal = 0, previousLength = 0;
      for (let i = 0; i < chunk.starts.length; i++) {
        // Byte length of the previous block plus its "\n" separator.
        const delta = i ? Buffer.byteLength(chunk.text.slice(chunk.starts[i - 1], chunk.starts[i])) : 0;
        layout.push(delta, chunk.ordinals[i] - previousOrdinal + (i ? 0 : 1));
        previousOrdinal = chunk.ordinals[i]; previousLength = delta;
      }
      insert.run(id, chunk.docId, zstdCompressSync(raw, { params: { [constants.ZSTD_c_compressionLevel]: level } }), varints(layout));
      onChunk?.(id, chunk);
      if (id % 2000 === 0) { store.exec("COMMIT; BEGIN"); }
    }
  }
  store.exec("COMMIT");
  store.exec("VACUUM");
  store.close();
  return { file, chunks: id, rawBytes, fileBytes: statSync(file).size };
}

/** Decode a layout into byte starts and ordinals. */
export function decodeLayout(layout) {
  const v = unvarints(layout);
  const count = v[0], starts = new Array(count), ordinals = new Array(count);
  let byte = 0, ordinal = -1;
  for (let i = 0; i < count; i++) { byte += v[1 + 2 * i]; ordinal += v[2 + 2 * i]; starts[i] = byte; ordinals[i] = ordinal; }
  return { starts, ordinals };
}

/** Matching block keys in one chunk (UTF-8 bytes); one hit per block, never across a block boundary. */
export function matchBytes(docId, raw, layout, needle, out) {
  let from = 0, decoded = null, block = 0;
  while (true) {
    const at = raw.indexOf(needle, from);
    if (at < 0) return;
    decoded ??= decodeLayout(layout);
    const { starts, ordinals } = decoded;
    while (block + 1 < starts.length && starts[block + 1] <= at) block++;
    const end = block + 1 < starts.length ? starts[block + 1] - 1 : raw.length;
    if (at + needle.length <= end) {
      out.push(`${docId}:${ordinals[block]}`);
      if (block + 1 >= starts.length) return;
      from = starts[block + 1]; block++;
    } else from = at + 1;
  }
}

export function decompress(blob) { return zstdDecompressSync(blob); }
