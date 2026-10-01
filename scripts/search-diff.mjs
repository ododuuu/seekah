#!/usr/bin/env node
/**
 * 隨機差分搜尋工具：比較兩個 dist 工作樹的公開搜尋結果與耗時。
 * 合成 corpus 只在本機建立；兩個 store 都以 read-only 開啟同一份合成 index。
 *
 * 用法：
 *   node scripts/search-diff.mjs --base <baseline-worktree> --new <new-worktree> [options]
 *   options: --phase all|generate|small|large --corpus <dir> --data <dir>
 *            --large <synthetic-data-dir> --out-dir <dir>
 */
import { mkdirSync, writeFileSync, existsSync, rmSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";

function parseArgs(argv) {
  const flags = new Map();
  const positional = [];
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }
    const equal = token.indexOf("=");
    if (equal >= 0) flags.set(token.slice(2, equal), token.slice(equal + 1));
    else flags.set(token.slice(2), argv[++index]);
  }
  const phase = flags.get("phase") ?? positional[0] ?? "all";
  if (!["all", "generate", "small", "large"].includes(phase)) throw new Error(`invalid --phase: ${phase}`);
  const required = name => {
    const value = flags.get(name);
    if (!value) throw new Error(`missing --${name}; run with --help for usage`);
    return path.resolve(value);
  };
  if (flags.has("help")) {
    console.log("node scripts/search-diff.mjs --base <worktree> --new <worktree> [--phase all|generate|small|large] [--corpus dir] [--data dir] [--large dir] [--out-dir dir]");
    process.exit(0);
  }
  return {
    phase,
    base: required("base"),
    next: required("new"),
    corpus: path.resolve(flags.get("corpus") ?? path.join(os.tmpdir(), "seekah-search-diff-corpus")),
    data: path.resolve(flags.get("data") ?? path.join(os.tmpdir(), "seekah-search-diff-data")),
    large: path.resolve(flags.get("large") ?? path.join(os.tmpdir(), "seekah-search-perf-repro-data")),
    outDir: path.resolve(flags.get("out-dir") ?? path.join(os.tmpdir(), "seekah-search-diff")),
  };
}

const args = parseArgs(process.argv.slice(2));
const BASE = args.base;
const NEW = args.next;
const CORPUS = args.corpus;
const DATA = args.data;
const LARGE = args.large;
const OUT_DIR = args.outDir;
mkdirSync(OUT_DIR, { recursive: true });

const NINETEEN_HIT = "4564654564651431321";
const NINETEEN_MISS = "1112223334445556667";
const CROSS_L = "ZXQLEFTMARK";
const CROSS_R = "ZXQRIGHTMARK";
const HEAD_MARK = "HDGMARKTOKEN";
const BODY_MARK = "BDYMARKTOKEN";
const FN_ONLY = "fnonlyneedle";
const BOTH = "seekahnotes";
const FULLWIDTH = "Ｓｅｅｋａｈ";
const CJK = "規格查詢";
const SUPPLEMENTARY = "😀𐀀𝄞";
const NFKC_EXPAND = "①②③④⑤⑥⑦⑧";
const PHRASE7 = "abcdefg";
const PHRASE8 = "abcdefgh";
const PHRASE9 = "abcdefghi";

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
  return value;
}

function stableJson(value) {
  return JSON.stringify(stable(value));
}

function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state += 0x6D2B79F5;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function pick(rand, values) {
  return values[Math.floor(rand() * values.length)];
}

function muteTraces(store) {
  store.recordSearchTrace = function recordSearchTrace(trace) {
    this.latestSearchTrace = trace;
  };
}

