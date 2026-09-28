// SPEC §54：以真實 fs.watch 量測數千個檔案湧入後，新建一般檔案多久可以搜尋。
// 用法：node scripts/benchmark-autoupdate-flood.mjs [--dist <dist 目錄>] [--files 2500] [--limit-seconds 180]
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const option = name => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
const dist = path.resolve(option("--dist") ?? "dist");
const files = Number(option("--files") ?? 2500);
const limitSeconds = Number(option("--limit-seconds") ?? 180);
const load = file => import(pathToFileURL(path.join(dist, "src", file)).href);
const { IndexStore } = await load("store.js");
const { sync } = await load("sync.js");
const { search } = await load("search.js");
const { LiveUpdateEngine } = await load("live-update.js");

const temp = await mkdtemp(path.join(os.tmpdir(), "seekah-bench-flood-"));
const root = path.join(temp, "home");
const floodDir = path.join(root, ".tool", "plugins");
await mkdir(floodDir, { recursive: true });
await mkdir(path.join(root, "Desktop"), { recursive: true });
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

// 模擬另一個程式一次解開大量小檔（例如 plugin），接著使用者新建一份筆記。
// 由另一個程序寫入，避免與監看程序搶同一個主執行緒。
const floodStarted = performance.now();
const writer = spawn(process.execPath, ["-e", `
  const fs = require("node:fs"); const path = require("node:path");
  const dir = ${JSON.stringify(floodDir)};
  for (let index = 0; index < ${files}; index++) {
    fs.writeFileSync(path.join(dir, "ref-" + index + ".md"), "# plugin reference " + index + "\\n\\nconfiguration notes " + index + "\\n");
  }
`], { stdio: "inherit" });
await new Promise(resolve => writer.on("exit", resolve));
const floodWriteMs = Math.round(performance.now() - floodStarted);
const needle = `flood-bench-${Date.now()}`;
await writeFile(path.join(root, "Desktop", "新筆記.md"), `# 測試\n\n${needle}\n`);
const createdAt = performance.now();

let visibleMs = null;
while (performance.now() - createdAt < limitSeconds * 1000) {
  if (search(store, needle).length === 1) { visibleMs = Math.round(performance.now() - createdAt); break; }
  await new Promise(resolve => setTimeout(resolve, 200));
}
// 繼續等到佇列清空，量測整體處理量。
let drainMs = null;
while (performance.now() - createdAt < limitSeconds * 1000) {
  if (engine.snapshot().queuePendingCount === 0) { drainMs = Math.round(performance.now() - createdAt); break; }
  await new Promise(resolve => setTimeout(resolve, 500));
}
const snap = engine.snapshot();
console.log(JSON.stringify({
  dist, files, floodWriteMs, limitSeconds,
  newFileVisibleMs: visibleMs,
  queueDrainedMs: drainMs,
  localUpdateCount: snap.localUpdateCount,
  queuePendingCount: snap.queuePendingCount,
  eventCount: snap.eventCount,
  scope: snap.roots[0]?.scopeMode,
}, null, 2));
stop();
await Promise.race([running, new Promise(resolve => setTimeout(resolve, 30_000))]);
try { store.close(); } catch { /* 停止逾時時仍在寫入 */ }
await rm(temp, { recursive: true, force: true }).catch(() => {});
process.exit(0);
