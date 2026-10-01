import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { DocumentRecord, TextBlock } from "../src/model.js";
import { createSearchResultSet } from "../src/search.js";
import { describeDatabaseLocation, IndexStore } from "../src/store.js";

async function fixture(run: (root: string, database: string) => Promise<void>): Promise<void> {
  const temp = await mkdtemp(path.join(os.tmpdir(), "seekah-m87-"));
  const previous = process.env.LOCALDOCSEARCH_DATA_DIR;
  process.env.LOCALDOCSEARCH_DATA_DIR = temp;
  try {
    const root = path.join(temp, "synthetic-documents");
    await mkdir(root, { recursive: true });
    await run(root, describeDatabaseLocation().path);
  } finally {
    if (previous === undefined) delete process.env.LOCALDOCSEARCH_DATA_DIR;
    else process.env.LOCALDOCSEARCH_DATA_DIR = previous;
    await rm(temp, { recursive: true, force: true });
  }
}

function document(root: string, index: number, revision: number): DocumentRecord {
  const filename = `document-${index}.txt`;
  const blocks: TextBlock[] = [{ ordinal: 0, heading: null,
    content: `shared revision-${revision} synthetic content`, locationKind: "line", locationValue: "第 1 行" }];
  return { path: path.join(root, filename), filename, extension: ".txt", sizeBytes: blocks[0]!.content.length,
    modifiedAtMs: revision + 1, status: "indexed", errorCode: null, errorMessage: null, blocks };
}

function page(store: IndexStore, query: string) {
  const resultSet = createSearchResultSet(store, query, undefined, undefined, "phrase", undefined,
    "content", undefined, "relevance", "exact");
  return resultSet.page(1, 100);
}

test("M87 WAL 背景提交期間唯讀連線持續回傳完整搜尋結果", async () => {
  await fixture(async (root, database) => {
    const writer = new IndexStore(database, { onWarning: () => {} });
    writer.registerRoot(root);
    for (let index = 0; index < 24; index++) writer.upsert(document(root, index, 0), root);
    const reader = new IndexStore(database, { readOnly: true, onWarning: () => {} });
    try {
      assert.equal(page(reader, "shared").total, 24);
      for (let revision = 1; revision <= 8; revision++) {
        const index = revision % 24;
        const beforeVersion = reader.dataVersion();
        writer.upsert(document(root, index, revision), root);
        assert.notEqual(reader.dataVersion(), beforeVersion);
        const result = page(reader, "shared");
        assert.equal(result.total, 24);
        assert.equal(page(reader, `revision-${revision}`).total, 1);
      }
    } finally {
      reader.close();
      writer.close();
    }
  });
});
