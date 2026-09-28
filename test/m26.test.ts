import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { EventEmitter } from "node:events";
import type fs from "node:fs";
import { IndexStore } from "../src/store.js";
import { sync } from "../src/sync.js";
import { search } from "../src/search.js";
import { actOnDocument } from "../src/open-document.js";
import { IgnoreConfigurationError } from "../src/ignore.js";
import { RootError } from "../src/scanner.js";
import { acquireWriteLock } from "../src/write-lock.js";
import { OperationCancelledError } from "../src/progress.js";
import { runWatch } from "../src/watch.js";
import {
  parseFsPath, planRootOperation, coversPath, samePath, strictlyCovers, canonicalizeRootInput,
} from "../src/root-plan.js";

async function fixture(run: (temp: string, store: IndexStore) => Promise<void>) {
  const temp = await mkdtemp(path.join(os.tmpdir(), "lds-m26-"));
  const store = new IndexStore(path.join(temp, "index.db"));
  try { await run(temp, store); }
  finally { store.close(); await rm(temp, { recursive: true, force: true }); }
}

function payloadDump(database: string) {
  const db = new DatabaseSync(database, { readOnly: true });
  try {
    // Stored chunk text (SPEC §52.1); a merge must only transfer ownership, never rewrite it.
    return (db.prepare("SELECT id, document_id, ordinal, hex(text) AS text, hex(layout) AS layout FROM document_chunks ORDER BY id")
      .all() as { id: number; document_id: number; ordinal: number; text: string; layout: string }[]);
  } finally { db.close(); }
}

test("M26 path coverage uses components, not string prefixes", () => {
  assert.equal(coversPath("D:\\備份", "D:\\備份2", "win32"), false);
  assert.equal(coversPath("D:\\備份", "D:\\備份\\a.txt", "win32"), true);
  assert.equal(coversPath("D:\\", "D:\\備份", "win32"), true);
  assert.equal(coversPath("D:\\", "E:\\備份", "win32"), false);
  assert.equal(samePath("D:\\備份\\", "D:\\備份", "win32"), true);
  assert.equal(samePath("d:\\Backup", "D:\\backup", "win32"), true);
  assert.throws(() => parseFsPath("D:", "win32"), RootError);
  assert.throws(() => parseFsPath("D:foo", "win32"), RootError);
  assert.equal(canonicalizeRootInput("D:", "win32").path, "D:\\");
  assert.equal(canonicalizeRootInput("D:", "win32").rewrittenFrom, "D:");
  assert.equal(canonicalizeRootInput("D:\\", "win32").path, "D:\\");
  assert.equal(canonicalizeRootInput("D:/", "win32").path, "D:\\");
  assert.equal(canonicalizeRootInput("D:＼", "win32").path, "D:\\");
  assert.equal(canonicalizeRootInput("Ｄ：／", "win32").path, "D:\\");
  assert.equal(parseFsPath("D:＼", "win32").drive, "d:");
  assert.deepEqual([...parseFsPath("D:／", "win32").parts], []);
  const disk = parseFsPath("D:\\", "win32");
  assert.equal(disk.drive, "d:");
  assert.deepEqual(disk.parts, []);
  const unc = parseFsPath("\\\\filesrv\\docs\\備份", "win32");
  assert.equal(unc.uncHost, "filesrv");
  assert.equal(unc.uncShare, "docs");
  assert.deepEqual([...unc.parts], ["備份"]);
  assert.equal(coversPath("\\\\filesrv\\docs", "\\\\filesrv\\docs\\備份", "win32"), true);
  assert.equal(coversPath("\\\\filesrv\\docs", "\\\\filesrv\\other\\備份", "win32"), false);
  assert.equal(strictlyCovers(parseFsPath("D:\\", "win32"), parseFsPath("D:\\備份", "win32")), true);
  assert.equal(coversPath("/tmp/備份", "/tmp/備份2"), false);
  assert.equal(coversPath("/tmp/備份", "/tmp/備份/a.txt"), true);
});

