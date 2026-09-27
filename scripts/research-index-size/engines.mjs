// Candidate engines. Each: built(), beginBuild() -> { add(id, chunk), finish() }, indexBytes(), open() -> search(query).
import { existsSync, statSync } from "node:fs";
import { dataPath, openDb } from "./common.mjs";
import { decompress, matchBytes, storePath } from "./store.mjs";

/** Verify a list of chunk ids (or every chunk) by decompressing and byte-matching. */
function verifier(chunkChars, level) {
  const store = openDb(storePath(chunkChars, level), { readOnly: true });
  const byId = store.prepare("SELECT doc_id, text, layout FROM chunks WHERE id = ?");
  const all = store.prepare("SELECT doc_id, text, layout FROM chunks");
  return {
    all(needle, out) {
      let chunks = 0, bytes = 0;
      for (const row of all.iterate()) { const raw = decompress(row.text); chunks++; bytes += raw.length; matchBytes(row.doc_id, raw, row.layout, needle, out); }
      return { verifiedChunks: chunks, verifiedMiB: +(bytes / 2 ** 20).toFixed(1) };
    },
    ids(ids, needle, out) {
      let bytes = 0;
      for (const id of ids) { const row = byId.get(id); const raw = decompress(row.text); bytes += raw.length; matchBytes(row.doc_id, raw, row.layout, needle, out); }
      return { verifiedChunks: ids.length, verifiedMiB: +(bytes / 2 ** 20).toFixed(1) };
    },
  };
}

// 1. No content index: decompress and scan every chunk.
const scan = {
  built: () => true,
  open(chunkChars, level) {
    const verify = verifier(chunkChars, level);
    return query => { const keys = []; const stats = verify.all(Buffer.from(query, "utf8"), keys); return { keys, stats }; };
  },
};

// 2. Positionless trigram per chunk (Russ Cox code search, at chunk granularity), plus 1/2-character tokens.
const codepoints = value => [...value];
const hex = value => value.codePointAt(0).toString(16);
function shortTokens(text) {
  const chars = codepoints(text), uni = new Set(), bi = new Set();
  for (let i = 0; i < chars.length; i++) {
    uni.add(`u${hex(chars[i])}`);
    if (i + 1 < chars.length) bi.add(`b${hex(chars[i])}x${hex(chars[i + 1])}`);
  }
  return { uni: [...uni].join(" "), bi: [...bi].join(" ") };
}
const triPath = chunkChars => dataPath(`index-tri-${chunkChars}.db`);
const shortPath = chunkChars => dataPath(`index-short-${chunkChars}.db`);
const quote = value => `"${value.replaceAll('"', '""')}"`;

function trigramEngine(useShortTables) {
  return {
    built: chunkChars => existsSync(triPath(chunkChars)) && existsSync(shortPath(chunkChars)),
    beginBuild(chunkChars) {
      const tri = openDb(triPath(chunkChars));
      tri.exec("CREATE VIRTUAL TABLE tri USING fts5(text, content='', detail=none, tokenize='trigram case_sensitive 1')");
      const short = openDb(shortPath(chunkChars));
      short.exec(`CREATE VIRTUAL TABLE uni USING fts5(text, content='', detail=none, tokenize='unicode61 remove_diacritics 0');
        CREATE VIRTUAL TABLE bi USING fts5(text, content='', detail=none, tokenize='unicode61 remove_diacritics 0');`);
      const insTri = tri.prepare("INSERT INTO tri(rowid, text) VALUES (?, ?)");
      const insUni = short.prepare("INSERT INTO uni(rowid, text) VALUES (?, ?)");
      const insBi = short.prepare("INSERT INTO bi(rowid, text) VALUES (?, ?)");
      tri.exec("BEGIN"); short.exec("BEGIN");
      return {
        add(id, chunk) {
          insTri.run(id, chunk.text);
          const tokens = shortTokens(chunk.text);
          insUni.run(id, tokens.uni);
          if (tokens.bi) insBi.run(id, tokens.bi);
        },
        finish() {
          for (const db of [tri, short]) { db.exec("COMMIT"); db.exec("INSERT INTO " + (db === tri ? "tri(tri)" : "uni(uni)") + " VALUES ('optimize')"); }
          short.exec("INSERT INTO bi(bi) VALUES ('optimize')");
          tri.exec("VACUUM"); short.exec("VACUUM"); tri.close(); short.close();
          return {};
        },
      };
    },
    indexBytes: chunkChars => statSync(triPath(chunkChars)).size + (useShortTables ? statSync(shortPath(chunkChars)).size : 0),
    open(chunkChars, level) {
      const verify = verifier(chunkChars, level);
      const tri = openDb(triPath(chunkChars), { readOnly: true });
      const short = openDb(shortPath(chunkChars), { readOnly: true });
      const triQuery = tri.prepare("SELECT rowid AS id FROM tri WHERE tri MATCH ? ORDER BY rowid");
      const uniQuery = short.prepare("SELECT rowid AS id FROM uni WHERE uni MATCH ? ORDER BY rowid");
      const biQuery = short.prepare("SELECT rowid AS id FROM bi WHERE bi MATCH ? ORDER BY rowid");
      return query => {
        const keys = [], needle = Buffer.from(query, "utf8"), chars = codepoints(query);
        let ids = null, strategy;
        if (chars.length >= 3 && !query.includes("\u0000")) {
          const grams = new Set();
          for (let i = 0; i + 3 <= chars.length; i++) grams.add(chars.slice(i, i + 3).join(""));
          ids = triQuery.all([...grams].map(quote).join(" AND ")).map(r => r.id); strategy = "trigram";
        } else if (useShortTables && chars.length === 1 && !query.includes("\u0000")) {
          ids = uniQuery.all(quote(`u${hex(chars[0])}`)).map(r => r.id); strategy = "unigram";
        } else if (useShortTables && chars.length === 2 && !query.includes("\u0000")) {
          ids = biQuery.all(quote(`b${hex(chars[0])}x${hex(chars[1])}`)).map(r => r.id); strategy = "bigram";
        }
        const stats = ids ? verify.ids(ids, needle, keys) : verify.all(needle, keys);
        return { keys, stats: { strategy: strategy ?? "scan", ...stats } };
      };
    },
  };
}