function generateCorpus() {
  const alpha = path.join(CORPUS, "alpha");
  const beta = path.join(CORPUS, "beta");
  rmSync(CORPUS, { recursive: true, force: true });
  mkdirSync(path.join(alpha, "sub", "deep"), { recursive: true });
  mkdirSync(path.join(alpha, "nums"), { recursive: true });
  mkdirSync(path.join(alpha, "cjk"), { recursive: true });
  mkdirSync(path.join(alpha, "long"), { recursive: true });
  mkdirSync(path.join(alpha, "bins"), { recursive: true });
  mkdirSync(path.join(beta, "notes"), { recursive: true });
  mkdirSync(path.join(beta, "mix"), { recursive: true });
  mkdirSync(path.join(beta, "bins"), { recursive: true });

  const rand = mulberry32(20261001);
  const english = [
    "The quick brown fox jumps over the lazy dog.",
    "Seekah indexes local documents without uploading content.",
    "Repeated word word word appears often in this paragraph.",
    "Mixed CASE SensitivE Tokens like Notes and NOTES and notes.",
    `${PHRASE7} ${PHRASE8} ${PHRASE9} sit together for length gates.`,
  ];
  const cjkLines = [
    `這是中英混合文件，包含 ${CJK} 與 Seekah 產品說明。`,
    "全形英數：" + FULLWIDTH + " 以及半形 seekah。",
    `代理對與 NFKC：${SUPPLEMENTARY.repeat(3)} ${NFKC_EXPAND}。`,
    "標題與段落測試：規格、查詢、索引、校正。",
  ];

  writeFileSync(path.join(alpha, "nineteen-hit.txt"), `hit ${NINETEEN_HIT} in body\nmore text\n`);
  writeFileSync(path.join(alpha, "nums", "invoice-19.md"), `# Invoice\n\nAccount ${NINETEEN_HIT} paid.\n`);
  writeFileSync(path.join(alpha, "cross-block.txt"), `${CROSS_L} ends this paragraph.\n\n${CROSS_R} starts the next paragraph.\n`);
  writeFileSync(path.join(alpha, "head-body.md"), `# ${HEAD_MARK} heading\n\n${BODY_MARK} is only in the body.\n`);
  writeFileSync(path.join(beta, "notes", `${BOTH}.md`), `# ${BOTH}\n\nContent also mentions ${BOTH} and notes.\n`);
  writeFileSync(path.join(alpha, "fullwidth.txt"), `fullwidth ${FULLWIDTH} mixed seekah\n`);
  writeFileSync(path.join(alpha, "cjk", "spec.md"), `# ${CJK}\n\n${cjkLines.join("\n")}\n`);

  let long = "";
  while (Buffer.byteLength(long, "utf8") < 80_000) long += `Paragraph ${long.length} filler lorem ${PHRASE8} notes.\n\n`;
  long = `STARTCHUNK ${PHRASE9}\n\n` + long + "\n\nENDCHUNK marker after many blocks.\n";
  writeFileSync(path.join(alpha, "long", "huge.txt"), long);

  for (let index = 0; index < 2800; index++) {
    const dir = index % 3 === 0 ? path.join(alpha, "sub") : index % 3 === 1 ? path.join(alpha, "sub", "deep") : path.join(alpha, "nums");
    const extension = index % 5 === 0 ? ".md" : ".txt";
    const heading = index % 7 === 0 ? `# Heading ${index} notes\n\n` : "";
    const digit = index % 40 === 0 ? ` ${NINETEEN_HIT} ` : index % 41 === 0 ? ` ${1000000000 + index} ` : " ";
    const body = `${heading}${pick(rand, english)}\n${pick(rand, cjkLines)}\nCase Mix ${index} NOTES notes Notes${digit}\n`;
    writeFileSync(path.join(dir, `doc-${String(index).padStart(4, "0")}${extension}`), body);
  }
  for (let index = 0; index < 700; index++) {
    const body = `Beta note ${index} ${pick(rand, english)}\n${CJK} line ${index}\n`;
    writeFileSync(path.join(beta, "notes", `beta-${String(index).padStart(4, "0")}.md`), body);
  }
  for (let index = 0; index < 400; index++) {
    const body = `Mix ${index} ${FULLWIDTH} abcdefgh punctuation ,.;!?\n`;
    writeFileSync(path.join(beta, "mix", `mix-${String(index).padStart(4, "0")}.txt`), body);
  }
  for (let index = 0; index < 350; index++) writeFileSync(path.join(alpha, "bins", `${FN_ONLY}-${index}.bin`), Buffer.from([0, 1, 2, 3, index & 255]));
  for (let index = 0; index < 150; index++) writeFileSync(path.join(beta, "bins", `otherbin-${index}.zip`), Buffer.from("PK"));
  return { alpha, beta };
}

