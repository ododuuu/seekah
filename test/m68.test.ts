import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { formatExclusionPolicyLines, formatExclusionPolicySummary } from "../src/describe-exclusion.js";
import { readExclusionPolicy } from "../src/exclusion-visibility.js";
import { sync } from "../src/sync.js";
import { IndexStore } from "../src/store.js";

test("M68 legacy sync summaries show unavailable exclusion fields as 未提供, never zero", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "lds-m68-legacy-"));
  const root = path.join(temp, "docs");
  const databasePath = path.join(temp, "data", "index.db");
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, "legacy.txt"), "m68-legacy");
  const writer = new IndexStore(databasePath);
  await sync(root, writer);
  writer.close();
  const raw = new DatabaseSync(databasePath);
  try {
    const row = raw.prepare("SELECT report FROM roots WHERE path = ?").get(path.resolve(root)) as { report: string };
    const report = JSON.parse(row.report) as { summary: { skipped: { byRule?: unknown }; exclusionCleanup?: unknown } };
    delete report.summary.skipped.byRule;
    delete report.summary.exclusionCleanup;
    raw.prepare("UPDATE roots SET report = ? WHERE path = ?").run(JSON.stringify(report), path.resolve(root));
  } finally { raw.close(); }
  const reader = new IndexStore(databasePath, { readOnly: true });
  try {
    const policy = readExclusionPolicy(reader, path.resolve(root));
    const lines = formatExclusionPolicyLines(policy).join("\n");
    assert.match(lines, /最近略過：未提供/u);
    assert.match(lines, /排除清理：未提供/u);
    assert.doesNotMatch(lines, /最近略過：0/u);
    assert.match(formatExclusionPolicySummary(policy), /逐規則略過：.*未提供/u);
  } finally {
    reader.close();
    await rm(temp, { recursive: true, force: true });
  }
});