// 3. Sparse grams per chunk (GitHub code search): every trigram plus longer grams whose two boundary
// bigrams weigh strictly less than every interior bigram. Grams are hashed into FTS5 detail=none tokens.
const MAX_GRAM = 32;
function bigramWeight(a, b) {
  let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b ^ 0xc2b2ae35, 0x27d4eb2f);
  h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d); h ^= h >>> 12;
  return h >>> 0;
}
function gramToken(chars, start, end) {
  // 53-bit FNV-style hash of the code points; collisions only add verified candidates.
  let hi = 0x811c9dc5, lo = 0x01000193;
  for (let i = start; i < end; i++) { const c = chars[i]; hi = Math.imul(hi ^ c, 0x01000193) >>> 0; lo = Math.imul(lo ^ c, 0x5bd1e995) >>> 0; }
  return `g${hi.toString(36)}${(lo & 0x1fffff).toString(36)}`;
}
/** Sparse grams of a code point array as [start, end) ranges; `maximalOnly` keeps grams not inside another. */
function sparseGrams(chars, maximalOnly) {
  const n = chars.length - 1; // bigram count; bigram i covers chars i, i+1
  if (n < 2) return [];
  const w = new Array(n);
  for (let i = 0; i < n; i++) w[i] = bigramWeight(chars[i], chars[i + 1]);
  const grams = [];
  for (let i = 0; i + 1 < n; i++) {
    // Trigram: bigrams i and i+1, no interior.
    grams.push([i, i + 3]);
    let interiorMin = Infinity;
    for (let j = i + 2; j < n && j - i + 2 <= MAX_GRAM; j++) {
      interiorMin = Math.min(interiorMin, w[j - 1]);
      if (w[i] >= interiorMin) break; // left boundary no longer below every interior bigram
      if (w[j] < interiorMin) grams.push([i, j + 2]);
    }
  }
  if (!maximalOnly) return grams;
  return grams.filter(([s, e]) => !grams.some(([s2, e2]) => (s2 <= s && e <= e2) && (s2 !== s || e2 !== e)));
}
const sparsePath = chunkChars => dataPath(`index-sparse-${chunkChars}.db`);
const toCodes = value => [...value].map(c => c.codePointAt(0));

const sparse = {
  built: chunkChars => existsSync(sparsePath(chunkChars)) && existsSync(shortPath(chunkChars)),
  beginBuild(chunkChars) {
    const db = openDb(sparsePath(chunkChars));
    db.exec("CREATE VIRTUAL TABLE grams USING fts5(text, content='', detail=none, tokenize='unicode61 remove_diacritics 0')");
    const insert = db.prepare("INSERT INTO grams(rowid, text) VALUES (?, ?)");
    db.exec("BEGIN");
    let tokens = 0;
    return {
      add(id, chunk) {
        const chars = toCodes(chunk.text), set = new Set();
        for (const [s, e] of sparseGrams(chars, false)) set.add(gramToken(chars, s, e));
        tokens += set.size;
        insert.run(id, [...set].join(" "));
      },
      finish() {
        db.exec("COMMIT"); db.exec("INSERT INTO grams(grams) VALUES ('optimize')"); db.exec("VACUUM"); db.close();
        return { distinctGramsPerChunkTotal: tokens };
      },
    };
  },
  indexBytes: chunkChars => statSync(sparsePath(chunkChars)).size + statSync(shortPath(chunkChars)).size,
  open(chunkChars, level) {
    const verify = verifier(chunkChars, level);
    const db = openDb(sparsePath(chunkChars), { readOnly: true });
    const short = openDb(shortPath(chunkChars), { readOnly: true });
    const gramQuery = db.prepare("SELECT rowid AS id FROM grams WHERE grams MATCH ? ORDER BY rowid");
    const uniQuery = short.prepare("SELECT rowid AS id FROM uni WHERE uni MATCH ? ORDER BY rowid");
    const biQuery = short.prepare("SELECT rowid AS id FROM bi WHERE bi MATCH ? ORDER BY rowid");
    return query => {
      const keys = [], needle = Buffer.from(query, "utf8"), chars = toCodes(query);
      let ids = null, strategy = "scan", grams = 0;
      if (chars.length >= 3) {
        const tokens = new Set(sparseGrams(chars, true).map(([s, e]) => gramToken(chars, s, e)));
        grams = tokens.size;
        ids = gramQuery.all([...tokens].map(quote).join(" AND ")).map(r => r.id); strategy = "sparse";
      } else if (chars.length === 1) {
        ids = uniQuery.all(quote(`u${chars[0].toString(16)}`)).map(r => r.id); strategy = "unigram";
      } else if (chars.length === 2) {
        ids = biQuery.all(quote(`b${chars[0].toString(16)}x${chars[1].toString(16)}`)).map(r => r.id); strategy = "bigram";
      }
      const stats = ids ? verify.ids(ids, needle, keys) : verify.all(needle, keys);
      return { keys, stats: { strategy, grams, ...stats } };
    };
  },
};

export const engines = { scan, trigram: trigramEngine(true), "trigram-scanshort": trigramEngine(false), sparse };