function indexCorpus(alpha, beta) {
  rmSync(DATA, { recursive: true, force: true });
  mkdirSync(DATA, { recursive: true });
  const env = { ...process.env, LOCALDOCSEARCH_DATA_DIR: DATA };
  const cli = path.join(BASE, "dist/src/cli.js");
  for (const root of [alpha, beta]) {
    const result = spawnSync(process.execPath, [cli, "index", root], { encoding: "utf8", env, timeout: 180_000 });
    if (result.status !== 0) throw new Error(`index ${root} failed: ${result.stderr || result.stdout}`);
  }
}

function summarizeHit(hit) {
  const copy = { ...hit };
  delete copy.passages;
  delete copy.omittedTerms;
  return copy;
}

function summarizeRanked(hit) {
  return { documentId: hit.documentId, sourceKind: hit.sourceKind, ordinal: hit.ordinal, result: summarizeHit(hit.result) };
}

function runOne(api, store, spec) {
  const mode = spec.mode ?? "phrase";
  const totalMode = spec.totalMode ?? "fast";
  const stream = api.openHits(store, spec.query, {
    ...(spec.types ? { types: spec.types } : {}),
    ...(spec.root ? { root: spec.root } : {}),
    mode,
    ...(spec.subtree ? { subtree: spec.subtree } : {}),
    field: spec.field ?? "all",
    ...(spec.statuses ? { statuses: spec.statuses } : {}),
    sort: spec.sort ?? "relevance",
    ...(spec.within ? { within: spec.within } : {}),
  });
  stream.fill(api.totalTarget(totalMode));
  stream.fill(spec.page * spec.pageSize);
  const page = api.materializeHits(store, stream.results, spec.query, mode, spec.page, spec.pageSize);
  return {
    total: stream.results.length,
    totalRelation: stream.done ? "eq" : "gte",
    page: page.page,
    pageSize: page.pageSize,
    pageCount: page.pageCount,
    start: page.start,
    end: page.end,
    ranked: stream.results.map(summarizeRanked),
    results: page.results.map(summarizeHit),
  };
}

function diffResults(base, next) {
  const diffs = [];
  for (const key of ["total", "totalRelation", "page", "pageSize", "pageCount", "start", "end"]) {
    if (base[key] !== next[key]) diffs.push(`${key}: base=${base[key]} new=${next[key]}`);
  }
  if (stableJson(base.ranked) !== stableJson(next.ranked)) {
    diffs.push(`ranked differs (ordered full list): base=${base.ranked.length} new=${next.ranked.length}`);
    const limit = Math.max(base.ranked.length, next.ranked.length);
    for (let index = 0; index < limit; index++) {
      if (stableJson(base.ranked[index]) !== stableJson(next.ranked[index])) {
        diffs.push(`ranked[${index}] differs: base=${stableJson(base.ranked[index])} new=${stableJson(next.ranked[index])}`);
        break;
      }
    }
  }
  if (stableJson(base.results) !== stableJson(next.results)) {
    diffs.push(`results differs (ordered page, passages omitted): base=${base.results.length} new=${next.results.length}`);
    const limit = Math.max(base.results.length, next.results.length);
    for (let index = 0; index < limit; index++) {
      if (stableJson(base.results[index]) !== stableJson(next.results[index])) {
        diffs.push(`result[${index}] differs: base=${stableJson(base.results[index])} new=${stableJson(next.results[index])}`);
        break;
      }
    }
  }
  return diffs;
}

