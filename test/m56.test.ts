import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { IndexStore } from "../src/store.js";
import { sync } from "../src/sync.js";
import { createWorkbench } from "../src/workbench.js";

const INDEX_BUSY = "INDEX_BUSY：索引目前由另一個程序使用，請稍後重試。";

async function seedIndex(temp: string): Promise<{ databasePath: string; root: string }> {
  const databasePath = path.join(temp, "data", "index.db");
  const root = path.join(temp, "watched");
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, "note.txt"), "m56-busy-needle\n");
  const store = new IndexStore(databasePath);
  try { await sync(root, store); }
  finally { store.close(); }
  return { databasePath, root };
}

function headers(origin: string, token: string): Record<string, string> {
  return { "X-LocalDocSearch-Token": token, origin, "content-type": "application/json" };
}

async function jsonRequest(origin: string, token: string, method: string, pathname: string, body: unknown): Promise<{ status: number; error?: string; raw: string }> {
  const response = await fetch(origin + pathname, { method, headers: headers(origin, token), body: JSON.stringify(body) });
  const raw = await response.text();
  let error: string | undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && "error" in parsed && typeof parsed.error === "string") error = parsed.error;
  } catch { /* 非 JSON */ }
  return error === undefined ? { status: response.status, raw } : { status: response.status, error, raw };
}

function assertBusy(result: { status: number; error?: string; raw: string }, label: string): void {
  const detail = `${label} status=${result.status} error=${result.error ?? ""} raw=${result.raw}`;
  assert.equal(result.status, 409, detail);
  assert.equal(result.error, INDEX_BUSY, detail);
  assert.equal(result.raw.includes("database is locked"), false, detail);
  assert.match(result.raw, /INDEX_BUSY/u, detail);
}

test("m56: 工作台 BUSY 回 409 INDEX_BUSY 且不含原文；非 busy 不被吞", { timeout: 20_000 }, async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "seekah-m56-workbench-busy-"));
  const { databasePath, root } = await seedIndex(temp);
  const handle = await createWorkbench({
    databasePath, token: "m56-token", secret: Buffer.alloc(32, 11), environment: {}, tempParent: temp,
  });
  const origin = handle.url.split("/#")[0]!;
  const token = handle.token;
  let holder: DatabaseSync | undefined;
  let testError: unknown;
  try {
    const invalid = await jsonRequest(origin, token, "POST", "/api/settings", { deleteConfirmation: "yes" });
    assert.equal(invalid.status, 400);
    assert.match(invalid.error ?? "", /刪除提醒設定無效/u);
    assert.equal((invalid.error ?? "").includes("INDEX_BUSY"), false);

    holder = new DatabaseSync(databasePath);
    holder.exec("BEGIN EXCLUSIVE");

    assertBusy(await jsonRequest(origin, token, "POST", "/api/settings", { deleteConfirmation: false }), "settings");
    assertBusy(await jsonRequest(origin, token, "POST", "/api/index-roots/trash", { roots: [path.resolve(root)] }), "trash-move");
    assertBusy(await jsonRequest(origin, token, "DELETE", "/api/trash", { roots: [path.resolve(root)] }), "trash-purge");
    assertBusy(await jsonRequest(origin, token, "POST", "/api/search", {
      query: "m56-busy-needle", mode: "phrase", page: 1, pageSize: 20, field: "all", sort: "relevance",
    }), "search");

    holder.exec("ROLLBACK");
    holder.close();
    holder = undefined;

    const settings = await fetch(origin + "/api/settings", {
      method: "POST", headers: headers(origin, token), body: JSON.stringify({ deleteConfirmation: false }),
    });
    assert.equal(settings.status, 200);
    const settingsParsed: unknown = await settings.json();
    assert.equal(settingsParsed && typeof settingsParsed === "object" && "deleteConfirmation" in settingsParsed
      && settingsParsed.deleteConfirmation === false, true);
    const search = await fetch(origin + "/api/search", {
      method: "POST", headers: headers(origin, token),
      body: JSON.stringify({ query: "m56-busy-needle", mode: "phrase", page: 1, pageSize: 20, field: "all", sort: "relevance" }),
    });
    assert.equal(search.status, 200);
    const searchParsed: unknown = await search.json();
    const searchResults = searchParsed && typeof searchParsed === "object" && "results" in searchParsed && Array.isArray(searchParsed.results)
      ? searchParsed.results : [];
    assert.equal(searchResults.some(item => item && typeof item === "object" && "path" in item && item.path === path.resolve(root, "note.txt")), true);

    const trashed = await fetch(origin + "/api/index-roots/trash", {
      method: "POST", headers: headers(origin, token), body: JSON.stringify({ roots: [path.resolve(root)] }),
    });
    assert.equal(trashed.status, 200);

    const purged = await fetch(origin + "/api/trash", {
      method: "DELETE", headers: headers(origin, token), body: JSON.stringify({ roots: [path.resolve(root)] }),
    });
    assert.equal(purged.status, 200);
  } catch (error) {
    testError = error;
    throw error;
  } finally {
    if (holder) {
      try { holder.exec("ROLLBACK"); } catch { /* 交易可能已結束 */ }
      holder.close();
      holder = undefined;
    }
    await handle.close();
    try {
      await rm(temp, { recursive: true, force: true });
    } catch (cleanup) {
      if (testError) throw testError;
      // Windows：node:sqlite mmap 關閉後主庫檔仍可能短暫鎖定，無法 unlink。
      if (cleanup && typeof cleanup === "object" && "code" in cleanup && cleanup.code === "EBUSY") return;
      throw cleanup;
    }
  }
});
