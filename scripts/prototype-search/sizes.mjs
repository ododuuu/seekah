// Index size accounting per variant (dbstat pages), and projected store size:
// base store (snapshot minus A's candidate structures) + the variant's structures.
//   node sizes.mjs -> sizes.json
import { statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { dataDir, snapshotPath, variantPaths } from "./common.mjs";

function tableBytes(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  const rows = db.prepare("SELECT name, sum(pgsize) AS bytes FROM dbstat GROUP BY name").all();
  db.close();
  return Object.fromEntries(rows.map(row => [row.name, Number(row.bytes)]));
}

const sum = (tables, test) => Object.entries(tables).filter(([name]) => test(name)).reduce((total, [, bytes]) => total + bytes, 0);
const prefixed = (...prefixes) => name => prefixes.some(prefix => name === prefix || name.startsWith(`${prefix}_`));
const snapshot = tableBytes(snapshotPath);
const fields = tableBytes(variantPaths.fields);
const b = tableBytes(variantPaths.B);
const c1 = tableBytes(variantPaths.C1);
const c2 = tableBytes(variantPaths.C2);

const structures = {
  "A.documentFts(unigram+trigram, detail=none)": sum(snapshot, prefixed("search_unigrams", "search_trigrams")),
  "A.documentBlooms": sum(snapshot, name => name === "document_blooms"),
  "A.payloadBlooms": sum(snapshot, name => name === "document_payload_blooms" || name === "sqlite_autoindex_document_payload_blooms_1"),
  "fields.filename(tri+uni+bi)": sum(fields, prefixed("fname_tri", "fname_uni", "fname_bi")),
  "fields.heading(tri+uni+bi+map)": sum(fields, prefixed("head_tri", "head_uni", "head_bi", "heading_map")),
  "B.payloadFts(tri+uni)+rows": sum(b, prefixed("pay_tri", "pay_uni", "pay_rows")),
  "C1.content_tri(detail=none)": sum(c1, prefixed("content_tri")),
  "C1.content_uni(detail=none)": sum(c1, prefixed("content_uni")),
  "C1.content_bi(detail=none)": sum(c1, prefixed("content_bi")),
  "C2.content_tri_full(detail=full)": sum(c2, prefixed("content_tri_full")),
  "C2.content_uni_full(detail=full)": sum(c2, prefixed("content_uni_full")),
};
const aStructures = structures["A.documentFts(unigram+trigram, detail=none)"] + structures["A.documentBlooms"] + structures["A.payloadBlooms"];
const snapshotBytes = statSync(snapshotPath).size;
const base = snapshotBytes - aStructures;
const filename = structures["fields.filename(tri+uni+bi)"];
const heading = structures["fields.heading(tri+uni+bi+map)"];
const variants = {
  A: aStructures,
  B: structures["B.payloadFts(tri+uni)+rows"] + filename,
  C1: structures["C1.content_tri(detail=none)"] + structures["C1.content_uni(detail=none)"] + structures["C1.content_bi(detail=none)"] + filename + heading,
  C2: structures["C2.content_tri_full(detail=full)"] + structures["C2.content_uni_full(detail=full)"] + filename + heading,
  D: structures["C2.content_tri_full(detail=full)"] + structures["C1.content_uni(detail=none)"] + structures["C1.content_bi(detail=none)"] + filename + heading,
};
const report = {
  generatedAt: new Date().toISOString(),
  snapshotBytes,
  baseStoreBytesWithoutACandidateStructures: base,
  structures,
  variantSearchStructureBytes: variants,
  projectedStoreBytes: Object.fromEntries(Object.entries(variants).map(([name, bytes]) => [name, name === "A" ? snapshotBytes : base + bytes])),
  files: Object.fromEntries(Object.entries({ snapshot: snapshotPath, ...variantPaths }).map(([name, file]) => [name, statSync(file).size])),
  notes: [
    "Base store keeps documents, blocks, document_payloads (docstore for snippets/verification) and document_payload_blocks for every variant.",
    "D reuses C2's detail=full trigram table plus C1's unigram/bigram tables; in a product it would own only those.",
    "Sizes are as built (no FTS optimize), after WAL checkpoint.",
  ],
};
writeFileSync(path.join(dataDir, "sizes.json"), JSON.stringify(report, null, 1) + "\n");
const mib = bytes => `${(bytes / 1048576).toFixed(1)} MiB`;
for (const [name, bytes] of Object.entries(structures)) console.log(name.padEnd(48), mib(bytes));
for (const [name, bytes] of Object.entries(variants)) console.log(`variant ${name}`.padEnd(48), mib(bytes), "projected store", mib(report.projectedStoreBytes[name]));
