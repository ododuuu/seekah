#!/usr/bin/env node

import { watch } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const TOPOLOGIES = ["root-recursive", "split-top-level", "users-only"];
const DEFAULT_RATES = [50, 150, 300, 600];
const DEFAULT_REPEATS = 3;
const DEFAULT_DURATION_MS = 7_000;
const DEFAULT_TARGET_AFTER_MS = 2_500;
const DEFAULT_FLUSH_MS = 500;
const DEFAULT_NOISE_FILES = 256;
const DEFAULT_MARKER_EVERY_WRITES = 100;
const SAMPLE_LIMIT = 80;
const TAIL_LIMIT = 80;

function parseArgs(argv) {
  const options = {
    rates: DEFAULT_RATES,
    repeats: DEFAULT_REPEATS,
    durationMs: DEFAULT_DURATION_MS,
    targetAfterMs: DEFAULT_TARGET_AFTER_MS,
    flushMs: DEFAULT_FLUSH_MS,
    callbackWorkMs: 0,
    output: path.join(os.tmpdir(), `seekah-watcher-loss-${Date.now()}.json`),
    keep: false,
    quiet: false,
    watchOption: "default",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    if (argument === "--rates" && value) {
      options.rates = value.split(",").map(Number).filter(rate => Number.isFinite(rate) && rate > 0);
      index += 1;
    } else if (argument === "--repeats" && value) {
      options.repeats = parsePositiveInt(value, "--repeats");
      index += 1;
    } else if (argument === "--duration-ms" && value) {
      options.durationMs = parsePositiveInt(value, "--duration-ms");
      index += 1;
    } else if (argument === "--target-after-ms" && value) {
      options.targetAfterMs = parsePositiveInt(value, "--target-after-ms");
      index += 1;
    } else if (argument === "--callback-work-ms" && value) {
      options.callbackWorkMs = parseNonnegativeInt(value, "--callback-work-ms");
      index += 1;
    } else if (argument === "--flush-ms" && value) {
      options.flushMs = parsePositiveInt(value, "--flush-ms");
      index += 1;
    } else if (argument === "--topologies" && value) {
      options.topologies = value.split(",").filter(topology => TOPOLOGIES.includes(topology));
      index += 1;
    } else if (argument === "--output" && value) {
      options.output = path.resolve(value);
      index += 1;
    } else if (argument === "--watch-option" && value) {
      options.watchOption = value;
      index += 1;
    } else if (argument === "--keep") {
      options.keep = true;
    } else if (argument === "--quiet") {
      options.quiet = true;
    } else if (argument === "--help" || argument === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`未知參數：${argument}`);
    }
  }

  if (options.rates.length === 0) throw new Error("--rates 必須包含至少一個正數");
  if (options.topologies.length === 0) throw new Error("--topologies 必須包含至少一個已知拓撲");
  if (options.targetAfterMs >= options.durationMs) {
    throw new Error("--target-after-ms 必須小於 --duration-ms");
  }
  return options;
}

function parseNonnegativeInt(value, option) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${option} 必須是非負整數`);
  return parsed;
}

function parsePositiveInt(value, option) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${option} 必須是正整數`);
  return parsed;
}

function printHelp() {
  console.log(`獨立 Windows fs.watch 漏事件重現器

用法：
  node scripts/watcher-loss-repro.mjs [選項]

選項：
  --rates 50,150,300,600       雜訊改寫速率（writes/s）
  --repeats 3                  每個速率／拓撲重複次數
  --duration-ms 7000           每次 run 持續時間
  --target-after-ms 2500       watcher 啟動後建立唯一目標檔的時間
  --callback-work-ms 0         每個 callback 同步忙碌模擬（毫秒）
  --topologies root-recursive,split-top-level,users-only
  --watch-option default|bufferSize-64k|bufferSize-1m|maxBuffer-64k
  --output <path>              JSON 結果檔（預設在 TEMP）
  --keep                       保留合成 fixture（預設刪除）
  --quiet                      不輸出每個 run 的一行摘要
`);
}

