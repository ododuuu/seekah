import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const queries = [
  { name: "tests", query: "測試" },
  { name: "spec", query: "SPEC.md" },
  { name: "snipaste", query: "Snipaste-2.11.3-x64" },
  { name: "absent", query: "seekah_absent_20260927_f391a7" },
];
const expectedDocumentCount = 235_463;
const pageSize = 20;
const warmupRounds = 3;
const measurementRounds = 10;
const q1 = `WITH selected AS MATERIALIZED (
  SELECT DISTINCT m.block_id
  FROM json_each(?) AS seed
  CROSS JOIN document_payload_blocks AS m
  WHERE m.document_id = ?
    AND m.payload_ordinal = seed.value
)
SELECT s.block_id AS id,
  b.ordinal,b.heading,b.content,b.location_kind,b.location_value
FROM selected AS s
LEFT JOIN blocks AS b
  ON b.id=s.block_id AND b.document_id=?`;
const q2 = `WITH selected AS MATERIALIZED (
  SELECT DISTINCT m.block_id
  FROM json_each(?) AS seed
  CROSS JOIN document_payload_blocks AS m
  WHERE m.document_id = ?
    AND m.payload_ordinal = seed.value
)
SELECT p.ordinal,p.payload
FROM document_payloads AS p
WHERE p.document_id = ?
  AND p.ordinal IN (
    SELECT DISTINCT m.payload_ordinal
    FROM selected AS s
    CROSS JOIN document_payload_blocks AS m
      INDEXED BY document_payload_blocks_document_block
    WHERE m.document_id = ?
      AND m.block_id=s.block_id
  )
ORDER BY p.ordinal`;

function fail(message) {
  throw new Error(`metadata benchmark: ${message}`);
}

function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (!argument.startsWith("--")) fail(`unexpected argument ${argument}`);
    if (argument === "--compare") {
      const before = argv[++index];
      const after = argv[++index];
      if (!before || !after) fail("--compare needs before and after JSON paths");
      values.set("compare", [before, after]);
    } else {
      const value = argv[++index];
      if (!value || value.startsWith("--")) fail(`${argument} needs a value`);
      values.set(argument.slice(2), value);
    }
  }
  return values;
}

async function requireAbsent(filePath) {
  try {
    await access(filePath);
    fail(`output already exists: ${filePath}`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

async function requireFile(filePath, label) {
  try {
    const info = await stat(filePath);
    if (!info.isFile()) fail(`${label} is not a file: ${filePath}`);
    return info;
  } catch (error) {
    if (error?.code === "ENOENT") fail(`${label} does not exist: ${filePath}`);
    throw error;
  }
}

async function requireDirectory(directory, label) {
  try {
    const info = await stat(directory);
    if (!info.isDirectory()) fail(`${label} is not a directory: ${directory}`);
  } catch (error) {
    if (error?.code === "ENOENT") fail(`${label} does not exist: ${directory}`);
    throw error;
  }
}

function percentile(values, p) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1))];
}

function ratio(after, before) {
  return before === 0 ? null : after / before;
}

function metadataRows(database) {
  return Object.fromEntries(database.prepare("SELECT key,value FROM metadata ORDER BY key").all()
    .map(row => [row.key, row.value]));
}

function tableCounts(database) {
  const tables = ["documents", "blocks", "document_payloads", "document_payload_blocks", "document_payload_blooms"];
  return Object.fromEntries(tables.map(table => [table,
    Number(database.prepare(`SELECT count(*) AS count FROM ${table}`).get().count)]));
}

function dataVersion(database) {
  return Number(database.prepare("PRAGMA data_version").get().data_version);
}

function snapshotKey(identity) {
  return JSON.stringify({
    documents: identity.documentCount,
    tables: identity.tableCounts,
    metadata: identity.metadata,
    dataVersion: identity.dataVersion,
    sizeBytes: identity.sizeBytes,
    modifiedAtMs: identity.modifiedAtMs,
  });
}