test("M26 root operation plan covers merge, subtree, alias and similar prefixes", () => {
  const child = { registered: "D:\\備份", actual: "D:\\備份" };
  const other = { registered: "D:\\備份2", actual: "D:\\備份2" };
  const sibling = { registered: "E:\\data", actual: "E:\\data" };
  assert.equal(planRootOperation({ resolved: "D:\\", actual: "D:\\" }, [child, other, sibling], "win32").kind, "merge");
  assert.deepEqual(planRootOperation({ resolved: "D:\\", actual: "D:\\" }, [child, other, sibling], "win32").mergedRoots, ["D:\\備份", "D:\\備份2"]);
  assert.equal(planRootOperation({ resolved: "D:\\備份\\年度", actual: "D:\\備份\\年度" }, [child], "win32").kind, "subtree");
  assert.equal(planRootOperation({ resolved: "D:\\備份", actual: "D:\\備份" }, [child], "win32").kind, "existing");
  assert.equal(planRootOperation({ resolved: "D:\\別名", actual: "D:\\備份" }, [child], "win32").kind, "existing");
  assert.equal(planRootOperation({ resolved: "D:\\備份2", actual: "D:\\備份2" }, [child], "win32").kind, "independent");
  const uncChild = { registered: "\\\\srv\\share\\docs", actual: "\\\\srv\\share\\docs" };
  assert.equal(planRootOperation({ resolved: "\\\\srv\\share", actual: "\\\\srv\\share" }, [uncChild], "win32").kind, "merge");
  assert.equal(planRootOperation({ resolved: "\\\\srv\\other", actual: "\\\\srv\\other" }, [uncChild], "win32").kind, "independent");
});

test("M26 merge transfers ownership without rewriting stored chunks", () => fixture(async (temp, store) => {
  const parent = path.join(temp, "parent");
  const child = path.join(parent, "child");
  const other = path.join(temp, "other");
  await mkdir(child, { recursive: true }); await mkdir(other);
  await writeFile(path.join(child, "甲.txt"), "子根內容");
  await writeFile(path.join(other, "乙.txt"), "不相交內容");
  await sync(child, store); await sync(other, store);
  const row = store.getDocument(path.join(child, "甲.txt"))!;
  const ref = search(store, "子根內容")[0]!.reference;
  const before = payloadDump(store.databasePath);
  assert.ok(before.length > 0);
  const report = await sync(parent, store);
  assert.equal(report.operation, "merge");
  assert.deepEqual(store.roots(), [other, parent].sort());
  assert.equal(store.documentRoot(row.id), parent);
  assert.equal(store.getDocument(path.join(child, "甲.txt"))!.id, row.id);
  assert.deepEqual(payloadDump(store.databasePath), before);
  assert.equal(search(store, "子根內容")[0]?.reference, ref);
  assert.equal(search(store, "不相交內容").length, 1);
  assert.equal(report.parserCalls, 0);
  assert.equal((await sync(parent, store)).parserCalls, 0);
  assert.ok(store.ignoreBases(parent).includes(child));
  assert.equal(store.getLastSyncReport(parent).successfulAt !== null, true);
}));

test("M26 merge transaction rolls back on injected failure", () => fixture(async (temp, store) => {
  const parent = path.join(temp, "parent");
  const child = path.join(parent, "child");
  await mkdir(child, { recursive: true });
  await writeFile(path.join(child, "甲.txt"), "子根內容");
  await sync(child, store);
  const id = store.getDocument(path.join(child, "甲.txt"))!.id;
  assert.throws(() => store.mergeChildRoots(parent, [child], { beforeCommit: () => { throw new Error("injected"); } }), /injected/);
  assert.deepEqual(store.roots(), [child]);
  assert.equal(store.documentRoot(id), child);
  assert.equal(search(store, "子根內容").length, 1);
}));

test("M26 subtree sync does not update parent complete time or delete outside files", () => fixture(async (temp, store) => {
  const parent = path.join(temp, "parent");
  const child = path.join(parent, "child");
  await mkdir(child, { recursive: true });
  await writeFile(path.join(parent, "外.txt"), "外層內容");
  await writeFile(path.join(child, "內.txt"), "內層內容");
  await sync(parent, store);
  const completeAt = store.getLastSyncReport(parent).successfulAt;
  await writeFile(path.join(child, "新.txt"), "新內層");
  await rm(path.join(child, "內.txt"));
  const subtree = await sync(child, store);
  assert.equal(subtree.operation, "subtree");
  assert.equal(store.roots()[0], parent);
  assert.equal(store.getLastSyncReport(parent).successfulAt, completeAt);
  assert.equal(search(store, "外層內容").length, 1);
  assert.equal(search(store, "新內層").length, 1);
  assert.equal(search(store, "內層內容").length, 0);
}));