function buildSmallQueries(alpha, beta, rand) {
  const queries = [];
  const push = (spec, tag) => queries.push({ mode: "phrase", field: "all", sort: "relevance", page: 1, pageSize: 20, totalMode: "exact", tag, ...spec });
  push({ query: NINETEEN_HIT }, "fixed-19-hit");
  push({ query: NINETEEN_MISS }, "fixed-19-miss");
  push({ query: NINETEEN_HIT, field: "content" }, "fixed-19-content");
  push({ query: `${CROSS_L} ${CROSS_R}` }, "fixed-cross-block");
  push({ query: `${HEAD_MARK} ${BODY_MARK}` }, "fixed-head-body-phrase");
  push({ query: `${HEAD_MARK} ${BODY_MARK}`, mode: "all-terms" }, "fixed-head-body-allterms");
  push({ query: `${HEAD_MARK} ${BODY_MARK}`, mode: "all-terms", field: "content" }, "fixed-head-body-content-allterms");
  push({ query: FN_ONLY, field: "filename" }, "fixed-filename-only");
  push({ query: FN_ONLY }, "fixed-filename-only-all");
  push({ query: BOTH }, "fixed-name-and-content");
  push({ query: PHRASE7 }, "fixed-len7");
  push({ query: PHRASE8 }, "fixed-len8");
  push({ query: PHRASE9 }, "fixed-len9");
  push({ query: SUPPLEMENTARY }, "fixed-supplementary");
  push({ query: `${SUPPLEMENTARY}${SUPPLEMENTARY}${SUPPLEMENTARY}`, totalMode: "fast" }, "fixed-supplementary-9cp");
  push({ query: NFKC_EXPAND }, "fixed-nfkc-expansion");
  push({ query: "a  b" }, "fixed-internal-whitespace");
  push({ query: FULLWIDTH }, "fixed-fullwidth");
  push({ query: CJK }, "fixed-cjk");
  push({ query: "notes" }, "fixed-common");
  push({ query: "notes", totalMode: "fast" }, "fixed-common-fast");
  push({ query: "notes", field: "filename" }, "fixed-common-filename");
  push({ query: "notes", field: "content" }, "fixed-common-content");
  push({ query: "notes", sort: "filename" }, "fixed-sort-filename");
  push({ query: "notes", sort: "modified" }, "fixed-sort-modified");
  push({ query: "notes", page: 3, pageSize: 10 }, "fixed-page3");
  push({ query: "notes", page: 3, pageSize: 10, totalMode: "fast" }, "fixed-page3-fast");
  push({ query: "notes", types: [".md"] }, "fixed-types-md");
  push({ query: FN_ONLY, statuses: ["unsupported"] }, "fixed-status-unsupported");
  push({ query: "notes", types: [".md"], statuses: ["indexed"], root: alpha, subtree: path.join(alpha, "sub") }, "fixed-scope-combined");
  push({ query: "notes", root: alpha, subtree: path.join(alpha, "sub") }, "fixed-subtree");
  push({ query: "Beta note", root: beta }, "fixed-root-beta");
  push({ query: "does-not-exist-zzqx" }, "fixed-no-hit");
  push({ query: "word word", mode: "all-terms" }, "fixed-allterms-repeat");
  push({ query: "notes seekah", mode: "all-terms" }, "fixed-allterms-split");
  push({ query: "Seekah indexes", mode: "phrase" }, "fixed-english-phrase");
  push({ query: "STARTCHUNK" }, "fixed-long-start");
  push({ query: "ENDCHUNK" }, "fixed-long-end");

  const alphabets = [
    "abcdefghijklmnopqrstuvwxyz", "ABCDEFGHIJKLMNOPQRSTUVWXYZ", "0123456789",
    "的一是不了人我在有他這中大來上國個到說們為時要就出也", "Ｓｅｅｋａｈ１２３", "notesSEEKAH", SUPPLEMENTARY, NFKC_EXPAND,
  ];
  const planted = [NINETEEN_HIT, PHRASE7, PHRASE8, PHRASE9, CJK, SUPPLEMENTARY, NFKC_EXPAND,
    "notes", "NOTES", "Seekah", "invoice", "Heading", "fox", "lazy", "規格", "查詢", FN_ONLY, BOTH, "punctuation", "a  b"];
  const modes = ["phrase", "all-terms"];
  const fields = ["all", "filename", "content"];
  const sorts = ["relevance", "filename", "modified"];
  const lengths = [];
  for (let length = 1; length <= 30; length++) lengths.push(length);
  for (const length of [7, 8, 9, 7, 8, 9, 8, 8]) lengths.push(length);

  while (queries.length < 650) {
    const kind = rand();
    let query;
    if (kind < 0.25) {
      query = pick(rand, planted);
      const codePoints = [...query];
      if (rand() < 0.3 && codePoints.length > 2) {
        const start = Math.floor(rand() * (codePoints.length - 1));
        const length = 1 + Math.floor(rand() * (codePoints.length - start));
        query = codePoints.slice(start, start + length).join("");
      }
    } else if (kind < 0.4) {
      const length = 8 + Math.floor(rand() * 12);
      query = Array.from({ length }, () => String(Math.floor(rand() * 10))).join("");
    } else if (kind < 0.55) query = `${pick(rand, planted)} ${pick(rand, planted)}`;
    else if (kind < 0.65) query = `${pick(rand, planted)}, ${pick(rand, ["!", "?", ".", ";"])}`;
    else {
      const length = pick(rand, lengths);
      const chars = [...pick(rand, alphabets)];
      query = Array.from({ length }, () => chars[Math.floor(rand() * chars.length)]).join("");
    }
    query = String(query).trim();
    if (!query) continue;
    const mode = pick(rand, modes);
    if (mode === "all-terms" && !/\s/u.test(query) && rand() < 0.5) query = `${query} ${pick(rand, planted)}`;
    const spec = { query, mode, field: pick(rand, fields), sort: pick(rand, sorts), page: 1,
      pageSize: rand() < 0.12 ? 10 : 20, totalMode: "fast", tag: `rand-${queries.length}` };
    if (rand() < 0.08) spec.types = [pick(rand, [".txt", ".md", ".bin"])]
    if (rand() < 0.06) spec.statuses = [pick(rand, ["indexed", "unsupported"])]
    if (rand() < 0.08) spec.root = pick(rand, [alpha, beta]);
    if (rand() < 0.04) { spec.root = alpha; spec.subtree = path.join(alpha, "sub"); }
    push(spec, spec.tag);
  }
  return queries;
}

