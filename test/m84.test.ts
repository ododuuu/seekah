import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createSearchResultSet, type SearchField, type SearchMode, type SearchResult } from "../src/search.js";
import { IndexStore } from "../src/store.js";
import type { DocumentRecord, DocumentStatus, TextBlock } from "../src/model.js";
import { createBlockIndexStore, createLegacyStore } from "./legacy-index.js";

const searchSource = readFileSync(path.resolve("src/search.ts"), "utf8");
const workbenchSource = readFileSync(path.resolve("src/workbench-app.ts"), "utf8");

type Shape = "current" | "block-index" | "legacy";

function block(ordinal: number, content: string, heading: string | null = null): TextBlock {
  return { ordinal, heading, content, locationKind: "line", locationValue: `第 ${ordinal + 1} 行` };
}

function document(root: string, filename: string, blocks: TextBlock[], modifiedAtMs: number,
  status: DocumentStatus = "indexed"): DocumentRecord {
  return {
    path: path.join(root, filename), filename, extension: path.extname(filename) || ".txt",
    sizeBytes: blocks.reduce((total, item) => total + Buffer.byteLength(item.content, "utf8"), 0), modifiedAtMs,
    status, errorCode: null, errorMessage: null, blocks,
  };
}

function records(root: string): DocumentRecord[] {
  return [
    document(root, "phrase-second.txt", [block(0, "needle first passage"), block(1, "中間行"), block(2, "needle second passage")], 100),
    document(root, "needle-body.txt", [block(0, "body has needle content")], 99),
    document(root, "needle-only.txt", [], 98, "unsupported"),
    document(root, "closest.txt", [
      block(0, "alpha first occurrence"),
      block(1, "沒有查詢詞的間隔"),
      block(2, "beta near occurrence"),
      block(3, "alpha nearest occurrence"),
    ], 97),
  ];
}

function createShape(shape: Shape, databasePath: string): IndexStore {
  if (shape === "current") return new IndexStore(databasePath);
  return shape === "block-index" ? createBlockIndexStore(databasePath) : createLegacyStore(databasePath);
}

async function createFixtures() {
  const temp = await mkdtemp(path.join(os.tmpdir(), "lds-m84-"));
  const root = path.join(temp, "文件");
  await mkdir(root, { recursive: true });
  const stores = new Map<Shape, IndexStore>();
  for (const shape of ["current", "block-index", "legacy"] as const) {
    const store = createShape(shape, path.join(temp, `${shape}.db`));
    store.registerRoot(root);
    for (const item of records(root)) store.upsert(item, root);
    stores.set(shape, store);
  }
  return { temp, stores };
}

function page(store: IndexStore, query: string, mode: SearchMode, field: SearchField = "all"): SearchResult[] {
  return createSearchResultSet(store, query, undefined, undefined, mode, undefined, field,
    undefined, "relevance", "exact").page(1, 20).results;
}

function byName(results: readonly SearchResult[], filename: string): SearchResult {
  const result = results.find(item => path.basename(item.path) === filename);
  assert.ok(result, `缺少 ${filename}`);
  return result;
}