test("M26 keeps former ignore scopes after merge and treats missing ignore as removed", () => fixture(async (temp, store) => {
  const parent = path.join(temp, "parent");
  const child = path.join(parent, "child");
  await mkdir(child, { recursive: true });
  await writeFile(path.join(child, "公開.txt"), "公開內容");
  await writeFile(path.join(child, "秘密.txt"), "秘密內容");
  await writeFile(path.join(child, ".localdocsearchignore"), "秘密.txt\n");
  await sync(child, store);
  assert.equal(search(store, "秘密內容").length, 0);
  await sync(parent, store);
  assert.equal(search(store, "秘密內容").length, 0);
  assert.equal(search(store, "公開內容").length, 1);
  await rm(path.join(child, ".localdocsearchignore"));
  await sync(parent, store);
  assert.equal(search(store, "秘密內容").length, 1);
}));

test("M26 unreadable ignore file is not treated as empty rules", () => fixture(async (temp, store) => {
  const parent = path.join(temp, "parent");
  const child = path.join(parent, "child");
  await mkdir(child, { recursive: true });
  await writeFile(path.join(child, "甲.txt"), "內容");
  await sync(child, store);
  await sync(parent, store);
  await rm(path.join(child, ".localdocsearchignore"), { force: true });
  await mkdir(path.join(child, ".localdocsearchignore"));
  await assert.rejects(sync(parent, store), IgnoreConfigurationError);
  assert.equal(search(store, "內容").length, 1);
}));

test("M26 search --root accepts former child and keeps path boundaries", () => fixture(async (temp, store) => {
  const parent = path.join(temp, "parent");
  const child = path.join(parent, "child");
  const similar = path.join(parent, "child2");
  await mkdir(child, { recursive: true }); await mkdir(similar);
  await writeFile(path.join(child, "甲.txt"), "共同關鍵");
  await writeFile(path.join(similar, "乙.txt"), "共同關鍵");
  await sync(child, store); await sync(similar, store); await sync(parent, store);
  const scope = store.resolveSearchScope(child);
  assert.equal(scope.root, parent);
  assert.equal(scope.subtree, child);
  const hits = search(store, "共同關鍵", 20, undefined, scope.root, "phrase", scope.subtree);
  assert.equal(hits.length, 1);
  assert.match(hits[0]!.path, /甲\.txt$/);
  const similarHits = search(store, "共同關鍵", 20, undefined, parent, "phrase", similar);
  assert.equal(similarHits.length, 1);
  assert.match(similarHits[0]!.path, /乙\.txt$/);
}));

test("M26 open keeps document codes after merge", () => fixture(async (temp, store) => {
  const parent = path.join(temp, "parent");
  const child = path.join(parent, "child");
  await mkdir(child, { recursive: true });
  await writeFile(path.join(child, "甲.txt"), "內容");
  await sync(child, store);
  const ref = search(store, "內容")[0]!.reference;
  await sync(parent, store);
  assert.equal((await actOnDocument(store, ref, "open", true)).path, path.join(child, "甲.txt"));
}));

test("M26 CLI merge, subtree filter, remove and rebuild hints", () => fixture(async (temp, _store) => {
  const parent = path.join(temp, "parent");
  const child = path.join(parent, "child");
  const other = path.join(temp, "other");
  await mkdir(child, { recursive: true }); await mkdir(other);
  await writeFile(path.join(child, "甲.txt"), "共同內文");
  await writeFile(path.join(other, "乙.txt"), "共同內文");
  const env = { ...process.env, LOCALDOCSEARCH_DATA_DIR: path.join(temp, "cli-data") };
  const run = (...args: string[]) => spawnSync(process.execPath, [path.resolve("dist/src/cli.js"), ...args], { encoding: "utf8", env });
  assert.equal(run("index", child).status, 0);
  assert.equal(run("index", other).status, 0);
  const merged = run("index", parent);
  assert.equal(merged.status, 0, merged.stderr);
  assert.match(merged.stdout, /合併根目錄範圍/);
  assert.match(run("roots").stdout, /已登錄根目錄：2/);
  const filtered = run("search", "共同內文", "--root", child, "--limit", "5");
  assert.equal(filtered.status, 0, filtered.stderr);
  assert.match(filtered.stdout, /甲\.txt/);
  assert.doesNotMatch(filtered.stdout, /乙\.txt/);
  const remove = run("roots", "remove", child);
  assert.equal(remove.status, 3);
  assert.match(remove.stderr, /已合併至上層索引/);
  const rebuilt = run("rebuild", child);
  assert.equal(rebuilt.status, 3);
  assert.match(rebuilt.stderr, /已合併至上層索引/);
  const subtree = run("index", child);
  assert.equal(subtree.status, 0, subtree.stderr);
  assert.match(subtree.stdout, /已包含於上層索引/);
}));

