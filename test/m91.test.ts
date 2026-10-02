import assert from "node:assert/strict";
import { mkdir, readdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  GROUP_ITEM_LIMIT, GROUP_LIMIT, PINNED_LIMIT, RECENT_LIMIT, SAVED_SEARCH_LIMIT,
  LibraryConflictError, LibraryStore, libraryDatabasePath,
} from "../src/library.js";

async function fixture(run: (temp: string, databasePath: string) => Promise<void>): Promise<void> {
  const temp = await mkdtemp(path.join(os.tmpdir(), "seekah-m91-"));
  const databasePath = path.join(temp, "data", "index.db");
  try { await run(temp, databasePath); }
  finally { await rm(temp, { recursive: true, force: true }); }
}

function document(index: number) {
  return { path: path.resolve(`/synthetic/m91-${index}.txt`), reference: `${index + 1}-1234567890abcdef`, name: `m91-${index}.txt` };
}

test("M91 文件庫在重開後保留 CRUD、路徑去重與條件欄位，且不保存內容", async () => {
  await fixture(async (_temp, databasePath) => {
    let tick = 0;
    const now = () => new Date(Date.UTC(2026, 9, 3, 0, 0, 0, tick++));
    const store = new LibraryStore(databasePath, { now });
    try {
      const first = store.recordRecent({ ...document(0), action: "select" });
      const second = store.recordRecent({ ...document(0), name: "更新名稱.txt", action: "context" });
      assert.equal(first.path, second.path);
      assert.equal(store.listRecent().length, 1);
      assert.equal(store.listRecent()[0]?.lastAction, "context");

      const pinned = store.upsertPinned(document(0));
      assert.equal(pinned.reference, document(0).reference);
      assert.equal(store.upsertPinned({ ...document(0), reference: "2-abcdefabcdefabcd" }).path, document(0).path);
      assert.equal(store.listPinned().length, 1);

      const group = store.createGroup("研究資料");
      store.addGroupItem(group.id, document(0));
      store.addGroupItem(group.id, document(1));
      assert.deepEqual(store.getGroup(group.id).items.map(item => item.path).sort(), [document(0).path, document(1).path].sort());

      const saved = store.createSavedSearch({ name: "最近 TXT", query: "needle", root: "/synthetic", types: [".txt"], sort: "modified", field: "content", mode: "all-terms" });
      assert.deepEqual(saved.types, [".txt"]);
      const updated = store.updateSavedSearch(saved.id, { ...saved, name: "更新搜尋", query: "changed" });
      assert.equal(updated.query, "changed");
    } finally { store.close(); }

    const reopened = new LibraryStore(databasePath, { now });
    try {
      assert.equal(reopened.listRecent()[0]?.name, "更新名稱.txt");
      assert.equal(reopened.listPinned()[0]?.path, document(0).path);
      assert.equal(reopened.listGroups()[0]?.items.length, 2);
      assert.equal(reopened.listSavedSearches()[0]?.query, "changed");
      const tableNames = await readdir(path.dirname(libraryDatabasePath(databasePath)));
      assert.equal(tableNames.some(name => name.endsWith(".txt") || name.includes("needle")), false);
    } finally { reopened.close(); }
  });
});

test("M91 reverse 去掉容量與路徑去重時，契約斷言會失敗", async () => {
  await fixture(async (_temp, databasePath) => {
    const store = new LibraryStore(databasePath);
    try {
      store.recordRecent({ ...document(0), action: "select" });
      store.recordRecent({ ...document(0), action: "mcp" });
      assert.equal(store.listRecent().length, 1, "相同路徑必須只有一筆最近項目");
      for (let index = 0; index < RECENT_LIMIT + 1; index++) store.recordRecent({ ...document(index + 10), action: "select" });
      assert.equal(store.listRecent().length, RECENT_LIMIT, "最近項目必須有界");
      assert.equal(store.listRecent().some(item => item.path === document(0).path), false, "最舊最近項目必須被淘汰");

      for (let index = 0; index < PINNED_LIMIT; index++) store.upsertPinned(document(index + 1_000));
      assert.throws(() => store.upsertPinned(document(2_000)), (error: unknown) => error instanceof LibraryConflictError && error.statusCode === 409);

      for (let index = 0; index < GROUP_LIMIT; index++) store.createGroup(`分類 ${index}`);
      assert.throws(() => store.createGroup("分類 50"), (error: unknown) => error instanceof LibraryConflictError && error.statusCode === 409);
      const group = store.listGroups()[0]!;
      for (let index = 0; index < GROUP_ITEM_LIMIT; index++) store.addGroupItem(group.id, document(index + 3_000));
      assert.throws(() => store.addGroupItem(group.id, document(4_000)), (error: unknown) => error instanceof LibraryConflictError && error.statusCode === 409);

      for (let index = 0; index < SAVED_SEARCH_LIMIT; index++) store.createSavedSearch({ name: `搜尋 ${index}`, query: String(index) });
      assert.throws(() => store.createSavedSearch({ name: "搜尋 100", query: "overflow" }), (error: unknown) => error instanceof LibraryConflictError && error.statusCode === 409);
    } finally { store.close(); }
  });
});

test("M91 損壞文件庫先隔離原檔，再以空庫恢復服務", async () => {
  await fixture(async (_temp, databasePath) => {
    const filePath = libraryDatabasePath(databasePath);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, "not a sqlite database", "utf8");

    const recovered = new LibraryStore(databasePath);
    try {
      assert.deepEqual(recovered.listRecent(), []);
      const names = await readdir(path.dirname(filePath));
      assert.equal(names.some(name => name.startsWith("library.sqlite.corrupt-")), true);
    } finally { recovered.close(); }
  });
});