function readIdentity(database, fileInfo) {
  const metadata = metadataRows(database);
  const tableCountsValue = tableCounts(database);
  const documentCount = tableCountsValue.documents;
  if (documentCount !== expectedDocumentCount) {
    fail(`unexpected document scope: expected ${expectedDocumentCount}, got ${documentCount}`);
  }
  const expectedVersions = {
    content_storage_version: "2",
    payload_bloom_version: "2",
    multi_root_version: "1",
    root_merge_version: "1",
    ngram_index_version: "1",
  };
  for (const [key, expected] of Object.entries(expectedVersions)) {
    if (metadata[key] !== expected) fail(`unexpected metadata.${key}: ${metadata[key] ?? "missing"}`);
  }
  return {
    documentCount,
    tableCounts: tableCountsValue,
    metadata: Object.fromEntries(Object.keys(expectedVersions).map(key => [key, metadata[key]])),
    dataVersion: dataVersion(database),
    sizeBytes: fileInfo.size,
    modifiedAtMs: fileInfo.mtimeMs,
  };
}

function explain(database, sql, parameters) {
  return database.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...parameters)
    .map(row => row.detail);
}

function planInputs(database, maximumSeedPlan) {
  const sparse = database.prepare(`
    SELECT m.document_id, m.payload_ordinal
    FROM document_payload_blocks AS m
    GROUP BY m.document_id, m.payload_ordinal
    ORDER BY count(*) ASC, m.document_id ASC, m.payload_ordinal ASC
    LIMIT 1`).get();
  const spec = database.prepare("SELECT id FROM documents WHERE filename = ? ORDER BY id LIMIT 1").get("SPEC.md");
  if (!sparse || !spec) fail("required sparse or SPEC.md plan input is missing");
  const specDocumentId = maximumSeedPlan?.documentId ?? Number(spec.id);
  const specSeeds = maximumSeedPlan?.ordinals?.length
    ? maximumSeedPlan.ordinals
    : database.prepare(`
      SELECT payload_ordinal AS ordinal
      FROM document_payload_blooms
      WHERE document_id = ?
      ORDER BY payload_ordinal
      LIMIT 4607`).all(specDocumentId).map(row => Number(row.ordinal));
  if (specSeeds.length === 0) fail("SPEC.md workload has no maximum payload seed pass");
  const sparseSeeds = [Number(sparse.payload_ordinal)];
  const sparseParameters = [JSON.stringify(sparseSeeds), Number(sparse.document_id), Number(sparse.document_id)];
  const specParameters = [JSON.stringify(specSeeds), specDocumentId, specDocumentId];
  return {
    sparseOneSeed: {
      seedCount: sparseSeeds.length,
      q1: explain(database, q1, sparseParameters),
      q2: explain(database, q2, [JSON.stringify(sparseSeeds), Number(sparse.document_id), Number(sparse.document_id), Number(sparse.document_id)]),
    },
    specMaximumSeed: {
      seedCount: specSeeds.length,
      q1: explain(database, q1, specParameters),
      q2: explain(database, q2, [...specParameters.slice(0, 2), specDocumentId, specDocumentId]),
    },
  };
}

function snapshotCounts(trace) {
  return trace ? trace.snapshot().counts : {};
}


function traceMetric(trace) {
  const counts = trace?.counts ?? {};
  const sql = trace.diagnostics.payloadSql;
  const reads = trace.diagnostics.payloadReads;
  return {
    blocksMetadataRows: counts.blocksMetadataRows,
    owningBlockMappingRows: counts.owningBlockMappingRows,
    owningBlocksFound: counts.owningBlocksFound ?? null,
    payloadBlobRows: counts.payloadsRead,
    candidatePayloadOrdinals: counts.candidatePayloadOrdinals ?? null,
    blockExpansionInputPayloads: counts.blockExpansionInputPayloads ?? null,
    fullDocumentFallbacks: counts.fullDocumentFallbacks,
    metadataExecuteMs: sql.blocksMetadata.executeMs,
    mappingExecuteMs: sql.owningBlockMapping.executeMs,
    blobExecuteMs: sql.payloadBlob.executeMs,
    sqlExecuteSumMs: sql.blocksMetadata.executeMs + sql.owningBlockMapping.executeMs + sql.payloadBlob.executeMs,
    prepareCount: sql.blocksMetadata.prepareCount + sql.owningBlockMapping.prepareCount + sql.payloadBlob.prepareCount,
    prepareMs: sql.blocksMetadata.prepareMs + sql.owningBlockMapping.prepareMs + sql.payloadBlob.prepareMs,
    payloadLookupMs: trace.phasesMs.payloadLookup,
    brotliMs: counts.payloadBrotliMs,
    decodeParseMs: counts.payloadDecodeParseMs,
    payloadDecompressionMs: trace.phasesMs.payloadDecompression,
    exactSelfMs: trace.phaseSelfMs.exactVerification,
    exactInclusiveMs: trace.phasesMs.exactVerification,
    exactTextMs: counts.exactTextMs,
    traceMs: trace.durationMs,
    compressedBytes: counts.compressedBytesRead,
    decompressedBytes: counts.decompressedBytes,
    uniquePayloadsRead: counts.uniquePayloadsRead,
    duplicatePayloadsRead: counts.duplicatePayloadsRead,
    payloadsRead: counts.payloadsRead,
    selectedPayloadsRead: counts.selectedPayloadsRead,
    expandedPayloads: counts.expandedPayloads,
    fullFallbackPayloads: counts.fullFallbackPayloads,
    rankingPayloadsRead: reads.ranking.payloadsRead,
    snippetPayloadsRead: reads.snippet.payloadsRead,
  };
}

