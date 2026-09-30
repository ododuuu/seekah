import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { indexStatus } from "../src/mcp-tools.js";
import type { Diagnostic } from "../src/model.js";
import { formatTruncatedListNotice, previewStatusList, STATUS_LIST_PREVIEW_LIMIT } from "../src/status-preview.js";
import { IndexStore } from "../src/store.js";
import { runTui } from "../src/tui.js";
import { workbenchHtml } from "../src/workbench-app.js";
import { createWorkbench } from "../src/workbench.js";

interface SeededStore {
  temp: string;
  root: string;
  dataDir: string;
  databasePath: string;
  store: IndexStore;
}

function errorLine(index: number): string {
  return `C:\\synthetic\\file-${String(index).padStart(5, "0")}.txt: PARSE_ERROR`;
}

function noticeLine(index: number): string {
  return `C:\\synthetic\\file-${String(index).padStart(5, "0")}.pdf: PDF 沒有可擷取的文字層（掃描影像不支援 OCR）`;
}

function diagnosticsFor(count: number): Diagnostic[] {
  return Array.from({ length: count }, (_, index) => ({
    stage: "parse",
    path: `C:\\synthetic\\file-${String(index).padStart(5, "0")}.txt`,
    code: "PARSE_ERROR",
    message: `fail-${index}`,
  }));
}

async function openSeeded(errors: number, notices = 0, diagnosticCount = errors): Promise<SeededStore> {
  const temp = await mkdtemp(path.join(os.tmpdir(), "lds-m71-"));
  const dataDir = path.join(temp, "data");
  const databasePath = path.join(dataDir, "LocalDocSearch", "index.db");
  await mkdir(path.dirname(databasePath), { recursive: true });
  const root = path.join(temp, "root");
  await mkdir(root);
  const store = new IndexStore(databasePath);
  store.recordSync(
    root,
    false,
    Array.from({ length: errors }, (_, index) => errorLine(index)),
    Array.from({ length: notices }, (_, index) => noticeLine(index)),
    undefined,
    diagnosticsFor(diagnosticCount),
  );
  return { temp, root, dataDir, databasePath, store };
}

async function closeSeeded(item: SeededStore): Promise<void> {
  try { item.store.close(); } catch { /* already closed */ }
  await rm(item.temp, { recursive: true, force: true });
}

test("M71 preview helper keeps order, caps at 100 and formats the truncation sentence", () => {
  assert.equal(STATUS_LIST_PREVIEW_LIMIT, 100);
  const small = previewStatusList(["a", "b"]);
  assert.deepEqual(small, { items: ["a", "b"], total: 2, truncated: false });
  assert.deepEqual(previewStatusList(undefined), { items: [], total: 0, truncated: false });
  const many = Array.from({ length: 150 }, (_, index) => `e${index}`);
  const preview = previewStatusList(many);
  assert.equal(preview.total, 150);
  assert.equal(preview.truncated, true);
  assert.equal(preview.items.length, 100);
  assert.equal(preview.items[0], "e0");
  assert.equal(preview.items[99], "e99");
  assert.equal(formatTruncatedListNotice(150, 100), "共 150 筆，只列前 100 筆");
});

test("M71 indexStatus caps errors and notices and keeps diagnostics as a count", async () => {
  const item = await openSeeded(150, 130);
  try {
    const persisted = item.store.getLastSyncReport(item.root);
    assert.equal(persisted.errors.length, 150);
    assert.equal(persisted.notices.length, 130);
    const status = indexStatus(item.store);
    const root = status.roots[0];
    assert.ok(root);
    assert.equal(root.errors.length, 100);
    assert.equal(root.errorsTotal, 150);
    assert.equal(root.errorsTruncated, true);
    assert.equal(root.errors[0], errorLine(0));
    assert.equal(root.errors[99], errorLine(99));
    assert.equal(root.errors.includes(errorLine(100)), false);
    assert.equal(root.notices.length, 100);
    assert.equal(root.noticesTotal, 130);
    assert.equal(root.noticesTruncated, true);
    assert.equal(root.diagnostics, 150);
    assert.equal(typeof root.diagnostics, "number");
  } finally {
    await closeSeeded(item);
  }
});

test("M71 indexStatus stays compatible with short lists and missing report arrays", async () => {
  const item = await openSeeded(3, 2);
  try {
    const short = indexStatus(item.store).roots[0];
    assert.ok(short);
    assert.deepEqual(short.errors, [errorLine(0), errorLine(1), errorLine(2)]);
    assert.equal(short.errorsTotal, 3);
    assert.equal(short.errorsTruncated, false);
    assert.equal(short.noticesTruncated, false);
    item.store.close();
    const db = new DatabaseSync(item.databasePath);
    db.prepare("UPDATE roots SET report = ? WHERE path = ?").run(JSON.stringify({
      attemptedAt: "2026-10-01T00:00:00.000Z",
      successfulAt: null,
      complete: false,
    }), item.root);
    db.close();
    const readOnly = new IndexStore(item.databasePath, { readOnly: true });
    try {
      const legacy = indexStatus(readOnly).roots[0];
      assert.ok(legacy);
      assert.deepEqual(legacy.errors, []);
      assert.equal(legacy.errorsTotal, 0);
      assert.equal(legacy.errorsTruncated, false);
      assert.deepEqual(legacy.notices, []);
      assert.equal(legacy.noticesTotal, 0);
      assert.equal(legacy.diagnostics, 0);
    } finally {
      readOnly.close();
    }
  } finally {
    await closeSeeded(item);
  }
});

