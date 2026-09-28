// SPEC §53：以真實 fs.watch 量測被排除資料夾持續寫入時，自動更新的 CPU、事件計數與一般檔案可見延遲。
// 用法：node scripts/benchmark-autoupdate-excluded.mjs [--dist <dist 目錄>] [--seconds 20] [--split|--coarse]
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const option = name => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
const dist = path.resolve(option("--dist") ?? "dist");
const seconds = Number(option("--seconds") ?? 20);
const coarse = args.includes("--coarse");
const load = file => import(pathToFileURL(path.join(dist, "src", file)).href);
const { IndexStore } = await load("store.js");
const { sync } = await load("sync.js");
const { search } = await load("search.js");
const { LiveUpdateEngine } = await load("live-update.js");

const temp = await mkdtemp(path.join(os.tmpdir(), "seekah-bench-excluded-"));
const root = path.join(temp, "home");
const churnDir = path.join(root, "AppData", "Local", "Cache");
await mkdir(churnDir, { recursive: true });
await mkdir(path.join(root, "Documents"), { recursive: true });
for (let index = 0; index < 20; index++) await mkdir(path.join(root, `dir${index}`));
await writeFile(path.join(root, ".localdocsearchignore"), "/AppData/\n");
await writeFile(path.join(root, "Documents", "doc.txt"), "seed");
const store = new IndexStore(path.join(temp, "index.db"));
await sync(root, store);
const registered = store.roots()[0];

let stop;
const stopped = new Promise(resolve => { stop = resolve; });
const engine = new LiveUpdateEngine(store, [registered], {
  mode: "foreground", debounceMs: 1500, reconcileMs: 0, syncNow: false,
  ...(coarse ? { watchHandleLimit: 1 } : {}),
}, { write: () => {}, waitForStop: () => stopped });
const running = engine.run();
await new Promise(resolve => setTimeout(resolve, 500));

// 另一個程序持續改寫被排除資料夾內的 200 個檔案，模擬 AppData 的背景寫入。
const churn = spawn(process.execPath, ["-e", `
  const fs = require("node:fs"); const path = require("node:path");
  const dir = ${JSON.stringify(churnDir)}; let n = 0;
  const end = Date.now() + ${seconds * 1000};
  while (Date.now() < end) { fs.writeFileSync(path.join(dir, "f" + (n % 200) + ".log"), String(n)); n++; }
  process.stdout.write(String(n));
`], { stdio: ["ignore", "pipe", "inherit"] });
let writes = "";
churn.stdout.on("data", chunk => { writes += chunk; });
const churnExited = new Promise(resolve => churn.on("exit", resolve));

const cpuStart = process.cpuUsage();
const wallStart = performance.now();
await new Promise(resolve => setTimeout(resolve, (seconds * 1000) / 2));
const needle = `excluded-bench-${Date.now()}`;
await writeFile(path.join(root, "Documents", "doc.txt"), needle);
const changedAt = performance.now();
let visibleMs = null;
while (performance.now() - changedAt < seconds * 1000) {
  if (search(store, needle).length === 1) { visibleMs = Math.round(performance.now() - changedAt); break; }
  await new Promise(resolve => setTimeout(resolve, 100));
}
await churnExited;
const cpu = process.cpuUsage(cpuStart);
const wallMs = performance.now() - wallStart;
const snap = engine.snapshot();
// 停止前先輸出：舊版可能仍在逐一處理累積的待辦，停止等待另外量測（上限 60 s）。
const stopStarted = performance.now();
stop();
const shutdownMs = await Promise.race([
  running.then(() => Math.round(performance.now() - stopStarted)),
  new Promise(resolve => setTimeout(() => resolve(null), 60_000)),
]);

console.log(JSON.stringify({
  dist, scope: snap.roots[0]?.scopeMode, handles: snap.roots[0]?.handles, seconds,
  excludedWrites: Number(writes),
  cpuPercentOfOneCore: Math.round(((cpu.user + cpu.system) / 1000 / wallMs) * 1000) / 10,
  eventCount: snap.eventCount, excludedEventCount: snap.excludedEventCount ?? null,
  queuePendingCount: snap.queuePendingCount, localUpdateCount: snap.localUpdateCount,
  normalFileVisibleMs: visibleMs,
  shutdownMs,
}, null, 2));
if (shutdownMs !== null) store.close();
await rm(temp, { recursive: true, force: true }).catch(() => {});
process.exit(0);
