import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { DocumentRecord, TextBlock } from "../src/model.js";
import { createSearchResultSet } from "../src/search.js";
import { describeDatabaseLocation, IndexStore } from "../src/store.js";

const DOCUMENT_COUNT = 6;
const BLOCK_COUNT = 768;
const FILLER = "x".repeat(620);

class FullReadStore extends IndexStore {
  candidateByPath(filePath: string, trace?: Parameters<IndexStore["candidateByPath"]>[1], _passageTerms?: readonly string[]) {
    return super.candidateByPath(filePath, trace);
  }
}

async function fixture(run: (root: string, optimizedDatabase: string, fullDatabase: string) => Promise<void>): Promise<void> {
  const temp = await mkdtemp(path.join(os.tmpdir(), "seekah-m88-"));
  const previous = process.env.LOCALDOCSEARCH_DATA_DIR;
  process.env.LOCALDOCSEARCH_DATA_DIR = temp;
  try {
    const root = path.join(temp, "synthetic-long-documents");
    await mkdir(root, { recursive: true });
    await run(root, path.join(temp, "optimized.db"), path.join(temp, "full.db"));
  } finally {
    if (previous === undefined) delete process.env.LOCALDOCSEARCH_DATA_DIR;
    else process.env.LOCALDOCSEARCH_DATA_DIR = previous;
    await rm(temp, { recursive: true, force: true });
  }
}

function document(root: string, index: number): DocumentRecord {
  const blocks: TextBlock[] = Array.from({ length: BLOCK_COUNT }, (_, ordinal) => ({
    ordinal,
    heading: ordinal === 1 ? "alpha" : null,
    content: ordinal === 1 ? "" : ordinal === BLOCK_COUNT - 1 ? `omega ${FILLER}` : `document-${index} block-${ordinal} ${FILLER}`,
    locationKind: "line",
    locationValue: `第 ${ordinal + 1} 行`,
  }));
  const filename = `long-${index}.txt`;
  return { path: path.join(root, filename), filename, extension: ".txt",
    sizeBytes: blocks.reduce((sum, block) => sum + block.content.length, 0), modifiedAtMs: index + 1,
    status: "indexed", errorCode: null, errorMessage: null, blocks };
}

function populate(store: IndexStore, root: string): void {
  store.registerRoot(root);
  for (let index = 0; index < DOCUMENT_COUNT; index++) store.upsert(document(root, index), root);
}

function materialize(store: IndexStore) {
  const resultSet = createSearchResultSet(store, "alpha omega", undefined, undefined, "all-terms", undefined,
    "all", undefined, "relevance", "exact");
  return resultSet.page(1, DOCUMENT_COUNT);
}

test("M88 長文件多段落只讀取候選 chunks 且結果與完整讀取逐欄相同", async () => {
  await fixture(async (root, optimizedDatabase, fullDatabase) => {
    const optimizedWriter = new IndexStore(optimizedDatabase, { onWarning: () => {} });
    const fullWriter = new IndexStore(fullDatabase, { onWarning: () => {} });
    try {
      populate(optimizedWriter, root);
      populate(fullWriter, root);
    } finally {
      optimizedWriter.close();
      fullWriter.close();
    }

    const optimized = new IndexStore(optimizedDatabase, { readOnly: true, onWarning: () => {} });
    const full = new FullReadStore(fullDatabase, { readOnly: true, onWarning: () => {} });
    try {
      const optimizedPage = materialize(optimized);
      const fullPage = materialize(full);
      assert.deepEqual(optimizedPage, fullPage);
      assert.equal(optimizedPage.total, DOCUMENT_COUNT);
      assert.equal(optimizedPage.results[0]?.passages?.length, 2);

      const optimizedTrace = optimized.lastSearchTrace();
      const fullTrace = full.lastSearchTrace();
      assert.ok(optimizedTrace);
      assert.ok(fullTrace);
      assert.ok(optimizedTrace.counts.indexVerifiedChunks < fullTrace.counts.indexVerifiedChunks,
        `expected fewer verified chunks: ${optimizedTrace.counts.indexVerifiedChunks} < ${fullTrace.counts.indexVerifiedChunks}`);
      assert.ok(optimizedTrace.counts.indexVerifiedBytes < fullTrace.counts.indexVerifiedBytes,
        `expected fewer verified bytes: ${optimizedTrace.counts.indexVerifiedBytes} < ${fullTrace.counts.indexVerifiedBytes}`);
    } finally {
      optimized.close();
      full.close();
    }
  });
});