async function loadModules(root) {
  const searchUrl = pathToFileURL(path.join(root, "dist/src/search.js")).href;
  const storeUrl = pathToFileURL(path.join(root, "dist/src/store.js")).href;
  const [searchMod, storeMod] = await Promise.all([import(searchUrl), import(storeUrl)]);
  return { openHits: searchMod.openHits, totalTarget: searchMod.totalTarget, materializeHits: searchMod.materializeHits, IndexStore: storeMod.IndexStore };
}

function percentile(values, fraction) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))];
}

function timingSummary(rows) {
  const summarize = key => {
    const values = rows.map(row => row[key]).filter(Number.isFinite);
    const totalMs = values.reduce((sum, value) => sum + value, 0);
    return values.length ? { count: values.length, totalMs, meanMs: totalMs / values.length, p50Ms: percentile(values, 0.50), p95Ms: percentile(values, 0.95), maxMs: Math.max(...values) }
      : { count: 0, totalMs: 0, meanMs: 0, p50Ms: null, p95Ms: null, maxMs: 0 };
  };
  const base = summarize("baseMs");
  const next = summarize("newMs");
  return { base, new: next, totalRatio: base.totalMs > 0 ? next.totalMs / base.totalMs : null, totalDeltaMs: next.totalMs - base.totalMs };
}