const structuralMetricFields = [
  "blocksMetadataRows", "owningBlockMappingRows", "owningBlocksFound", "payloadBlobRows",
  "candidatePayloadOrdinals", "blockExpansionInputPayloads", "fullDocumentFallbacks", "payloadsRead",
  "selectedPayloadsRead", "expandedPayloads", "fullFallbackPayloads", "uniquePayloadsRead", "duplicatePayloadsRead",
  "compressedBytes", "decompressedBytes",
];

function structuralMetric(metric) {
  return Object.fromEntries(structuralMetricFields.map(field => [field, metric[field]]));
}

function projection(result) {
  return {
    reference: result.reference,
    path: result.path,
    extension: result.extension,
    modifiedAtMs: result.modifiedAtMs,
    heading: result.heading,
    location: result.location,
    snippet: result.snippet,
    rank: result.rank,
    reason: result.reason,
    filenameOnly: result.filenameOnly,
    status: result.status,
    snippetTruncated: result.snippetTruncated,
  };
}

function hashAllPages(store, createSearchResultSet, query) {
  const resultSet = createSearchResultSet(store, query);
  const pageCount = Math.ceil(resultSet.total / pageSize);
  const hash = createHash("sha256");
  hash.update(JSON.stringify({ total: resultSet.total, pageCount }));
  for (let page = 1; page <= pageCount; page++) {
    const resultPage = resultSet.page(page, pageSize);
    for (const result of resultPage.results) hash.update(`\n${JSON.stringify(projection(result))}`);
  }
  return { total: resultSet.total, pageCount, resultHash: hash.digest("hex") };
}

function installCharacterization(store, queriesToRun) {
  const original = store.streamBlocksFor;
  if (typeof original !== "function") fail("compiled IndexStore does not expose streamBlocksFor for characterization");
  const records = new Map(queriesToRun.map(item => [item.name, {
    passes: 0, filteredPasses: 0, candidatePayloadOrdinals: 0, blockExpansionInputPayloads: 0,
    owningBlocksFound: 0, fullDocumentFallbacks: 0, maxSeedCount: 0, maxSeedOrdinals: [], maxSeedDocumentId: undefined,
  }]));
  const wrapper = function* (documentId, candidatePayloads, trace, snippet) {
    const before = snapshotCounts(trace);
    const seeds = candidatePayloads === undefined ? 0 : new Set(candidatePayloads).size;
    const source = original.call(this, documentId, candidatePayloads, trace, snippet);
    try {
      yield* source;
    } finally {
      const after = snapshotCounts(trace);
      const item = currentCharacterizationItem;
      if (item && trace) {
        const record = records.get(item.name);
        if (record) {
          record.passes++;
          if (seeds > 0) {
            record.filteredPasses++;
            record.candidatePayloadOrdinals += seeds;
            record.owningBlocksFound += (after.owningBlocksFound ?? 0) - (before.owningBlocksFound ?? 0)
              || (after.owningBlockMappingRows ?? 0) - (before.owningBlockMappingRows ?? 0);
            const fallbackDelta = (after.fullDocumentFallbacks ?? 0) - (before.fullDocumentFallbacks ?? 0);
            record.fullDocumentFallbacks += fallbackDelta;
            if (fallbackDelta === 0) record.blockExpansionInputPayloads += seeds;
            if (seeds > record.maxSeedCount) {
              record.maxSeedCount = seeds;
              record.maxSeedOrdinals = [...new Set(candidatePayloads)];
              record.maxSeedDocumentId = documentId;
            }
          }
        }
      }
    }
  };
  let currentCharacterizationItem;
  Object.defineProperty(store, "streamBlocksFor", { configurable: true, writable: true, value: wrapper });
  try {
    for (const item of queriesToRun) {
      currentCharacterizationItem = item;
      const resultSet = item.createSearchResultSet(store, item.query);
      resultSet.page(1, pageSize);
    }
  } finally {
    currentCharacterizationItem = undefined;
    delete store.streamBlocksFor;
  }
  const reports = {};
  let maxSeedPlan;
  for (const [name, record] of records) {
    const { maxSeedOrdinals, maxSeedDocumentId, ...report } = record;
    reports[name] = report;
    if (name === "spec" && maxSeedOrdinals.length) {
      maxSeedPlan = { documentId: maxSeedDocumentId, ordinals: maxSeedOrdinals };
    }
  }
  return { reports, maxSeedPlan };
}

