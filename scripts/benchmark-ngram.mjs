import { fork } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const monitor = path.join(project, "scripts", "measure-process.mjs");
const output = path.resolve(process.argv[2] ?? "docs/benchmark-ngram.json");
const documentCount = Number(process.env.SEEKAH_NGRAM_BENCHMARK_DOCUMENTS ?? 2400);
const queries = [
  { name: "rare", query: "rare-token-1873" },
  { name: "common", query: "共同詞" },
  { name: "twoChar", query: "測試" },
  { name: "threeChar", query: "測試詞" },
  { name: "longPhrase", query: "long phrase alpha beta gamma delta epsilon zeta" },
];

function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1))];
}

function contentFor(index) {
  const rare = index === 1873 ? " rare-token-1873" : "";
  const three = index % 17 === 0 ? " 測試詞" : "";
  return `共同詞 commonword ${"背景資料 ".repeat(4)}${rare}${three} long phrase alpha beta gamma delta epsilon zeta`;
}

async function runWorker(mode, databasePath) {
  return await new Promise((resolve, reject) => {
    const child = fork(fileURLToPath(import.meta.url), ["--worker", mode, databasePath, String(documentCount)], {
      cwd: project, silent: true, execArgv: ["--import", pathToFileURL(monitor).href],
    });
    let stdout = "";
    let stderr = "";
    let metrics;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("message", value => { metrics = value; });
    child.on("error", reject);
    child.on("close", code => {
      if (code !== 0) return reject(new Error(`benchmark worker ${mode} exited ${code}: ${stderr}\n${stdout}`));
      try { resolve({ result: JSON.parse(stdout.trim()), metrics }); }
      catch (error) { reject(new Error(`benchmark worker output invalid: ${stdout}`, { cause: error })); }
    });
  });
}

async function worker() {
  const mode = process.argv[3];
  const databasePath = process.argv[4];
  const count = Number(process.argv[5]);
  const root = `${databasePath}.documents`;
  let setup = new (await import("../dist/src/store.js")).IndexStore(databasePath);
  setup.close();
  if (mode === "baseline") {
    const db = new DatabaseSync(databasePath);
    db.prepare("UPDATE metadata SET value = '0' WHERE key = 'ngram_index_version'").run();
    db.close();
  }
  const { IndexStore } = await import("../dist/src/store.js");
  const { search } = await import("../dist/src/search.js");
  const store = new IndexStore(databasePath);
  const started = performance.now();
  for (let index = 0; index < count; index++) {
    const filename = `document-${index}.txt`;
    store.upsert({
      path: path.join(root, filename), filename, extension: ".txt", sizeBytes: contentFor(index).length, modifiedAtMs: index + 1,
      status: "indexed", errorCode: null, errorMessage: null,
      blocks: [{ ordinal: 0, heading: "Benchmark heading", content: contentFor(index), locationKind: "line", locationValue: "第 1 行" }],
    });
  }
  const indexMs = performance.now() - started;
  const queryResults = {};
  for (const item of queries) {
    search(store, item.query, count + 10);
    const samples = [];
    let resultPaths = [];
    for (let repetition = 0; repetition < 7; repetition++) {
      const queryStarted = performance.now();
      const results = search(store, item.query, count + 10);
      const elapsed = performance.now() - queryStarted;
      if (repetition >= 2) samples.push(elapsed);
      resultPaths = results.map(result => path.basename(result.path)).sort();
    }
    queryResults[item.name] = { query: item.query, count: resultPaths.length,
      resultHash: createHash("sha256").update(JSON.stringify(resultPaths)).digest("hex"),
      firstPaths: resultPaths.slice(0, 3), lastPaths: resultPaths.slice(-3),
      p50Ms: percentile(samples, .5), p95Ms: percentile(samples, .95), samplesMs: samples };
  }
  store.close();
  const bytes = (await stat(databasePath)).size;
  console.log(JSON.stringify({ mode, documentCount: count, indexMs, databaseBytes: bytes, queries: queryResults }));
}

if (process.argv[2] === "--worker") {
  await worker();
} else {
  const work = await (await import("node:fs/promises")).mkdtemp(path.join(os.tmpdir(), "seekah-ngram-benchmark-"));
  try {
    const scenarios = {};
    for (const mode of ["baseline", "ngram"]) {
      const databasePath = path.join(work, `${mode}.db`);
      const run = await runWorker(mode, databasePath);
      scenarios[mode] = { ...run.result, rss: run.metrics ?? null };
    }
    for (const item of queries) {
      const baseline = scenarios.baseline.queries[item.name];
      const ngram = scenarios.ngram.queries[item.name];
      if (baseline.resultHash !== ngram.resultHash) throw new Error(`correctness mismatch for ${item.name}`);
    }
    const baseline = scenarios.baseline;
    const ngram = scenarios.ngram;
    const report = {
      generatedAt: new Date().toISOString(), platform: process.platform, release: os.release(), arch: process.arch, node: process.version,
      version: JSON.parse(await readFile(path.join(project, "package.json"), "utf8")).version,
      dataset: { documents: documentCount, deterministic: true, content: "common/trigram/rare/long-phrase synthetic text" },
      method: "每個 scenario 獨立 Node process；index 為直接 upsert；query 每個 2 次暖機後取 5 次；baseline 將 ngram_index_version 設為 0，使用既有 Bloom/payload fallback；ngram 使用 FTS5 unigram/trigram postings。",
      memoryMethod: "worker 由 scripts/measure-process.mjs 以 5ms 取樣 sampledPeakRss，maxRssKiB 為 Node resourceUsage OS 峰值。",
      scenarios: { baseline, ngram },
      comparison: {
        indexMsRatio: ngram.indexMs / baseline.indexMs,
        indexSizeDeltaBytes: ngram.databaseBytes - baseline.databaseBytes,
        rss: {
          baselineMaxRssKiB: baseline.rss?.maxRssKiB ?? null,
          ngramMaxRssKiB: ngram.rss?.maxRssKiB ?? null,
          baselineSampledPeakRss: baseline.rss?.sampledPeakRss ?? null,
          ngramSampledPeakRss: ngram.rss?.sampledPeakRss ?? null,
        },
        queries: Object.fromEntries(queries.map(item => [item.name, {
          baselineP50Ms: baseline.queries[item.name].p50Ms,
          ngramP50Ms: ngram.queries[item.name].p50Ms,
          baselineP95Ms: baseline.queries[item.name].p95Ms,
          ngramP95Ms: ngram.queries[item.name].p95Ms,
          p95Ratio: ngram.queries[item.name].p95Ms / baseline.queries[item.name].p95Ms,
          resultCount: ngram.queries[item.name].count,
        }])),
      },
      correctness: { resultPathsEqual: true, queryNames: queries.map(item => item.name) },
      limitation: "合成文字、固定文件數；baseline 是同一版本停用 FTS5 的 fallback 對照，不代表其他 SQLite/磁碟配置。",
    };
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, JSON.stringify(report, null, 2) + "\n");
    console.log(`已保存 ${output}`);
    console.log(JSON.stringify(report.comparison, null, 2));
  } finally {
    await (await import("node:fs/promises")).rm(work, { recursive: true, force: true });
  }
}