function compareBatch(label, queries, dbPath, baseApi, newApi, timingsOut) {
  const baseStore = new baseApi.IndexStore(dbPath, { readOnly: true });
  const newStore = new newApi.IndexStore(dbPath, { readOnly: true });
  muteTraces(baseStore);
  muteTraces(newStore);
  const mismatches = [];
  let compared = 0;
  let errors = 0;
  let commonErrors = 0;
  try {
    for (const spec of queries) {
      compared++;
      if (compared % 25 === 0 || queries.length <= 40) console.log(`${label} progress ${compared}/${queries.length} mismatches=${mismatches.length} tag=${spec.tag}`);
      const run = (api, store) => {
        const started = performance.now();
        let result;
        let error;
        try { result = runOne(api, store, spec); }
        catch (caught) { error = caught instanceof Error ? caught.message : String(caught); }
        return { result, error, elapsedMs: performance.now() - started };
      };
      let baseRun;
      let newRun;
      if (compared % 2) { baseRun = run(baseApi, baseStore); newRun = run(newApi, newStore); }
      else { newRun = run(newApi, newStore); baseRun = run(baseApi, baseStore); }
      timingsOut?.push({ tag: spec.tag, query: spec.query, field: spec.field, mode: spec.mode, sort: spec.sort,
        baseMs: baseRun.elapsedMs, newMs: newRun.elapsedMs, total: newRun.result?.total ?? baseRun.result?.total ?? null,
        totalRelation: newRun.result?.totalRelation ?? baseRun.result?.totalRelation ?? null,
        baseError: baseRun.error ?? null, newError: newRun.error ?? null });
      if (baseRun.error || newRun.error) {
        if (baseRun.error === newRun.error) { commonErrors++; continue; }
        errors++;
        mismatches.push({ classification: "error-difference", tag: spec.tag, query: spec.query,
          error: `base=${baseRun.error ?? "ok"} new=${newRun.error ?? "ok"}`, spec });
        continue;
      }
      const diffs = diffResults(baseRun.result, newRun.result);
      if (diffs.length) mismatches.push({ classification: "semantic-or-order-difference", tag: spec.tag, query: spec.query,
        spec: { mode: spec.mode, field: spec.field, sort: spec.sort, page: spec.page, pageSize: spec.pageSize,
          totalMode: spec.totalMode, types: spec.types, statuses: spec.statuses, root: spec.root, subtree: spec.subtree, within: spec.within },
        diffs, baseResult: baseRun.result, newResult: newRun.result });
    }
  } finally {
    baseStore.close();
    newStore.close();
  }
  return { label, compared, errors, commonErrors, mismatchCount: mismatches.length, mismatches };
}

const phase = args.phase;
if (phase === "generate" || phase === "all") {
  console.log("generating synthetic corpus");
  const { alpha, beta } = generateCorpus();
  console.log("indexing synthetic corpus with baseline CLI");
  indexCorpus(alpha, beta);
  writeFileSync(path.join(OUT_DIR, "search-diff-roots.json"), JSON.stringify({ alpha, beta, db: path.join(DATA, "LocalDocSearch", "index.db") }, null, 2));
}

const rootsFile = path.join(OUT_DIR, "search-diff-roots.json");
if (!existsSync(rootsFile) && (phase === "small" || phase === "all")) throw new Error(`missing generated roots file ${rootsFile}; run --phase generate first`);
const roots = existsSync(rootsFile) ? JSON.parse(readFileSync(rootsFile, "utf8")) : undefined;
const baseApi = await loadModules(BASE);
const newApi = await loadModules(NEW);

if (phase === "small" || phase === "all") {
  const queries = buildSmallQueries(roots.alpha, roots.beta, mulberry32(424242));
  const timings = [];
  console.log(`small batch queries=${queries.length}`);
  const small = compareBatch("small-synthetic", queries, roots.db, baseApi, newApi, timings);
  small.timings = timings;
  small.timingSummary = timingSummary(timings);
  small.comparison = "all compared result fields; passages and omittedTerms are omitted only from the stable materialized projection";
  writeFileSync(path.join(OUT_DIR, "search-diff-small.json"), JSON.stringify(small, null, 2));
  console.log(`small compared=${small.compared} mismatches=${small.mismatchCount} errors=${small.errors} commonErrors=${small.commonErrors}`);
  console.log(`small timing ${JSON.stringify(small.timingSummary)}`);
}

