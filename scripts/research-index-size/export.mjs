// Export every non-empty content block of snapshot.db into corpus.db (original + normalized text).
import { brotliDecompressSync } from "node:zlib";
import { existsSync, rmSync } from "node:fs";
import { dataPath, normalize, openDb } from "./common.mjs";

const snapshot = openDb(dataPath("snapshot.db"), { readOnly: true });
const target = dataPath("corpus.db");
if (existsSync(target)) rmSync(target);
const corpus = openDb(target);
corpus.exec(`CREATE TABLE blocks(doc_id INTEGER NOT NULL, ordinal INTEGER NOT NULL, orig TEXT NOT NULL, norm TEXT NOT NULL,
  PRIMARY KEY(doc_id, ordinal)) WITHOUT ROWID;
  CREATE TABLE documents(doc_id INTEGER PRIMARY KEY, extension TEXT NOT NULL, blocks INTEGER NOT NULL);`);
const insert = corpus.prepare("INSERT INTO blocks(doc_id, ordinal, orig, norm) VALUES (?, ?, ?, ?)");
const insertDoc = corpus.prepare("INSERT INTO documents(doc_id, extension, blocks) VALUES (?, ?, ?)");
const ordinalsOf = snapshot.prepare("SELECT id, ordinal FROM blocks WHERE document_id = ?");
const payloadsOf = snapshot.prepare("SELECT payload FROM document_payloads WHERE document_id = ? ORDER BY ordinal");
let documents = 0, blocks = 0, origChars = 0, normChars = 0, lengthChanged = 0;
corpus.exec("BEGIN");
for (const doc of snapshot.prepare("SELECT DISTINCT d.id, d.extension FROM documents d JOIN document_payloads p ON p.document_id = d.id ORDER BY d.id").iterate()) {
  const ordinal = new Map(ordinalsOf.all(doc.id).map(row => [row.id, row.ordinal]));
  const content = new Map();
  for (const { payload } of payloadsOf.iterate(doc.id)) {
    for (const [id, fragment] of JSON.parse(brotliDecompressSync(payload).toString("utf8"))) content.set(id, (content.get(id) ?? "") + fragment);
  }
  let count = 0;
  for (const [id, text] of content) {
    if (!text) continue;
    const norm = normalize(text);
    if (norm.length !== text.length) lengthChanged++;
    insert.run(doc.id, ordinal.get(id), text, norm);
    count++; blocks++; origChars += text.length; normChars += norm.length;
  }
  insertDoc.run(doc.id, doc.extension, count);
  documents++;
  if (documents % 2000 === 0) { corpus.exec("COMMIT; BEGIN"); console.error(`${documents} documents, ${blocks} blocks`); }
}
corpus.exec("COMMIT");
console.log(JSON.stringify({ documents, blocks, origChars, normChars, blocksWithLengthChange: lengthChanged }));