function timedRound(store, createSearchResultSet) {
  const round = {};
  for (const item of queries) {
    const started = performance.now();
    const resultSet = createSearchResultSet(store, item.query);
    const ranking = resultSet.trace;
    const page = resultSet.page(1, pageSize);
    const completed = resultSet.trace;
    round[item.name] = {
      ranking: traceMetric(ranking),
      completed: traceMetric(completed),
      wallMs: performance.now() - started,
      total: page.total,
      returnedResults: page.results.length,
    };
  }
  return round;
}

async function runVariant(options) {
  const databaseFile = await requireFile(options.database, "database");
  await requireDirectory(options.moduleDir, "module directory");
  await requireFile(path.join(options.moduleDir, "store.js"), "store module");
  await requireFile(path.join(options.moduleDir, "search.js"), "search module");
  await requireAbsent(options.out);

  const database = new DatabaseSync(options.database, { readOnly: true });
  database.exec("PRAGMA query_only = ON");
  const identity = readIdentity(database, databaseFile);
  const sentinelStart = dataVersion(database);
  const storeModule = await import(pathToFileURL(path.join(options.moduleDir, "store.js")).href);
  const searchModule = await import(pathToFileURL(path.join(options.moduleDir, "search.js")).href);
  const BaseStore = storeModule.IndexStore;
  const createSearchResultSet = searchModule.createSearchResultSet;
  class BenchmarkStore extends BaseStore {
    recordSearchTrace(trace) {
      super.recordSearchTrace(trace, false);
    }
  }
  const store = new BenchmarkStore(options.database, { readOnly: true });
  const characterizationState = installCharacterization(store, queries.map(item => ({ ...item, createSearchResultSet })));
  if (dataVersion(database) !== sentinelStart) fail("data_version changed during characterization");
  const plans = planInputs(database, characterizationState.maxSeedPlan);
  const fullResultHashes = Object.fromEntries(queries.map(item => [item.name, hashAllPages(store, createSearchResultSet, item.query)]));
  if (dataVersion(database) !== sentinelStart) fail("data_version changed during full-result verification");
  const characterization = characterizationState.reports;
  const samples = Object.fromEntries(queries.map(item => [item.name, []]));
  try {
    for (let round = 0; round < warmupRounds + measurementRounds; round++) {
      const before = dataVersion(database);
      if (before !== sentinelStart) fail(`data_version changed before round ${round + 1}: ${sentinelStart} -> ${before}`);
      const measured = timedRound(store, createSearchResultSet);
      const after = dataVersion(database);
      if (after !== sentinelStart) fail(`data_version changed during round ${round + 1}: ${sentinelStart} -> ${after}`);
      if (round >= warmupRounds) {
        for (const item of queries) samples[item.name].push(measured[item.name]);
      }
    }
  } finally {
    store.close();
    database.close();
  }
  const finalFile = await stat(options.database);
  if (finalFile.size !== databaseFile.size || finalFile.mtimeMs !== databaseFile.mtimeMs) {
    fail("database file metadata changed during read-only benchmark");
  }
  const queryReports = Object.fromEntries(queries.map(item => {
    const entries = samples[item.name];
    const ranking = entries.map(entry => entry.ranking);
    const completed = entries.map(entry => entry.completed);
    return [item.name, {
      query: item.query,
      fullResult: fullResultHashes[item.name],
      characterization: characterization[item.name],
      ranking: {
        p50: percentile(ranking.map(metric => metric.traceMs), 0.5),
        p95: percentile(ranking.map(metric => metric.traceMs), 0.95),
        samples: ranking,
      },
      completed: {
        p50: percentile(completed.map(metric => metric.traceMs), 0.5),
        p95: percentile(completed.map(metric => metric.traceMs), 0.95),
        wallP50: percentile(entries.map(entry => entry.wallMs), 0.5),
        wallP95: percentile(entries.map(entry => entry.wallMs), 0.95),
        samples: completed.map((metric, index) => ({ ...metric, wallMs: entries[index].wallMs })),
      },
    }];
  }));
  const structuralStability = Object.fromEntries(queries.map(item => {
    const entries = samples[item.name];
    const stable = metricSet => {
      const signatures = new Set(entries.map(entry => JSON.stringify(structuralMetric(entry[metricSet]))));
      return { stable: signatures.size === 1, signatureCount: signatures.size };
    };
    return [item.name, { ranking: stable("ranking"), completed: stable("completed") }];
  }));
  const report = {
    generatedAt: new Date().toISOString(),
    label: options.label,
    platform: process.platform,
    osRelease: os.release(),
    arch: process.arch,
    node: process.version,
    sqlite: process.versions.sqlite,
    database: { basename: path.basename(options.database), identity: { ...identity, snapshotKey: snapshotKey(identity) } },
    protocol: {
      queries: queries.map(item => item.name),
      pageSize,
      warmupRounds,
      measurementRounds,
      p50: "nearest-rank 5/10",
      p95: "nearest-rank 10/10 (maximum of ten samples)",
      tracePersistence: "disabled by benchmark-only read-only subclass",
      noGcOrPragmaTuning: true,
    },
    plans,
    characterization,
    structuralStability,
    queries: queryReports,
    rss: {
      maxRSSKiB: process.resourceUsage().maxRSS,
      currentRssBytes: process.memoryUsage().rss,
    },
    notes: [
      "Q1 selected metadata includes the mapping relation inside a MATERIALIZED CTE and preserves selected owners with LEFT JOIN.",
      "Q2 reconstructs the complete owning-block payload closure and uses the existing document_payload_blocks_document_block index.",
      "mappingSelectionPlacement: ranking/snippet filtered retrieval; blockSource standalone mapping remains separately timed.",
      "selectedMetadataMapPlacement: Q1 rows become the membership Map after payload lookup timing and before decode; this placement is held constant for BEFORE/AFTER and included in exact self.",
      "The report contains hashes, counts, timings and plans only; it does not contain document paths,正文或 snippets.",
    ],
  };
  await mkdir(path.dirname(options.out), { recursive: true });
  await writeFile(options.out, JSON.stringify(report, null, 2) + "\n");
  return report;
}