if (phase === "large" || phase === "all") {
  const largeDb = path.join(LARGE, "LocalDocSearch", "index.db");
  if (!existsSync(largeDb)) throw new Error(`missing large synthetic index ${largeDb}`);
  const peek = new baseApi.IndexStore(largeDb, { readOnly: true });
  muteTraces(peek);
  const largeRoots = peek.roots();
  const counts = peek.counts();
  peek.close();
  const largeQueries = [
    { query: "notes", field: "filename", tag: "L-notes-filename" }, { query: "notes", field: "content", tag: "L-notes-content" },
    { query: "notes", field: "all", tag: "L-notes-all" }, { query: "seekah", field: "all", tag: "L-seekah-all" },
    { query: NINETEEN_HIT, field: "all", tag: "L-19-hit-or-not" }, { query: NINETEEN_MISS, field: "all", tag: "L-19-miss" },
    { query: "the", field: "content", tag: "L-the-content" }, { query: "e", field: "all", tag: "L-e-all" },
    { query: "index", field: "all", tag: "L-index-all" }, { query: "txt", field: "filename", tag: "L-txt-filename" },
    { query: "README", field: "filename", tag: "L-readme" }, { query: "config", field: "all", tag: "L-config" },
    { query: "123456789", field: "all", tag: "L-9digits" }, { query: PHRASE8, field: "all", tag: "L-8cp" },
    { query: PHRASE7, field: "all", tag: "L-7cp" }, { query: PHRASE9, field: "all", tag: "L-9cp" },
    { query: "notes seekah", mode: "all-terms", field: "all", tag: "L-allterms" }, { query: "notes", sort: "filename", tag: "L-sort-filename" },
    { query: "notes", sort: "modified", tag: "L-sort-modified" }, { query: "notes", page: 3, pageSize: 10, tag: "L-page3" },
    { query: "dll", field: "filename", tag: "L-dll-filename" }, { query: "log", field: "all", tag: "L-log" },
    { query: "windows", field: "filename", tag: "L-windows-fn" }, { query: "zzznotfoundqqq", field: "all", tag: "L-absent" },
    { query: "0", field: "content", tag: "L-zero-content" }, { query: "document", field: "all", tag: "L-document" },
    { query: "xml", field: "filename", tag: "L-xml-fn" }, { query: "test", field: "all", tag: "L-test" },
    { query: "data", field: "content", tag: "L-data-content" }, { query: "local", field: "all", tag: "L-local" },
  ].map(item => ({ mode: "phrase", field: "all", sort: "relevance", page: 1, pageSize: 20, totalMode: "fast", ...item }));
  const timings = [];
  console.log(`large roots=${largeRoots.length} counts=${JSON.stringify(counts)}`);
  const large = compareBatch("large-synthetic", largeQueries, largeDb, baseApi, newApi, timings);
  large.counts = counts;
  large.roots = largeRoots;
  large.timings = timings;
  large.timingSummary = timingSummary(timings);
  large.comparison = "all compared result fields; passages and omittedTerms are omitted only from the stable materialized projection";
  writeFileSync(path.join(OUT_DIR, "search-diff-large.json"), JSON.stringify(large, null, 2));
  console.log(`large compared=${large.compared} mismatches=${large.mismatchCount} errors=${large.errors} commonErrors=${large.commonErrors}`);
  console.log(`large timing ${JSON.stringify(large.timingSummary)}`);
  for (const row of timings) console.log(`time ${row.tag} base=${row.baseMs.toFixed(1)}ms new=${row.newMs.toFixed(1)}ms total=${row.total} rel=${row.totalRelation}`);
}
