// SPEC §56：以真實 fs.watch 量測移入大型資料夾後，新建一般檔案多久可以搜尋、資料夾多久處理完。
// 用法：node scripts/benchmark-autoupdate-movein.mjs [--dist <dist 目錄>] [--files 600] [--kib 700] [--limit-seconds 300]
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const option = name => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
const dist = path.resolve(option("--dist") ?? "dist");
const files = Number(option("--files") ?? 600);
const kib = Number(option("--kib") ?? 700);
const limitSeconds = Number(option("--limit-seconds") ?? 300);
const load = file => import(pathToFileURL(path.join(dist, "src", file)).href);
const { IndexStore } = await load("store.js");
const { sync } = await load("sync.js");
const { search } = await load("search.js");
const { LiveUpdateEngine } = await load("live-update.js");

const temp = await mkdtemp(path.join(os.tmpdir(), "seekah-bench-movein-"));
const root = path.join(temp, "home");
const staging = path.join(temp, "staging", "bundle");
await mkdir(path.join(root, "tool"), { recursive: true });
await mkdir(path.join(root, "Desktop"), { recursive: true });
await writeFile(path.join(root, "Desktop", "seed.md"), "seed");
// 在監看範圍外準備大型資料夾（類似 .grok：600 個檔案、約 420 MB）。
for (let group = 0; group < 6; group++) await mkdir(path.join(staging, `pack${group}`), { recursive: true });
const line = "bundled skill reference text for moved folder benchmark ";
const body = index => `# bundle ${index}\n\n` + line.repeat(Math.ceil((kib * 1024) / line.length));
for (let index = 0; index < files; index++) await writeFile(path.join(staging, `pack${index % 6}`, `s${index}.md`), body(index));
const store = new IndexStore(path.join(temp, "index.db"));
await sync(root, store);

let stop;
const stopped = new Promise(resolve => { stop = resolve; });
const engine = new LiveUpdateEngine(store, [store.roots()[0]], {
  mode: "foreground", debounceMs: 1500, reconcileMs: 0, syncNow: false,
}, { write: () => {}, waitForStop: () => stopped });
const running = engine.run();
await new Promise(resolve => setTimeout(resolve, 500));

const movedAt = performance.now();
await rename(staging, path.join(root, "tool", "bundle"));
await new Promise(resolve => setTimeout(resolve, 1000));
const needle = `movein-bench-${Date.now()}`;
await writeFile(path.join(root, "Desktop", "新筆記.md"), `# 測試\n\n${needle}\n`);
const createdAt = performance.now();

let visibleMs = null;
let doneMs = null;
while (performance.now() - movedAt < limitSeconds * 1000) {
  if (visibleMs === null && search(store, needle).length === 1) visibleMs = Math.round(performance.now() - createdAt);
  if (doneMs === null && search(store, `bundle ${files - 1}`).length >= 1 && engine.snapshot().queuePendingCount === 0) {
    doneMs = Math.round(performance.now() - movedAt);
  }
  if (visibleMs !== null && doneMs !== null) break;
  await new Promise(resolve => setTimeout(resolve, 500));
}
const snap = engine.snapshot();
console.log(JSON.stringify({
  dist, files, kib, limitSeconds,
  newFileVisibleMs: visibleMs,
  folderIndexedMs: doneMs,
  subtreeScanCount: snap.subtreeScanCount,
  localUpdateCount: snap.localUpdateCount,
  queuePendingCount: snap.queuePendingCount,
}, null, 2));
stop();
await Promise.race([running, new Promise(resolve => setTimeout(resolve, 60_000))]);
try { store.close(); } catch { /* 停止逾時時仍在寫入 */ }
await rm(temp, { recursive: true, force: true }).catch(() => {});
process.exit(0);