function assertSearchContract(source: string, uiSource = workbenchSource): void {
  assert.match(source, /function phrasePassageBlocks\(/u, "缺少 phrase 第二片段收集器。");
  assert.match(source, /matches\.slice\(0, 2\)\.map\(toSearchPassage\)/u, "phrase 沒有限制最多兩段。");
  assert.match(source, /const otherOccurrences =/u, "all-terms 沒有建立其他詞的候選出現處。");
  assert.match(source, /Math\.abs\(item\.block\.ordinal - other\.block\.ordinal\)/u, "all-terms 沒有使用最近 ordinal。");
  assert.match(source, /field === "filename"[\s\S]{0,180}passages: \[\]/u, "filename field 仍可能 materialize body passage。");
  assert.match(uiSource, /grid-template-columns: minmax\(72px, 24%\) minmax\(0, 1fr\)/u, "列表位置欄沒有縮至 24%。");
  assert.match(uiSource, /grid-template-columns: minmax\(60px, 28%\) minmax\(0, 1fr\)/u, "表格位置欄沒有縮至 28%。");
  assert.match(uiSource, /\.result-passage \{ grid-template-columns: minmax\(72px, 26%\)/u, "窄桌面位置欄沒有縮窄。");
  assert.doesNotMatch(uiSource, /minmax\(88px, 31%\)|minmax\(72px, 36%\)|minmax\(76px, 35%\)/u, "仍殘留舊位置欄比例。");
}

test("M84 phrase 顯示同文件第二片段且檔名與內文共命中顯示 body", async t => {
  const fixture = await createFixtures();
  t.after(() => {
    for (const store of fixture.stores.values()) store.close();
    return rm(fixture.temp, { recursive: true, force: true });
  });

  for (const [shape, store] of fixture.stores) {
    const phrase = byName(page(store, "needle", "phrase"), "phrase-second.txt");
    assert.equal(phrase.passages?.length, 2, `${shape} 沒有兩個 phrase passage`);
    assert.deepEqual(phrase.passages?.map(item => item.location), ["第 1 行", "第 3 行"]);
    assert.equal(phrase.passages?.[0]?.snippet, phrase.snippet, `${shape} 第一段破壞主要 snippet`);
    assert.match(phrase.passages?.[1]?.snippet ?? "", /needle second/u);

    const filenameAndBody = byName(page(store, "needle", "phrase"), "needle-body.txt");
    assert.equal(filenameAndBody.filenameOnly, true, `${shape} filename rank stable 欄位改變`);
    assert.equal(filenameAndBody.passages?.length, 1, `${shape} filename + body 沒有 body passage`);
    assert.match(filenameAndBody.passages?.[0]?.snippet ?? "", /body has needle content/u);
    assert.match(filenameAndBody.snippet, /needle-body/u, `${shape} 主要 filename snippet 不應被替換`);

    const filenameOnly = byName(page(store, "needle", "phrase", "filename"), "needle-body.txt");
    assert.deepEqual(filenameOnly.passages, [], `${shape} filename field 不得讀取 body`);
  }

  const current = fixture.stores.get("current")!;
  const instrumented = current as unknown as { candidateByPath: typeof current.candidateByPath };
  const original = current.candidateByPath.bind(current);
  let candidateReads = 0;
  instrumented.candidateByPath = (...args) => {
    candidateReads += 1;
    return original(...args);
  };
  try {
    byName(page(current, "needle", "phrase", "filename"), "needle-body.txt");
    assert.equal(candidateReads, 0, "filename field materialization 額外讀取 candidate body");
  } finally {
    instrumented.candidateByPath = original;
  }
});

test("M84 all-terms 各詞選最近出現處並合併相鄰段落", async t => {
  const fixture = await createFixtures();
  t.after(() => {
    for (const store of fixture.stores.values()) store.close();
    return rm(fixture.temp, { recursive: true, force: true });
  });

  for (const [shape, store] of fixture.stores) {
    const result = byName(page(store, "alpha beta", "all-terms"), "closest.txt");
    assert.equal(result.passages?.length, 1, `${shape} 最近段落沒有合併`);
    assert.deepEqual(result.passages?.[0]?.location, "第 3 行", `${shape} 仍取 alpha 第一次出現`);
    assert.deepEqual(result.passages?.[0]?.terms, ["beta", "alpha"]);
    assert.match(result.passages?.[0]?.snippet ?? "", /beta near occurrence/u);
    assert.match(result.passages?.[0]?.snippet ?? "", /alpha nearest occurrence/u);
  }
});

test("M84 reverse 移除第二段、最近鄰或窄欄契約時必須失敗", () => {
  assertSearchContract(searchSource);

  const withoutSecond = searchSource.replace(/matches\.slice\(0, 2\)\.map\(toSearchPassage\)/u, "matches.slice(0, 1).map(toSearchPassage)");
  assert.throws(() => assertSearchContract(withoutSecond), /兩段|phrase/u);

  const withoutNearest = searchSource.replace(/const otherOccurrences =/u, "const removedOtherOccurrences =");
  assert.throws(() => assertSearchContract(withoutNearest), /最近|候選/u);

  const withoutNarrowList = workbenchSource.replace(/minmax\(72px, 24%\)/u, "minmax(88px, 31%)");
  assert.throws(() => assertSearchContract(searchSource, withoutNarrowList), /列表位置欄|24%/u);
});
