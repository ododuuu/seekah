// Migration feasibility on a document subset, per variant:
//   1. clean build of the first N documents
//   2. build killed mid-way (hard kill) and resumed from its built_docs markers
//   3. delete + re-insert a random subset (contentless_delete), as incremental updates would
// Each result is compared with the clean build through fts5vocab (term, doc, cnt) and plain-table hashes.
//   node migration.mjs [--limit 3000] [--variants fields,B,C1,C2]
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { dataDir, mulberry32, openSnapshot, parseArgs } from "./common.mjs";

const args = parseArgs(process.argv.slice(2));
const limit = Number(args.limit ?? 3000);
const variants = (args.variants ?? "fields,B,C1,C2").split(",");
const build = path.join(import.meta.dirname, "build.mjs");
const ftsTables = {
  fields: ["fname_tri", "fname_uni", "fname_bi", "head_tri", "head_uni", "head_bi"],
  B: ["pay_tri", "pay_uni"], C1: ["content_tri", "content_uni", "content_bi"], C2: ["content_tri_full", "content_uni_full"],
};
const plainTables = { fields: "SELECT document_id, min_ordinal, heading FROM heading_map ORDER BY document_id, heading",
  B: "SELECT document_id, payload_ordinal, kind FROM pay_rows ORDER BY document_id, payload_ordinal, kind" };

const remove = file => { for (const suffix of ["", "-wal", "-shm", "-journal"]) rmSync(file + suffix, { force: true }); };
const runBuild = (variant, out) => {
  const started = performance.now();
  const result = spawnSync(process.execPath, [build, "--variant", variant, "--limit", String(limit), "--out", out], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr);
  return performance.now() - started;
};

function fingerprint(file, variant) {
  const db = new DatabaseSync(file);
  const result = {};
  for (const table of ftsTables[variant]) {
    db.exec(`DROP TABLE IF EXISTS temp.v; CREATE VIRTUAL TABLE temp.v USING fts5vocab(main, ${table}, row);`);
    const hash = createHash("sha256");
    let terms = 0;
    for (const row of db.prepare("SELECT term, doc, cnt FROM temp.v ORDER BY term").iterate()) { hash.update(`${row.term}\u0001${row.doc}\u0001${row.cnt}\n`); terms++; }
    let integrity = "ok";
    try { db.exec(`INSERT INTO ${table}(${table}) VALUES ('integrity-check')`); } catch (error) { integrity = error.message; }
    result[table] = { terms, hash: hash.digest("hex").slice(0, 16), integrity };
  }
  if (plainTables[variant]) {
    const hash = createHash("sha256");
    for (const row of db.prepare(plainTables[variant]).iterate()) hash.update(JSON.stringify(Object.values(row)) + "\n");
    result.plain = hash.digest("hex").slice(0, 16);
  }
  result.builtDocs = Number(db.prepare("SELECT count(*) AS n FROM built_docs").get().n);
  db.close();
  return result;
}

const report = { generatedAt: new Date().toISOString(), limit, variants: {} };
const snapshot = openSnapshot();
const blockIds = snapshot.prepare("SELECT id FROM blocks WHERE document_id = ?");
for (const variant of variants) {
  const clean = path.join(dataDir, `mig-${variant}-clean.db`);
  const killed = path.join(dataDir, `mig-${variant}-killed.db`);
  const churn = path.join(dataDir, `mig-${variant}-churn.db`);
  [clean, killed, churn].forEach(remove);
  const cleanMs = runBuild(variant, clean);
  const cleanPrint = fingerprint(clean, variant);

  // Hard kill at ~45% of the clean build time, then resume.
  const child = spawn(process.execPath, [build, "--variant", variant, "--limit", String(limit), "--out", killed], { stdio: "ignore" });
  await new Promise(resolve => setTimeout(resolve, Math.max(300, cleanMs * 0.45)));
  child.kill("SIGKILL");
  await new Promise(resolve => child.on("exit", resolve));
  const probe = new DatabaseSync(killed);
  const doneAtKill = Number(probe.prepare("SELECT count(*) AS n FROM built_docs").get().n);
  probe.close();
  const resumeMs = runBuild(variant, killed);
  const killedPrint = fingerprint(killed, variant);

  // Delete + re-insert 10% of the documents.
  copyFileSync(clean, churn);
  const db = new DatabaseSync(churn);
  const ids = db.prepare("SELECT document_id FROM built_docs").all().map(row => Number(row.document_id));
  const random = mulberry32(3);
  const chosen = ids.filter(() => random() < 0.1);
  const deleteStarted = performance.now();
  for (const documentId of chosen) {
    db.exec("BEGIN");
    if (variant === "fields") {
      for (const table of ["fname_tri", "fname_uni", "fname_bi"]) db.prepare(`DELETE FROM ${table} WHERE rowid = ?`).run(documentId);
      for (const { id } of db.prepare("SELECT id FROM heading_map WHERE document_id = ?").all(documentId)) {
        for (const table of ["head_tri", "head_uni", "head_bi"]) db.prepare(`DELETE FROM ${table} WHERE rowid = ?`).run(id);
      }
      db.prepare("DELETE FROM heading_map WHERE document_id = ?").run(documentId);
    } else if (variant === "B") {
      for (const { id } of db.prepare("SELECT id FROM pay_rows WHERE document_id = ?").all(documentId)) {
        for (const table of ftsTables.B) db.prepare(`DELETE FROM ${table} WHERE rowid = ?`).run(id);
      }
      db.prepare("DELETE FROM pay_rows WHERE document_id = ?").run(documentId);
    } else {
      for (const { id } of blockIds.all(documentId)) for (const table of ftsTables[variant]) db.prepare(`DELETE FROM ${table} WHERE rowid = ?`).run(id);
    }
    db.prepare("DELETE FROM built_docs WHERE document_id = ?").run(documentId);
    db.exec("COMMIT");
  }
  const deleteMs = performance.now() - deleteStarted;
  db.close();
  const reinsertMs = runBuild(variant, churn);
  const churnPrint = fingerprint(churn, variant);

  const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
  report.variants[variant] = {
    cleanMs, doneAtKill, resumeMs, resumedEqualsClean: same(cleanPrint, killedPrint),
    churnDocuments: chosen.length, deleteMs, deleteMsPerDocument: deleteMs / Math.max(1, chosen.length), reinsertMs,
    churnEqualsClean: same(cleanPrint, churnPrint), clean: cleanPrint, killed: killedPrint, churn: churnPrint,
  };
  console.log(variant, JSON.stringify({ doneAtKill, resumedEqualsClean: report.variants[variant].resumedEqualsClean,
    churnEqualsClean: report.variants[variant].churnEqualsClean, deleteMsPerDocument: report.variants[variant].deleteMsPerDocument.toFixed(2) }));
  [clean, killed, churn].forEach(remove);
}
writeFileSync(path.join(dataDir, "migration.json"), JSON.stringify(report, null, 1) + "\n");
