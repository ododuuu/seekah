// Full decompress+match over every chunk with N worker threads (the worst case for common queries).
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import { openDb } from "./common.mjs";
import { decompress, matchBytes, storePath } from "./store.mjs";

if (!isMainThread) {
  const { file, from, to } = workerData;
  const store = openDb(file, { readOnly: true });
  const rows = store.prepare("SELECT doc_id, text, layout FROM chunks WHERE id BETWEEN ? AND ?").all(from, to);
  parentPort.on("message", query => {
    const needle = Buffer.from(query, "utf8"), out = [];
    for (const row of rows) matchBytes(row.doc_id, decompress(row.text), row.layout, needle, out);
    parentPort.postMessage(out.length);
  });
  parentPort.postMessage("ready");
} else {
  const chunkChars = Number(process.argv[2] ?? 65536);
  const file = storePath(chunkChars, 3);
  const total = openDb(file, { readOnly: true }).prepare("SELECT max(id) AS n FROM chunks").get().n;
  const results = {};
  for (const threads of [1, 4, 8, 16]) {
    const size = Math.ceil(total / threads);
    const workers = Array.from({ length: threads }, (_, i) => new Worker(fileURLToPath(import.meta.url), { workerData: { file, from: i * size + 1, to: (i + 1) * size } }));
    await Promise.all(workers.map(w => new Promise(resolve => w.once("message", resolve))));
    const ask = query => Promise.all(workers.map(w => new Promise(resolve => { w.once("message", resolve); w.postMessage(query); })));
    results[threads] = {};
    for (const query of ["spec.md", "function", "ing", "e"]) {
      await ask(query); // warm
      const t = performance.now();
      const counts = await ask(query);
      results[threads][query] = { ms: Math.round(performance.now() - t), hits: counts.reduce((a, b) => a + b, 0) };
    }
    await Promise.all(workers.map(w => w.terminate()));
  }
  console.log(JSON.stringify(results, null, 1));
}