test("M71 CLI status announces truncation without dumping bodies; --issues stays complete", async () => {
  const item = await openSeeded(120, 0, 120);
  item.store.close();
  const cli = path.resolve("dist/src/cli.js");
  const env = { ...process.env, LOCALDOCSEARCH_DATA_DIR: item.dataDir };
  try {
    const status = spawnSync(process.execPath, [cli, "status"], { encoding: "utf8", env, timeout: 30_000 });
    assert.equal(status.status, 0, status.stderr);
    assert.match(status.stdout, /最近同步錯誤：共 120 筆，只列前 100 筆/u);
    assert.doesNotMatch(status.stdout, /file-00119\.txt|fail-119|PARSE_ERROR/u);
    const issues = spawnSync(process.execPath, [cli, "status", "--issues"], { encoding: "utf8", env, timeout: 30_000 });
    assert.equal(issues.status, 0, issues.stderr);
    assert.match(issues.stdout, /fail-0/u);
    assert.match(issues.stdout, /fail-119/u);
    assert.match(issues.stdout, /各根最近同步診斷/u);
  } finally {
    await closeSeeded(item);
  }
});

test("M71 TUI status shows the truncation sentence and not the error bodies", async () => {
  const item = await openSeeded(120);
  try {
    const output: string[] = [];
    const answers = ["/status", "/quit"];
    assert.equal(await runTui(item.store, {
      ansi: false,
      write: value => { output.push(value); },
      ask: async () => answers.shift() ?? null,
    }, 1), 0);
    const text = output.join("\n");
    assert.match(text, /共 120 筆，只列前 100 筆/u);
    assert.doesNotMatch(text, /file-00119\.txt|fail-119/u);
  } finally {
    await closeSeeded(item);
  }
});

test("M71 workbench HTML uses errorsTotal and the shared truncation sentence", () => {
  const html = workbenchHtml("m71-nonce");
  assert.match(html, /errorsTotal/u);
  assert.match(html, /errorsTruncated/u);
  assert.match(html, /共 " \+ total \+ " 筆，只列前 " \+ shown \+ " 筆/u);
});

test("M71 GET /api/index-status and MCP payload share the cap", async () => {
  const item = await openSeeded(150, 110);
  const handle = await createWorkbench({
    databasePath: item.databasePath,
    token: "m71-token",
    secret: Buffer.alloc(32, 7),
    environment: {},
    tempParent: item.temp,
  });
  try {
    const origin = handle.url.split("/#")[0]!;
    const started = Date.now();
    const response = await fetch(`${origin}/api/index-status`, { headers: { "X-LocalDocSearch-Token": "m71-token" } });
    const elapsedMs = Date.now() - started;
    assert.equal(response.status, 200);
    const body = await response.json() as {
      roots: Array<{
        errors: string[];
        errorsTotal: number;
        errorsTruncated: boolean;
        notices: string[];
        noticesTotal: number;
        noticesTruncated: boolean;
        diagnostics: number;
      }>;
    };
    const root = body.roots[0];
    assert.ok(root);
    assert.equal(root.errors.length, 100);
    assert.equal(root.errorsTotal, 150);
    assert.equal(root.errorsTruncated, true);
    assert.equal(root.notices.length, 100);
    assert.equal(root.noticesTotal, 110);
    assert.equal(root.diagnostics, 150);
    const encoded = JSON.stringify(body);
    assert.ok(encoded.length < 500_000, `unexpected status payload size ${encoded.length}`);
    assert.ok(elapsedMs < 2_000, `status poll took ${elapsedMs} ms`);
    const mcp = indexStatus(item.store).roots[0];
    assert.deepEqual(mcp?.errors, root.errors);
    assert.equal(mcp?.errorsTotal, root.errorsTotal);
  } finally {
    await handle.close();
    await closeSeeded(item);
  }
});

test("M71 synthetic 35000-error payload is truncated far below the uncapped size", async () => {
  const count = 35_000;
  const item = await openSeeded(count, 0, 0);
  try {
    const persisted = item.store.getLastSyncReport(item.root);
    assert.equal(persisted.errors.length, count);
    const fullBytes = Buffer.byteLength(JSON.stringify(persisted.errors), "utf8");
    const started = Date.now();
    const status = indexStatus(item.store);
    const elapsedMs = Date.now() - started;
    const root = status.roots[0];
    assert.ok(root);
    assert.equal(root.errors.length, 100);
    assert.equal(root.errorsTotal, count);
    assert.equal(root.errorsTruncated, true);
    const payloadBytes = Buffer.byteLength(JSON.stringify(status), "utf8");
    const previewBytes = Buffer.byteLength(JSON.stringify(root.errors), "utf8");
    assert.ok(fullBytes > 1_000_000, `uncapped errors should be >1MB, got ${fullBytes}`);
    assert.ok(previewBytes < 50_000, `preview errors should be small, got ${previewBytes}`);
    assert.ok(payloadBytes < 500_000, `indexStatus JSON should stay well under 1MB, got ${payloadBytes}`);
    assert.ok(elapsedMs < 1_000, `indexStatus took ${elapsedMs} ms`);
    console.log(`M71 measurement: errors=${count} full=${fullBytes}B preview=${previewBytes}B statusJson=${payloadBytes}B indexStatusMs=${elapsedMs}`);
  } finally {
    await closeSeeded(item);
  }
});
