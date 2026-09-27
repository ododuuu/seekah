import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { search } from "../src/search.js";
import { IndexStore } from "../src/store.js";

test("M22 Bloom skips impossible long-query payloads without changing exact results", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "lds-m22-"));
  const store = new IndexStore(path.join(temp, "index.db"));
  const add = (name: string, content: string) => store.upsert({ path: path.join(temp, name), filename: name, extension: ".txt", sizeBytes: 1, modifiedAtMs: 1,
    status: "indexed", errorCode: null, errorMessage: null, blocks: [{ ordinal: 0, heading: null, content, locationKind: "line", locationValue: "第 1 行" }] });
  try {
    add("hit.txt", "這份文件有測試與稀有關鍵字-ABC987"); add("skip.txt", "完全不同的一般文字");
    const skipped = store.getDocument(path.join(temp, "skip.txt"))!.id;
    const privateStore = store as unknown as { streamBlocksFor: (id: number) => Iterable<never> };
    const original = privateStore.streamBlocksFor;
    privateStore.streamBlocksFor = id => { if (id === skipped) throw new Error("Bloom 應跳過不可能文件"); return original.call(store, id); };
    try {
      assert.deepEqual(search(store, "ABC987").map(hit => path.basename(hit.path)), ["hit.txt"]);
      assert.deepEqual(search(store, "測試").map(hit => path.basename(hit.path)), ["hit.txt"]);
    } finally { privateStore.streamBlocksFor = original; }
    assert.deepEqual(search(store, "一般").map(hit => path.basename(hit.path)), ["skip.txt"]);
  } finally { store.close(); await rm(temp, { recursive: true, force: true }); }
});