function sleep(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function normalizeRelative(value) {
  return value.replaceAll("\\", "/").replace(/^\.\//u, "");
}

function nowMs(start) {
  return Number((performance.now() - start).toFixed(3));
}

function blockFor(milliseconds) {
  if (milliseconds <= 0) return;
  const deadline = performance.now() + milliseconds;
  while (performance.now() < deadline) {
    // 刻意模擬同步 downstream work；預設為 0，不改變純 watcher 基線。
  }
}

function topLevelNames() {
  const fixed = [
    "Users",
    "Windows",
    "ProgramData",
    "Program Files",
    "Program Files (x86)",
    "PerfLogs",
  ];
  for (let index = fixed.length; index < 140; index += 1) {
    fixed.push(`Top${String(index).padStart(3, "0")}`);
  }
  return fixed;
}

function noiseRootsForTree(treeRoot) {
  return [
    path.join(treeRoot, "Windows", "Noise", "stream"),
    path.join(treeRoot, "ProgramData", "Noise", "stream"),
    path.join(treeRoot, "Top139", "Noise", "stream"),
  ];
}

function noiseFilesForTree(treeRoot) {
  const noiseRoots = noiseRootsForTree(treeRoot);
  return Array.from({ length: DEFAULT_NOISE_FILES }, (_, index) => {
    const directory = noiseRoots[index % noiseRoots.length];
    return path.join(directory, `noise-${String(index).padStart(4, "0")}.txt`);
  });
}

async function createFixture(sessionRoot, runNumber) {
  const treeRoot = path.join(sessionRoot, `run-${String(runNumber).padStart(3, "0")}`, "tree");
  const topNames = topLevelNames();
  const noiseRoots = noiseRootsForTree(treeRoot);
  const targetDirectory = path.join(treeRoot, "Users", "mains", "Desktop");
  const targetToken = `target-watcher-loss-${Date.now()}-${process.pid}-${runNumber}.txt`;

  await Promise.all(topNames.map(name => mkdir(path.join(treeRoot, name), { recursive: true })));
  await Promise.all([
    mkdir(targetDirectory, { recursive: true }),
    ...noiseRoots.map(directory => mkdir(directory, { recursive: true })),
    mkdir(path.join(treeRoot, "Users", "mains", "Documents"), { recursive: true }),
  ]);

  const noiseFiles = noiseFilesForTree(treeRoot);
  await Promise.all(noiseFiles.map((filePath, index) => writeFile(filePath, `seed-${index}\n`, "utf8")));

  return {
    treeRoot,
    topNames,
    noiseFiles,
    targetDirectory,
    targetPath: path.join(targetDirectory, targetToken),
    targetToken,
    noiseRoots,
  };
}

function buildWatchOptions(optionName) {
  const options = { recursive: true, encoding: "utf8" };
  if (optionName === "bufferSize-64k") {
    options.bufferSize = 64 * 1024;
  } else if (optionName === "bufferSize-1m") {
    options.bufferSize = 1024 * 1024;
  } else if (optionName === "maxBuffer-64k") {
    options.maxBuffer = 64 * 1024;
  } else if (optionName !== "default") {
    throw new Error(`未知 --watch-option：${optionName}`);
  }
  return options;
}

function createEventCollector(start, targetToken, callbackWorkMs) {
  const state = {
    callbackCount: 0,
    namedCallbackCount: 0,
    emptyFilenameCount: 0,
    renameCount: 0,
    changeCount: 0,
    targetEventCount: 0,
    targetEventTimesMs: [],
    markerEventCount: 0,
    markerNames: new Set(),
    emptyEvents: [],
    sampleEvents: [],
    tailEvents: [],
    watcherErrors: [],
    firstEmptyAtMs: null,
    lastEmptyAtMs: null,
    firstNamedAtMs: null,
    lastNamedAtMs: null,
    maxAnyCallbackGapMs: 0,
    maxNamedCallbackGapMs: 0,
    maxGapAfterEmptyMs: 0,
    pendingEmptyEvents: [],
    previousCallbackAtMs: null,
    previousNamedAtMs: null,
  };

  function addSample(event) {
    if (state.sampleEvents.length < SAMPLE_LIMIT) state.sampleEvents.push(event);
    state.tailEvents.push(event);
    if (state.tailEvents.length > TAIL_LIMIT) state.tailEvents.shift();
  }

  function callback(eventType, filename, watcherLabel) {
    const atMs = nowMs(start);
    const rawFilename = filename == null ? "" : String(filename);
    const normalizedFilename = normalizeRelative(rawFilename);
    const empty = normalizedFilename.length === 0;
    const event = { atMs, eventType, filename: normalizedFilename, watcher: watcherLabel, empty };
    state.callbackCount += 1;
    if (eventType === "rename") state.renameCount += 1;
    if (eventType === "change") state.changeCount += 1;
    if (state.previousCallbackAtMs != null) {
      state.maxAnyCallbackGapMs = Math.max(state.maxAnyCallbackGapMs, atMs - state.previousCallbackAtMs);
    }
    state.previousCallbackAtMs = atMs;

    if (empty) {
      state.emptyFilenameCount += 1;
      state.firstEmptyAtMs ??= atMs;
      state.lastEmptyAtMs = atMs;
      const emptyRecord = { atMs, beforeTargetMs: null, nextNamedGapMs: null };
      state.emptyEvents.push(emptyRecord);
      state.pendingEmptyEvents.push(emptyRecord);
    } else {
      state.namedCallbackCount += 1;
      state.firstNamedAtMs ??= atMs;
      state.lastNamedAtMs = atMs;
      if (state.previousNamedAtMs != null) {
        state.maxNamedCallbackGapMs = Math.max(state.maxNamedCallbackGapMs, atMs - state.previousNamedAtMs);
      }
      state.previousNamedAtMs = atMs;
      for (const emptyRecord of state.pendingEmptyEvents) {
        emptyRecord.nextNamedGapMs = atMs - emptyRecord.atMs;
        state.maxGapAfterEmptyMs = Math.max(state.maxGapAfterEmptyMs, emptyRecord.nextNamedGapMs);
      }
      state.pendingEmptyEvents.length = 0;
      if (normalizedFilename.includes(targetToken)) {
        state.targetEventCount += 1;
        state.targetEventTimesMs.push(atMs);
      }
      if (/^marker-/u.test(path.posix.basename(normalizedFilename))) {
        state.markerEventCount += 1;
        state.markerNames.add(path.posix.basename(normalizedFilename));
      }
    }
    blockFor(callbackWorkMs);
  }

  function error(error, watcherLabel) {
    state.watcherErrors.push({
      atMs: nowMs(start),
      watcher: watcherLabel,
      code: error?.code ?? null,
      message: String(error?.message ?? error),
    });
  }

  return { state, callback, error };
}

function watchDirectory(directory, watcherLabel, collector, optionName) {
  const watcher = watch(directory, buildWatchOptions(optionName));
  watcher.on("change", (eventType, filename) => collector.callback(eventType, filename, watcherLabel));
  watcher.on("error", error => collector.error(error, watcherLabel));
  return watcher;
}

function openWatchers(fixture, topology, collector, optionName) {
  if (topology === "root-recursive") {
    return [watchDirectory(fixture.treeRoot, "tree", collector, optionName)];
  }
  if (topology === "split-top-level") {
    return fixture.topNames.map(name => watchDirectory(
      path.join(fixture.treeRoot, name),
      name,
      collector,
      optionName,
    ));
  }
  if (topology === "users-only") {
    return [watchDirectory(path.join(fixture.treeRoot, "Users"), "Users", collector, optionName)];
  }
  throw new Error(`未知拓撲：${topology}`);
}

async function closeWatchers(watchers) {
  for (const watcher of watchers) {
    watcher.close();
  }
}

async function runNoiseWriterProcess({ fixture, rate, start, durationMs, markerEveryWrites, markerNames }) {
  const child = spawn(
    process.execPath,
    [
      fileURLToPath(import.meta.url),
      "--writer",
      JSON.stringify({ treeRoot: fixture.treeRoot, rate, durationMs, markerEveryWrites }),
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", chunk => { stdout += chunk; });
  child.stderr.on("data", chunk => { stderr += chunk; });
  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  if (exitCode !== 0) {
    throw new Error(`writer process 結束碼 ${String(exitCode)}：${stderr || stdout}`);
  }
  const writerResult = JSON.parse(stdout.trim());
  markerNames.push(...writerResult.markerNames);
  return {
    writes: writerResult.writes,
    markerCreates: writerResult.markerCreates,
    durationMs: writerResult.durationMs,
    actualWritesPerSecond: writerResult.actualWritesPerSecond,
    parentElapsedMs: nowMs(start),
  };
}

async function writerMain(specJson) {
  const spec = JSON.parse(specJson);
  const noiseRoots = noiseRootsForTree(spec.treeRoot);
  const noiseFiles = noiseFilesForTree(spec.treeRoot);
  const payload = Buffer.from("synthetic-noise-xxxxxxxxxxxxxxxx\n", "utf8");
  const writerStart = performance.now();
  const deadline = writerStart + spec.durationMs;
  let writes = 0;
  let markerCreates = 0;
  let nextMarkerAt = spec.markerEveryWrites;
  const markerNames = [];

  while (performance.now() < deadline) {
    const elapsedMs = performance.now() - writerStart;
    const expectedWrites = Math.floor((elapsedMs / 1_000) * spec.rate);
    const batchSize = Math.min(64, Math.max(0, expectedWrites - writes));
    if (batchSize === 0) {
      await sleep(1);
      continue;
    }

    const operations = [];
    for (let batchIndex = 0; batchIndex < batchSize; batchIndex += 1) {
      const filePath = noiseFiles[writes % noiseFiles.length];
      operations.push(writeFile(filePath, payload));
      writes += 1;
      while (writes >= nextMarkerAt) {
        const markerName = `marker-${String(markerCreates).padStart(5, "0")}-${Date.now()}.txt`;
        const markerPath = path.join(noiseRoots[markerCreates % noiseRoots.length], markerName);
        operations.push(writeFile(markerPath, `marker-${markerCreates}\n`, "utf8"));
        markerNames.push(markerName);
        markerCreates += 1;
        nextMarkerAt += spec.markerEveryWrites;
      }
    }
    await Promise.all(operations);
  }

  const durationMsActual = performance.now() - writerStart;
  console.log(JSON.stringify({
    writes,
    markerCreates,
    markerNames,
    durationMs: durationMsActual,
    actualWritesPerSecond: writes / (durationMsActual / 1_000),
  }));
}

async function createTarget(fixture, start, targetAfterMs) {
  await sleep(targetAfterMs);
  const requestedAtMs = nowMs(start);
  await writeFile(fixture.targetPath, `target-created-${requestedAtMs}\n`, "utf8");
  return requestedAtMs;
}

function summarizeCollector(state, noise, targetCreatedAtMs, fixture, topology, rate, repeat, optionName) {
  const targetLatencyMs = state.targetEventTimesMs.length > 0
    ? state.targetEventTimesMs[0] - targetCreatedAtMs
    : null;
  const firstEmptyAfterTargetMs = state.emptyEvents.find(event => event.atMs >= targetCreatedAtMs)?.atMs - targetCreatedAtMs;
  const emptyBeforeTarget = state.emptyEvents.filter(event => event.atMs < targetCreatedAtMs).length;
  const emptyAfterTarget = state.emptyEvents.length - emptyBeforeTarget;
  const markerNames = fixture.markerNames ?? [];
  const observedMarkerNames = [...state.markerNames];
  const observedMarkerSet = new Set(observedMarkerNames);
  const observedExpectedMarkers = markerNames.filter(name => observedMarkerSet.has(name)).length;

  return {
    topology,
    rate,
    repeat,
    watchOption: optionName,
    watcherCount: topology === "root-recursive" ? 1 : topology === "users-only" ? 1 : 140,
    syntheticTreeTopLevelDirectories: fixture.topNames.length,
    noiseRoots: fixture.noiseRoots.map(noiseRoot => path.relative(fixture.treeRoot, noiseRoot).replaceAll("\\", "/")),
    targetRelativePath: path.relative(fixture.treeRoot, fixture.targetPath).replaceAll("\\", "/"),
    durationMs: Number(noise.durationMs.toFixed(3)),
    noiseWrites: noise.writes,
    actualNoiseWritesPerSecond: Number(noise.actualWritesPerSecond.toFixed(3)),
    markerCreates: noise.markerCreates,
    markerExpectedObserved: observedExpectedMarkers,
    callbackCount: state.callbackCount,
    namedCallbackCount: state.namedCallbackCount,
    emptyFilenameCount: state.emptyFilenameCount,
    emptyBeforeTarget,
    emptyAfterTarget,
    firstEmptyAtMs: state.firstEmptyAtMs,
    lastEmptyAtMs: state.lastEmptyAtMs,
    firstEmptyAfterTargetMs: Number.isFinite(firstEmptyAfterTargetMs) ? Number(firstEmptyAfterTargetMs.toFixed(3)) : null,
    firstNamedAtMs: state.firstNamedAtMs,
    lastNamedAtMs: state.lastNamedAtMs,
    maxAnyCallbackGapMs: Number(state.maxAnyCallbackGapMs.toFixed(3)),
    maxNamedCallbackGapMs: Number(state.maxNamedCallbackGapMs.toFixed(3)),
    maxGapAfterEmptyMs: Number(state.maxGapAfterEmptyMs.toFixed(3)),
    targetCreatedAtMs: Number(targetCreatedAtMs.toFixed(3)),
    targetEventCount: state.targetEventCount,
    targetSeen: state.targetEventCount > 0,
    targetLatencyMs: targetLatencyMs == null ? null : Number(targetLatencyMs.toFixed(3)),
    targetEventTimesMs: state.targetEventTimesMs.map(time => Number(time.toFixed(3))),
    emptyEventTimesMs: state.emptyEvents.map(event => ({
      atMs: Number(event.atMs.toFixed(3)),
      nextNamedGapMs: event.nextNamedGapMs == null ? null : Number(event.nextNamedGapMs.toFixed(3)),
      relativeToTargetMs: Number((event.atMs - targetCreatedAtMs).toFixed(3)),
    })),
    watcherErrors: state.watcherErrors,
    sampleEvents: state.sampleEvents,
    tailEvents: state.tailEvents,
  };
}

function aggregateRuns(runs) {
  const groups = new Map();
  for (const run of runs) {
    const key = `${run.watchOption}/${run.topology}/${run.rate}`;
    const group = groups.get(key) ?? {
      watchOption: run.watchOption,
      topology: run.topology,
      rate: run.rate,
      runs: 0,
      targetSeen: 0,
      targetMissed: 0,
      emptyFilenameTotal: 0,
      emptyFilenameRuns: 0,
      callbackTotal: 0,
      namedCallbackTotal: 0,
      maxGapAfterEmptyMs: 0,
      actualNoiseWritesPerSecond: [],
      targetLatenciesMs: [],
      firstEmptyAtMs: [],
    };
    group.runs += 1;
    if (run.targetSeen) group.targetSeen += 1;
    else group.targetMissed += 1;
    group.emptyFilenameTotal += run.emptyFilenameCount;
    if (run.emptyFilenameCount > 0) group.emptyFilenameRuns += 1;
    group.callbackTotal += run.callbackCount;
    group.namedCallbackTotal += run.namedCallbackCount;
    group.maxGapAfterEmptyMs = Math.max(group.maxGapAfterEmptyMs, run.maxGapAfterEmptyMs);
    group.actualNoiseWritesPerSecond.push(run.actualNoiseWritesPerSecond);
    if (run.targetLatencyMs != null) group.targetLatenciesMs.push(run.targetLatencyMs);
    if (run.firstEmptyAtMs != null) group.firstEmptyAtMs.push(run.firstEmptyAtMs);
    groups.set(key, group);
  }

  return [...groups.values()].map(group => ({
    ...group,
    targetLossRate: Number((group.targetMissed / group.runs).toFixed(4)),
    emptyFilenameRateByRun: Number((group.emptyFilenameRuns / group.runs).toFixed(4)),
    averageEmptyFilenameCount: Number((group.emptyFilenameTotal / group.runs).toFixed(3)),
    averageCallbackCount: Number((group.callbackTotal / group.runs).toFixed(3)),
    averageNamedCallbackCount: Number((group.namedCallbackTotal / group.runs).toFixed(3)),
    averageActualNoiseWritesPerSecond: Number((average(group.actualNoiseWritesPerSecond)).toFixed(3)),
    averageTargetLatencyMs: group.targetLatenciesMs.length === 0 ? null : Number(average(group.targetLatenciesMs).toFixed(3)),
    firstEmptyAtMsMedian: group.firstEmptyAtMs.length === 0 ? null : Number(median(group.firstEmptyAtMs).toFixed(3)),
    actualNoiseWritesPerSecond: undefined,
    targetLatenciesMs: undefined,
    firstEmptyAtMs: undefined,
  }));
}

function average(values) {
  if (values.length === 0) return 0;
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
}

async function runCase(sessionRoot, topology, rate, repeat, options, runNumber) {
  const fixture = await createFixture(sessionRoot, runNumber);
  const start = performance.now();
  const collector = createEventCollector(start, fixture.targetToken, options.callbackWorkMs);
  const watchers = openWatchers(fixture, topology, collector, options.watchOption);
  const markerNames = [];
  fixture.markerNames = markerNames;
  await sleep(150);

  const noisePromise = runNoiseWriterProcess({
    fixture,
    rate,
    start,
    durationMs: options.durationMs,
    markerEveryWrites: DEFAULT_MARKER_EVERY_WRITES,
    markerNames,
  });
  const targetPromise = createTarget(fixture, start, options.targetAfterMs);
  const [noise, targetCreatedAtMs] = await Promise.all([noisePromise, targetPromise]);
  await sleep(options.flushMs);
  await closeWatchers(watchers);

  const result = summarizeCollector(
    collector.state,
    noise,
    targetCreatedAtMs,
    fixture,
    topology,
    rate,
    repeat,
    options.watchOption,
  );
  result.elapsedMs = Number(nowMs(start).toFixed(3));
  result.watcherCountObserved = watchers.length;
  result.markerExpected = markerNames.length;
  result.syntheticFixture = options.keep ? fixture.treeRoot : null;
  if (!options.keep) await rm(path.dirname(fixture.treeRoot), { recursive: true, force: true });
  return result;
}

async function main() {
  if (process.platform !== "win32") {
    throw new Error(`此重現器要求 Windows fs.watch recursive backend，目前是 ${process.platform}`);
  }
  const options = parseArgs(process.argv.slice(2));
  const actualSessionRoot = await mkdtemp(path.join(os.tmpdir(), "seekah-watcher-loss-"));

  const runs = [];
  let runNumber = 0;
  try {
    for (const topology of options.topologies) {
      for (const rate of options.rates) {
        for (let repeat = 1; repeat <= options.repeats; repeat += 1) {
          runNumber += 1;
          const result = await runCase(actualSessionRoot, topology, rate, repeat, options, runNumber);
          runs.push(result);
          if (!options.quiet) {
            console.log(JSON.stringify({
              topology,
              rate,
              repeat,
              targetSeen: result.targetSeen,
              targetEventCount: result.targetEventCount,
              emptyFilenameCount: result.emptyFilenameCount,
              callbackCount: result.callbackCount,
              maxGapAfterEmptyMs: result.maxGapAfterEmptyMs,
              actualNoiseWritesPerSecond: result.actualNoiseWritesPerSecond,
            }));
          }
        }
      }
    }
  } finally {
    if (!options.keep) await rm(actualSessionRoot, { recursive: true, force: true });
  }

  const resultDocument = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    node: {
      version: process.version,
      versions: process.versions,
      platform: process.platform,
      arch: process.arch,
    },
    config: {
      ...options,
      markerEveryWrites: DEFAULT_MARKER_EVERY_WRITES,
      noiseFiles: DEFAULT_NOISE_FILES,
      syntheticTopLevelDirectories: 140,
      targetRelativePath: "Users/mains/Desktop/<unique target>",
      sessionRoot: options.keep ? actualSessionRoot : null,
    },
    runs,
    aggregate: aggregateRuns(runs),
  };
  await mkdir(path.dirname(options.output), { recursive: true });
  await writeFile(options.output, `${JSON.stringify(resultDocument, null, 2)}\n`, "utf8");
  console.log(`結果：${options.output}`);
  console.log(`runs=${runs.length} targetMissed=${runs.filter(run => !run.targetSeen).length} emptyFilenameEvents=${runs.reduce((total, run) => total + run.emptyFilenameCount, 0)}`);
}

const entry = process.argv[2] === "--writer"
  ? writerMain(process.argv[3])
  : main();

entry.catch(error => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
