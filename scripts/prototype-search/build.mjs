// Build one prototype index from the read-only snapshot.
//   node build.mjs --variant fields|B|C1|C2 [--out file.db] [--limit N] [--batch-docs 50] [--batch-bytes 16777216]
// Resumable: every batch commits its rows together with built_docs markers, so a
// killed build continues where it stopped (see migration.mjs).
import { writeFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { brotliDecompressSync } from "node:zlib";
import {
  SnapshotReader, biTokens, dataDir, normalize, openSnapshot, openVariant, parseArgs, uniTokens, variantPaths,
} from "./common.mjs";

const args = parseArgs(process.argv.slice(2));
const variant = args.variant;
if (!["fields", "B", "C1", "C2"].includes(variant)) throw new Error("--variant fields|B|C1|C2");
const out = args.out ?? variantPaths[variant];
const limit = args.limit ? Number(args.limit) : Infinity;
const batchDocs = Number(args["batch-docs"] ?? 50);
const batchBytes = Number(args["batch-bytes"] ?? 16 * 1024 * 1024);

const fts = (name, tokenize, detail) => `CREATE VIRTUAL TABLE IF NOT EXISTS ${name} USING fts5(
  text, content='', contentless_delete=1, detail=${detail}, tokenize='${tokenize}');`;
const TRI = "trigram";
const WORD = "unicode61 remove_diacritics 0";
const schema = {
  fields: `CREATE TABLE IF NOT EXISTS heading_map(id INTEGER PRIMARY KEY, document_id INTEGER NOT NULL,
      min_ordinal INTEGER NOT NULL, heading TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS heading_map_document ON heading_map(document_id);
    ${fts("fname_tri", TRI, "none")} ${fts("fname_uni", WORD, "none")} ${fts("fname_bi", WORD, "none")}
    ${fts("head_tri", TRI, "none")} ${fts("head_uni", WORD, "none")} ${fts("head_bi", WORD, "none")}`,
  B: `CREATE TABLE IF NOT EXISTS pay_rows(id INTEGER PRIMARY KEY, document_id INTEGER NOT NULL,
      payload_ordinal INTEGER NOT NULL, kind INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS pay_rows_document ON pay_rows(document_id);
    ${fts("pay_tri", TRI, "none")} ${fts("pay_uni", WORD, "none")}`,
  C1: `${fts("content_tri", TRI, "none")} ${fts("content_uni", WORD, "none")} ${fts("content_bi", WORD, "none")}`,
  C2: `${fts("content_tri_full", TRI, "full")} ${fts("content_uni_full", WORD, "full")}`,
};

const snapshot = openSnapshot();
const reader = new SnapshotReader(snapshot);
const db = openVariant(out, { readOnly: false });
db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA cache_size = -262144;");
db.exec(`${schema[variant]} CREATE TABLE IF NOT EXISTS built_docs(document_id INTEGER PRIMARY KEY);
  CREATE TABLE IF NOT EXISTS build_runs(started_at TEXT, finished_at TEXT, documents INTEGER, ms REAL);`);

const insert = name => db.prepare(`INSERT INTO ${name}(rowid, text) VALUES (?, ?)`);
const marker = db.prepare("INSERT INTO built_docs(document_id) VALUES (?)");
const done = new Set(db.prepare("SELECT document_id FROM built_docs").all().map(row => Number(row.document_id)));

const documentSql = variant === "fields"
  ? "SELECT id, filename FROM documents ORDER BY id"
  : "SELECT d.id, d.filename FROM documents d WHERE EXISTS (SELECT 1 FROM document_payloads p WHERE p.document_id = d.id) ORDER BY d.id";
// --limit selects a fixed prefix of the document list, so a resumed run finishes the same set.
const documents = snapshot.prepare(documentSql).all().slice(0, limit).filter(row => !done.has(Number(row.id)));

const timings = { readDecodeMs: 0, normalizeMs: 0, insertMs: 0, commitMs: 0 };
const counts = { documents: 0, rows: 0, textChars: 0, alreadyDone: done.size };

const writers = {
  fields() {
    const fnTri = insert("fname_tri"), fnUni = insert("fname_uni"), fnBi = insert("fname_bi");
    const hTri = insert("head_tri"), hUni = insert("head_uni"), hBi = insert("head_bi");
    const headings = snapshot.prepare(`SELECT heading, min(ordinal) AS ordinal FROM blocks
      WHERE document_id = ? AND heading IS NOT NULL AND heading != '' GROUP BY heading ORDER BY ordinal`);
    const map = db.prepare("INSERT INTO heading_map(document_id, min_ordinal, heading) VALUES (?, ?, ?)");
    return document => {
      let started = performance.now();
      const rows = headings.all(document.id);
      timings.readDecodeMs += performance.now() - started;
      started = performance.now();
      const name = normalize(document.filename);
      const values = rows.map(row => ({ ...row, normalized: normalize(row.heading) }));
      timings.normalizeMs += performance.now() - started;
      started = performance.now();
      fnTri.run(document.id, name); fnUni.run(document.id, uniTokens(name, true)); fnBi.run(document.id, biTokens(name, true));
      for (const row of values) {
        const id = Number(map.run(document.id, row.ordinal, row.heading).lastInsertRowid);
        hTri.run(id, row.normalized); hUni.run(id, uniTokens(row.normalized, true)); hBi.run(id, biTokens(row.normalized, true));
      }
      timings.insertMs += performance.now() - started;
      counts.rows += 1 + values.length;
      counts.textChars += name.length + values.reduce((sum, row) => sum + row.normalized.length, 0);
      return name.length;
    };
  },
  B() {
    const tri = insert("pay_tri"), uni = insert("pay_uni");
    const row = db.prepare("INSERT INTO pay_rows(document_id, payload_ordinal, kind) VALUES (?, ?, ?)");
    const headings = snapshot.prepare("SELECT id, heading FROM blocks WHERE document_id = ?");
    const payloads = snapshot.prepare("SELECT ordinal, payload FROM document_payloads WHERE document_id = ? ORDER BY ordinal");
    const add = (documentId, ordinal, kind, text) => {
      const id = Number(row.run(documentId, ordinal, kind).lastInsertRowid);
      tri.run(id, text); uni.run(id, uniTokens(text, true));
      counts.rows++; counts.textChars += text.length;
    };
    return document => {
      let started = performance.now();
      const headingById = new Map(headings.all(document.id).map(item => [item.id, item.heading]));
      const decoded = payloads.all(document.id).map(payload => ({ ordinal: payload.ordinal,
        fragments: JSON.parse(brotli(payload.payload)) }));
      timings.readDecodeMs += performance.now() - started;
      let bytes = 0;
      for (let index = 0; index < decoded.length; index++) {
        started = performance.now();
        const { ordinal, fragments } = decoded[index];
        const byBlock = new Map();
        for (const [id, text] of fragments) byBlock.set(id, (byBlock.get(id) ?? "") + text);
        const parts = [];
        for (const [id, text] of byBlock) {
          const heading = headingById.get(id);
          if (heading) parts.push(normalize(heading));
          parts.push(normalize(text));
        }
        const text = parts.join("\n");
        // A block continuing into the next payload: index the few characters on
        // both sides so grams straddling the split are still findable.
        const next = decoded[index + 1];
        const last = fragments.at(-1);
        const boundary = next && last && next.fragments[0]?.[0] === last[0]
          ? normalize([...last[1]].slice(-8).join("") + [...next.fragments[0][1]].slice(0, 8).join("")) : undefined;
        timings.normalizeMs += performance.now() - started;
        started = performance.now();
        add(document.id, ordinal, 0, text);
        if (boundary !== undefined) add(document.id, ordinal, 1, boundary);
        timings.insertMs += performance.now() - started;
        bytes += text.length;
      }
      return bytes;
    };
  },
  C1() {
    const tri = insert("content_tri"), uni = insert("content_uni"), bi = insert("content_bi");
    return contentWriter((id, text) => { tri.run(id, text); uni.run(id, uniTokens(text, true)); bi.run(id, biTokens(text, true)); });
  },
  C2() {
    const tri = insert("content_tri_full"), uni = insert("content_uni_full");
    return contentWriter((id, text) => { tri.run(id, text); uni.run(id, uniTokens(text, false)); });
  },
};

function brotli(payload) { return brotliDecompressSync(payload).toString("utf8"); }

function contentWriter(write) {
  return document => {
    let started = performance.now();
    const blocks = reader.documentBlocks(document.id);
    timings.readDecodeMs += performance.now() - started;
    let bytes = 0;
    for (const block of blocks) {
      if (!block.content) continue;
      started = performance.now();
      const text = normalize(block.content);
      timings.normalizeMs += performance.now() - started;
      started = performance.now();
      write(block.id, text);
      timings.insertMs += performance.now() - started;
      counts.rows++; counts.textChars += text.length; bytes += text.length;
    }
    return bytes;
  };
}

const writeDocument = writers[variant]();
const runStarted = performance.now();
const startedAt = new Date().toISOString();
let batch = 0; let batchChars = 0; let open = false;
const commit = () => {
  if (!open) return;
  const started = performance.now();
  db.exec("COMMIT");
  timings.commitMs += performance.now() - started;
  open = false; batch = 0; batchChars = 0;
};
for (const document of documents) {
  if (!open) { db.exec("BEGIN IMMEDIATE"); open = true; }
  batchChars += writeDocument(document);
  marker.run(document.id);
  counts.documents++;
  if (++batch >= batchDocs || batchChars >= batchBytes) commit();
  if (counts.documents % 2000 === 0) {
    console.log(`${variant} ${counts.documents}/${documents.length} docs ${Math.round((performance.now() - runStarted) / 1000)}s rows=${counts.rows}`);
  }
}
commit();
const buildMs = performance.now() - runStarted;
db.prepare("INSERT INTO build_runs VALUES (?, ?, ?, ?)").run(startedAt, new Date().toISOString(), counts.documents, buildMs);
db.exec("PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode = DELETE;");
const tables = db.prepare("SELECT name, sum(pgsize) AS bytes FROM dbstat GROUP BY name ORDER BY bytes DESC").all()
  .map(row => ({ name: row.name, bytes: Number(row.bytes) }));
const totalBuildMs = Number(db.prepare("SELECT sum(ms) AS ms FROM build_runs").get().ms);
const runCount = Number(db.prepare("SELECT count(*) AS n FROM build_runs").get().n);
const totalDone = Number(db.prepare("SELECT count(*) AS count FROM built_docs").get().count);
db.close();
snapshot.close();
const report = { variant, out: path.basename(out), batchDocs, batchBytes, buildMs, totalBuildMs, runCount, timings, counts, totalDone,
  fileBytes: (await stat(out)).size, tables, maxRSSKiB: process.resourceUsage().maxRSS, node: process.version,
  sqlite: process.versions.sqlite, finishedAt: new Date().toISOString() };
if (!args.out) writeFileSync(path.join(dataDir, `build-${variant}.json`), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ variant, buildMs: Math.round(buildMs), fileBytes: report.fileBytes, counts }));