function comparisonMetric(beforeSamples, afterSamples) {
  const result = {};
  const fields = [
    "blocksMetadataRows", "owningBlockMappingRows", "owningBlocksFound", "payloadBlobRows",
    "sqlExecuteSumMs", "prepareCount", "prepareMs", "payloadLookupMs", "brotliMs", "decodeParseMs",
    "payloadDecompressionMs", "exactSelfMs", "exactInclusiveMs", "exactTextMs", "traceMs",
    "compressedBytes", "decompressedBytes", "uniquePayloadsRead", "duplicatePayloadsRead", "payloadsRead",
  ];
  for (const field of fields) {
    const beforeP50 = percentile(beforeSamples.map(metric => metric[field]), 0.5);
    const afterP50 = percentile(afterSamples.map(metric => metric[field]), 0.5);
    const beforeP95 = percentile(beforeSamples.map(metric => metric[field]), 0.95);
    const afterP95 = percentile(afterSamples.map(metric => metric[field]), 0.95);
    result[field] = {
      beforeP50, afterP50, p50Ratio: ratio(afterP50, beforeP50),
      beforeP95, afterP95, p95Ratio: ratio(afterP95, beforeP95),
    };
  }
  return result;
}

async function compareReports(beforePath, afterPath, output) {
  await requireAbsent(output);
  const before = JSON.parse(await readFile(beforePath, "utf8"));
  const after = JSON.parse(await readFile(afterPath, "utf8"));
  if (before.label !== "before" || after.label !== "after") fail("comparison requires before and after reports");
  if (before.database.identity.snapshotKey !== after.database.identity.snapshotKey) {
    fail("before and after reports are not from the same database snapshot");
  }
  const queriesReport = Object.fromEntries(queries.map(item => {
    const beforeQuery = before.queries[item.name];
    const afterQuery = after.queries[item.name];
    if (!beforeQuery || !afterQuery) fail(`missing query report: ${item.name}`);
    if (beforeQuery.fullResult.resultHash !== afterQuery.fullResult.resultHash
      || beforeQuery.fullResult.total !== afterQuery.fullResult.total
      || beforeQuery.fullResult.pageCount !== afterQuery.fullResult.pageCount) {
      fail(`result hash mismatch: ${item.name}`);
    }
    const rankingBefore = beforeQuery.ranking.samples;
    const rankingAfter = afterQuery.ranking.samples;
    const completedBefore = beforeQuery.completed.samples;
    const completedAfter = afterQuery.completed.samples;
    const metricComparison = (key, beforeMetrics, afterMetrics) => {
      const beforeP50 = percentile(beforeMetrics.map(metric => metric[key]), 0.5);
      const afterP50 = percentile(afterMetrics.map(metric => metric[key]), 0.5);
      const beforeP95 = percentile(beforeMetrics.map(metric => metric[key]), 0.95);
      const afterP95 = percentile(afterMetrics.map(metric => metric[key]), 0.95);
      return { beforeP50, afterP50, p50Ratio: ratio(afterP50, beforeP50), beforeP95, afterP95, p95Ratio: ratio(afterP95, beforeP95) };
    };
    return [item.name, {
      query: item.query,
      result: afterQuery.fullResult,
      ranking: {
        traceMs: metricComparison("traceMs", rankingBefore, rankingAfter),
        metrics: comparisonMetric(rankingBefore, rankingAfter),
      },
      completed: {
        traceMs: metricComparison("traceMs", completedBefore, completedAfter),
        wallMs: {
          beforeP50: beforeQuery.completed.wallP50,
          afterP50: afterQuery.completed.wallP50,
          p50Ratio: ratio(afterQuery.completed.wallP50, beforeQuery.completed.wallP50),
          beforeP95: beforeQuery.completed.wallP95,
          afterP95: afterQuery.completed.wallP95,
          p95Ratio: ratio(afterQuery.completed.wallP95, beforeQuery.completed.wallP95),
        },
        metrics: comparisonMetric(completedBefore, completedAfter),
      },
      structural: {
        before: beforeQuery.characterization,
        after: afterQuery.characterization,
        stableBefore: before.structuralStability[item.name],
        stableAfter: after.structuralStability[item.name],
      },
    }];
  }));
  const report = {
    generatedAt: new Date().toISOString(),
    before: { generatedAt: before.generatedAt, database: before.database, plans: before.plans },
    after: { generatedAt: after.generatedAt, database: after.database, plans: after.plans },
    protocol: after.protocol,
    resultHashesEqual: true,
    queries: queriesReport,
    notes: after.notes,
  };
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(report, null, 2) + "\n");
  console.log(`已保存 ${output}`);
}

