// SPEC §55：以真實 fs.watch 量測大型直屬子目錄內持續改寫檔案時，子樹掃描次數、CPU 與新檔可搜尋延遲。
// 用法：node scripts/benchmark-autoupdate-dirchange.mjs [--dist <dist 目錄>] [--files 300] [--kib 256] [--seconds 40]
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const option = name => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
const dist = path.resolve(option("--dist") ?? "dist");
const files = Number(option("--files") ?? 300);
const kib = Number(option("--kib") ?? 256);
const seconds = Number(option("--seconds") ?? 40);
const load = file => import(pathToFileURL(path.join(dist, "src", file)).href);
const { IndexStore } = await load("store.js");
const { sync } = await load("sync.js");
const { search } = await load("search.js");
const { LiveUpdateEngine } = await load("live-update.js");

const temp = await mkdtemp(path.join(os.tmpdir(), "seekah-bench-dirchange-"));
const root = path.join(temp, "home");
const tool = path.join(root, "tool", "bundled");
await mkdir(tool, { recursive: true });
await mkdir(path.join(root, "Desktop"), { recursive: true });
const body = index => `# skill ${index}\n\n` + `reference line ${index} `.repeat(Math.ceil((kib * 1024) / 20));
for (let index = 0; index < files; index++) await writeFile(path.join(tool, `s${index}.md`), body(index));
await writeFile(path.join(root, "Desktop", "seed.md"), "seed");
const store = new IndexStore(path.join(temp, "index.db"));
await sync(root, store);

let stop;
const stopped = new Promise(resolve => { stop = resolve; });
const engine = new LiveUpdateEngine(store, [store.roots()[0]], {
  mode: "foreground", debounceMs: 1500, reconcileMs: 0, syncNow: false,
}, { write: () => {}, waitForStop: () => stopped });
const running = engine.run();
await new Promise(resolve => setTimeout(resolve, 500));

// 工具在大型子目錄裡一份接一份改寫檔案（例如重新解開 bundled skills）。
let rewriting = true;
let rewrites = 0;
const rewriter = (async () => {
  while (rewriting) {
    await writeFile(path.join(tool, `s${rewrites % files}.md`), body(rewrites));
    rewrites++;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
})();

const cpuStart = process.cpuUsage();
const wallStart = performance.now();
await new Promise(resolve => setTimeout(resolve, 5000));
const needle = `dirchange-bench-${Date.now()}`;
await writeFile(path.join(root, "Desktop", "新筆記.md"), `# 測試\n\n${needle}\n`);
const createdAt = performance.now();
let visibleMs = null;
while (performance.now() - wallStart < seconds * 1000) {
  if (visibleMs === null && search(store, needle).length === 1) visibleMs = Math.round(performance.now() - createdAt);
  await new Promise(resolve => setTimeout(resolve, 200));
}
rewriting = false;
await rewriter;
const cpu = process.cpuUsage(cpuStart);
const wallMs = performance.now() - wallStart;
const snap = engine.snapshot();
console.log(JSON.stringify({
  dist, files, kib, seconds, rewrites,
  cpuPercentOfOneCore: Math.round(((cpu.user + cpu.system) / 1000 / wallMs) * 1000) / 10,
  newFileVisibleMs: visibleMs,
  eventCount: snap.eventCount,
  subtreeScanCount: snap.subtreeScanCount,
  localUpdateCount: snap.localUpdateCount,
  queuePendingCount: snap.queuePendingCount,
}, null, 2));
stop();
await Promise.race([running, new Promise(resolve => setTimeout(resolve, 30_000))]);
try { store.close(); } catch { /* 停止逾時時仍在寫入 */ }
await rm(temp, { recursive: true, force: true }).catch(() => {});
process.exit(0);