test("M26 watch stops a merged child and keeps the sibling root", { timeout: 10000 }, async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "lds-m26-watch-"));
  const parent = path.join(temp, "parent");
  const child = path.join(parent, "child");
  const other = path.join(temp, "other");
  await mkdir(child, { recursive: true }); await mkdir(other);
  await writeFile(path.join(child, "甲.txt"), "子內容");
  await writeFile(path.join(other, "乙.txt"), "其他內容");
  const store = new IndexStore(path.join(temp, "index.db"));
  await sync(child, store); await sync(other, store);
  const logs: string[] = [];
  let stop!: () => void;
  const stopped = new Promise<void>(resolve => { stop = resolve; });
  const emitters = new Map<string, EventEmitter & { close(): void }>();
  const fakeWatch = ((watchPath: fs.PathLike, opts: unknown, listener?: (event: fs.WatchEventType, filename: string | null) => void) => {
    const emitter = new EventEmitter() as EventEmitter & { close(): void };
    emitter.close = () => emitter.removeAllListeners();
    const cb = (typeof opts === "function" ? opts : listener) as (event: fs.WatchEventType, filename: string | null) => void;
    emitter.on("change", (event, filename) => cb(event as fs.WatchEventType, filename as string | null));
    emitters.set(String(watchPath), emitter);
    return emitter as unknown as fs.FSWatcher;
  }) as typeof fs.watch;
  let watching!: () => void;
  const ready = new Promise<void>(resolve => { watching = resolve; });
  const running = runWatch(store, [child, other], {
    debounceMs: 200, rescanMs: 0, syncNow: false, watch: fakeWatch,
    sync: async (rootPath, indexStore, syncOptions) => sync(rootPath, indexStore, syncOptions),
    setTimer: fn => { queueMicrotask(fn); return 0 as unknown as ReturnType<typeof setTimeout>; },
    clearTimer: () => undefined,
  }, {
    write: text => {
      logs.push(text);
      if (text.startsWith("監看中：") && logs.filter(item => item.startsWith("監看中：")).length >= 2) watching();
    },
    waitForStop: () => stopped,
  });
  await ready;
  await sync(parent, store);
  emitters.get(child)?.emit("change", "rename", "甲.txt");
  const started = Date.now();
  while (!logs.some(item => item.includes("已停止監看已合併的根目錄")) && Date.now() - started < 3000) {
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  stop();
  assert.equal(await running, 0);
  assert.match(logs.join("\n"), /已停止監看已合併的根目錄/);
  assert.match(logs.join("\n"), /請以新根/);
  assert.doesNotMatch(logs.join("\n"), /已停止監看移除的根目錄：.*other/);
  store.close();
  await rm(temp, { recursive: true, force: true });
});

test("M26 abort after merge keeps transferred documents", () => fixture(async (temp, store) => {
  const parent = path.join(temp, "parent");
  const child = path.join(parent, "child");
  await mkdir(child, { recursive: true });
  await writeFile(path.join(child, "甲.txt"), "子根內容");
  await writeFile(path.join(parent, "外.txt"), "外層內容");
  await sync(child, store);
  const id = store.getDocument(path.join(child, "甲.txt"))!.id;
  const ac = new AbortController();
  await assert.rejects(sync(parent, store, {
    signal: ac.signal,
    onProgress: update => { if (update.stage === "read") ac.abort(); },
  }), OperationCancelledError);
  assert.deepEqual(store.roots(), [parent]);
  assert.equal(store.documentRoot(id), parent);
  assert.equal(search(store, "子根內容").length, 1);
  assert.equal(store.getLastSyncReport(parent).complete, false);
}));

test("M26 write lock still blocks parent merge", () => fixture(async (temp, store) => {
  const parent = path.join(temp, "parent");
  const child = path.join(parent, "child");
  await mkdir(child, { recursive: true });
  await writeFile(path.join(child, "甲.txt"), "內容");
  await sync(child, store);
  const release = acquireWriteLock(store.databasePath);
  try { await assert.rejects(sync(parent, store), { code: "INDEX_BUSY" }); }
  finally { release(); }
  assert.deepEqual(store.roots(), [child]);
}));

test("M26 offline subtree leaves parent documents in place", () => fixture(async (temp, store) => {
  const parent = path.join(temp, "parent");
  const child = path.join(parent, "child");
  await mkdir(child, { recursive: true });
  await writeFile(path.join(parent, "外.txt"), "外層內容");
  await writeFile(path.join(child, "內.txt"), "內層內容");
  await sync(parent, store);
  const offline = `${child} offline`;
  await rename(child, offline);
  await assert.rejects(sync(child, store), RootError);
  assert.equal(search(store, "外層內容").length, 1);
  assert.equal(search(store, "內層內容").length, 1);
}));