const argumentsMap = parseArguments(process.argv.slice(2));
if (argumentsMap.has("compare")) {
  if (argumentsMap.size !== 2 || !argumentsMap.has("out")) fail("compare mode requires only --compare before after and --out");
  const [before, after] = argumentsMap.get("compare");
  await compareReports(path.resolve(before), path.resolve(after), path.resolve(argumentsMap.get("out")));
} else {
  if (argumentsMap.size !== 4 || !argumentsMap.has("database") || !argumentsMap.has("module-dir")
    || !argumentsMap.has("label") || !argumentsMap.has("out")) {
    fail("usage: --database <absolute index.db> --module-dir <dist/src> --label before|after --out <new.json>");
  }
  const database = path.resolve(argumentsMap.get("database"));
  const moduleDir = path.resolve(argumentsMap.get("module-dir"));
  const label = argumentsMap.get("label");
  if (!path.isAbsolute(argumentsMap.get("database"))) fail("--database must be an absolute path");
  if (label !== "before" && label !== "after") fail("--label must be before or after");
  const report = await runVariant({ database, moduleDir, label, out: path.resolve(argumentsMap.get("out")) });
  console.log(`已保存 ${path.resolve(argumentsMap.get("out"))}`);
  console.log(JSON.stringify({ label, queryP50Ms: Object.fromEntries(Object.entries(report.queries).map(([name, value]) => [name, value.completed.wallP50])) }, null, 2));
}
