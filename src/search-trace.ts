import { randomUUID } from "node:crypto";

export const SEARCH_TRACE_SCHEMA_VERSION = 5;

export const searchTracePhases = [
  "queryNormalization",
  "postingsLookup",
  "documentEnumeration",
  "documentBloom",
  "payloadBloom",
  "payloadLookup",
  "payloadDecompression",
  "exactVerification",
  "resultRanking",
  "snippet",
  "other",
] as const;

export type SearchTracePhase = typeof searchTracePhases[number];
export type SearchTraceMode = "phrase" | "all-terms";
export type SearchTraceField = "all" | "filename" | "content";
export type SearchTraceSort = "relevance" | "filename" | "modified";
export type SearchTraceStatus = "success" | "error";
export type SearchCandidateSource =
  | "chunk-index"
  | "block-index"
  | "postings"
  | "restricted-ids"
  | "document-scan"
  | "bloom-fallback"
  | "document-bloom"
  | "payload-bloom";
export type SearchCandidateStrategy =
  | "chunk-index"
  | "chunk-index+restricted-ids"
  | "block-index"
  | "block-index+restricted-ids"
  | "postings"
  | "postings+restricted-ids"
  | "restricted-ids"
  | "bloom-fallback"
  | "document-scan"
  | "none";

export interface SearchTraceCounts {
  documentsInScope: number;
  documentsConsidered: number;
  documentsAfterPruning: number;
  documentsPruned: number;
  documentsExactVerified: number;
  documentsMatched: number;
  payloadsConsidered: number;
  payloadsAfterPruning: number;
  payloadsRead: number;
  payloadsDecompressed: number;
  payloadReadPasses: number;
  postingPayloadHits: number;
  expandedPayloads: number;
  fullDocumentFallbacks: number;
  filenameOnlyFallbacks: number;
  blockExpansionRatio: number;
  exactTextMs: number;
  blocksMetadataRows: number;
  owningBlockMappingRows: number;
  bloomSelectedPayloads: number;
  selectedPayloadsRead: number;
  fullFallbackPayloads: number;
  uniquePayloadsRead: number;
  duplicatePayloadsRead: number;
  uniquePayloadsDecompressed: number;
  duplicatePayloadsDecompressed: number;
  compressedBytesRead: number;
  decompressedBytes: number;
  maxBlockExpansionRatio: number;
  maxExpandedPayloads: number;
  maxSelectedPayloadsRead: number;
  maxPayloadsReadPerPass: number;
  payloadBrotliMs: number;
  payloadDecodeParseMs: number;
  blockExpansionInputPayloads: number;
  candidatePayloadOrdinals: number;
  owningBlocksFound: number;
  /** Rows returned by block／filename／heading index queries (SPEC §50.4). */
  indexPostingRows: number;
  /** Content blocks matched by the block index before grouping per document. */
  indexCandidateBlocks: number;
  /** Content blocks read back to verify a U+0000 unigram fallback. */
  indexVerifiedBlocks: number;
  /** Chunks matched by the chunk index (SPEC §52.5). */
  indexCandidateChunks: number;
  /** Chunks decompressed to verify content hits. */
  indexVerifiedChunks: number;
  /** Compressed bytes of the verified chunks. */
  indexVerifiedBytes: number;
  results: number;
  returnedResults: number;
}

type PayloadSqlKind = "blocksMetadata" | "owningBlockMapping" | "payloadBlob";
/** ranking 僅指 exactVerification 內讀取；snippet 指 blockSource 的結果文字回讀。 */
type PayloadReadPurpose = "ranking" | "snippet" | "other";
type PayloadSqlDiagnostic = {
  prepareCount: number;
  executeCount: number;
  prepareMs: number;
  executeMs: number;
};
type PayloadReadDiagnostic = {
  passes: number;
  payloadsRead: number;
  payloadsDecompressed: number;
  selectedPayloadsRead: number;
  expandedPayloads: number;
  fullFallbackPayloads: number;
  compressedBytes: number;
  decompressedBytes: number;
};
type PayloadDiagnostics = {
  payloadSql: Record<PayloadSqlKind, PayloadSqlDiagnostic>;
  payloadReads: Record<PayloadReadPurpose, PayloadReadDiagnostic>;
};

/** SQL 子計時只涵蓋 prepare/get/all 呼叫，為 payloadLookup 的子集，不可再次加總至 phaseSelfMs。 */
export interface SearchTrace {
  schemaVersion: number;
  traceId: string;
  type: "search";
  startedAt: string;
  completedAt: string;
  durationMs: number;
  /** Largest phase after nested child time is removed. */
  bottleneck: SearchTracePhase;
  /** Largest phase before nested child time is removed. */
  inclusiveBottleneck: SearchTracePhase;
  status: SearchTraceStatus;
  errorCode?: string;
  query: string;
  normalizedQuery: string;
  mode: SearchTraceMode;
  field: SearchTraceField;
  sort: SearchTraceSort;
  candidateStrategy: SearchCandidateStrategy;
  candidateSources: SearchCandidateSource[];
  /** Backward-compatible inclusive phase totals. */
  phasesMs: Record<SearchTracePhase, number>;
  /** Exclusive phase totals with nested child phases removed. */
  phaseSelfMs: Record<SearchTracePhase, number>;
  counts: SearchTraceCounts;
  /** `gte` when a fast-mode search stopped before verifying every candidate (SPEC §52.3). */
  totalRelation: "eq" | "gte";
  diagnostics: PayloadDiagnostics;
}

function emptyPhases(): Record<SearchTracePhase, number> {
  return Object.fromEntries(searchTracePhases.map(phase => [phase, 0])) as Record<SearchTracePhase, number>;
}

function emptyCounts(): SearchTraceCounts {
  return {
    documentsInScope: 0,
    documentsConsidered: 0,
    documentsAfterPruning: 0,
    documentsPruned: 0,
    documentsExactVerified: 0,
    documentsMatched: 0,
    payloadsConsidered: 0,
    payloadsAfterPruning: 0,
    payloadsRead: 0,
    payloadsDecompressed: 0,
    payloadReadPasses: 0,
    postingPayloadHits: 0,
    expandedPayloads: 0,
    fullDocumentFallbacks: 0,
    filenameOnlyFallbacks: 0,
    blockExpansionRatio: 0,
    exactTextMs: 0,
    blocksMetadataRows: 0,
    owningBlockMappingRows: 0,
    bloomSelectedPayloads: 0,
    selectedPayloadsRead: 0,
    fullFallbackPayloads: 0,
    uniquePayloadsRead: 0,
    duplicatePayloadsRead: 0,
    uniquePayloadsDecompressed: 0,
    duplicatePayloadsDecompressed: 0,
    compressedBytesRead: 0,
    decompressedBytes: 0,
    maxBlockExpansionRatio: 0,
    maxExpandedPayloads: 0,
    maxSelectedPayloadsRead: 0,
    maxPayloadsReadPerPass: 0,
    payloadBrotliMs: 0,
    payloadDecodeParseMs: 0,
    blockExpansionInputPayloads: 0,
    candidatePayloadOrdinals: 0,
    owningBlocksFound: 0,
    indexPostingRows: 0,
    indexCandidateBlocks: 0,
    indexVerifiedBlocks: 0,
    indexCandidateChunks: 0,
    indexVerifiedChunks: 0,
    indexVerifiedBytes: 0,
    results: 0,
    returnedResults: 0,
  };
}

function emptyDiagnostics(): PayloadDiagnostics {
  const sql = (): PayloadSqlDiagnostic => ({ prepareCount: 0, executeCount: 0, prepareMs: 0, executeMs: 0 });
  const reads = (): PayloadReadDiagnostic => ({
    passes: 0, payloadsRead: 0, payloadsDecompressed: 0, selectedPayloadsRead: 0,
    expandedPayloads: 0, fullFallbackPayloads: 0, compressedBytes: 0, decompressedBytes: 0,
  });
  return {
    payloadSql: { blocksMetadata: sql(), owningBlockMapping: sql(), payloadBlob: sql() },
    payloadReads: { ranking: reads(), snippet: reads(), other: reads() },
  };
}
type ActivePhase = {
  phase: Exclude<SearchTracePhase, "other">;
  startedAt: number;
  childElapsedMs: number;
};

export class SearchTraceRecorder {
  private readonly traceId = randomUUID();
  private readonly startedAt = new Date().toISOString();
  private readonly startedClock = performance.now();
  private activeSince: number | undefined = this.startedClock;
  private activeElapsedMs = 0;
  private normalizedQuery = "";
  private readonly phaseTotals = emptyPhases();
  private readonly phaseSelfTotals = emptyPhases();
  private readonly activePhases: ActivePhase[] = [];
  private blockExpansionInputs = 0;
  private blockExpansionOutputs = 0;
  private readonly countValues = emptyCounts();
  private readonly diagnosticValues = emptyDiagnostics();
  private readonly readPayloads = new Map<number, Set<number>>();
  private readonly decompressedPayloads = new Map<number, Set<number>>();
  private readonly sources = new Set<SearchCandidateSource>();
  private status: SearchTraceStatus = "success";
  private totalRelation: "eq" | "gte" = "eq";
  private errorCode: string | undefined;

  constructor(
    private readonly rawQuery: string,
    private readonly mode: SearchTraceMode,
    private readonly field: SearchTraceField,
    private readonly sort: SearchTraceSort,
  ) {}

  setNormalizedQuery(query: string): void {
    this.normalizedQuery = query;
  }

  pause(): void {
    if (this.activeSince === undefined) return;
    this.activeElapsedMs += performance.now() - this.activeSince;
    this.activeSince = undefined;
  }

  resume(): void {
    if (this.activeSince !== undefined) return;
    this.activeSince = performance.now();
  }

  addPhase(phase: Exclude<SearchTracePhase, "other">, elapsedMs: number): void {
    const elapsed = Math.max(0, elapsedMs);
    this.phaseTotals[phase] += elapsed;
    this.phaseSelfTotals[phase] += elapsed;
    for (const active of this.activePhases) active.childElapsedMs += elapsed;
  }

  beginPhase(phase: Exclude<SearchTracePhase, "other">): ActivePhase {
    const active = { phase, startedAt: performance.now(), childElapsedMs: 0 };
    this.activePhases.push(active);
    return active;
  }

  endPhase(active: ActivePhase): void {
    const index = this.activePhases.lastIndexOf(active);
    if (index < 0) return;
    this.activePhases.splice(index, 1);
    const inclusive = Math.max(0, performance.now() - active.startedAt);
    const self = Math.max(0, inclusive - active.childElapsedMs);
    this.phaseTotals[active.phase] += inclusive;
    this.phaseSelfTotals[active.phase] += self;
    for (const parent of this.activePhases) parent.childElapsedMs += self;
  }

  recordBlockExpansion(requestedPayloads: number, readPayloads: number): void {
    this.blockExpansionInputs += Math.max(0, requestedPayloads);
    this.blockExpansionOutputs += Math.max(0, readPayloads);
    if (requestedPayloads > 0) {
      this.countValues.maxBlockExpansionRatio = Math.max(this.countValues.maxBlockExpansionRatio, readPayloads / requestedPayloads);
    }
  }

  recordPayloadSql(kind: PayloadSqlKind, operation: "prepare" | "execute", elapsedMs: number): void {
    const diagnostic = this.diagnosticValues.payloadSql[kind];
    if (operation === "prepare") {
      diagnostic.prepareCount++;
      diagnostic.prepareMs += Math.max(0, elapsedMs);
    } else {
      diagnostic.executeCount++;
      diagnostic.executeMs += Math.max(0, elapsedMs);
    }
  }

  private payloadReadPurpose(snippet: boolean): PayloadReadPurpose {
    if (snippet) return "snippet";
    return this.activePhases.some(active => active.phase === "exactVerification") ? "ranking" : "other";
  }

  private firstPayloadRead(seen: Map<number, Set<number>>, documentId: number, ordinal: number): boolean {
    let ordinals = seen.get(documentId);
    if (!ordinals) {
      ordinals = new Set();
      seen.set(documentId, ordinals);
    }
    if (ordinals.has(ordinal)) return false;
    ordinals.add(ordinal);
    return true;
  }

  recordPayloadReadPass(documentId: number, payloads: readonly { ordinal: number; payload: Uint8Array }[],
    selectedPayloads: readonly number[] | undefined, snippet = false): void {
    const diagnostic = this.diagnosticValues.payloadReads[this.payloadReadPurpose(snippet)];
    // 讀取以 SQL 已回傳的 blob 計；提早停止 generator 時不一定全數解壓。
    const requested = selectedPayloads ? new Set(selectedPayloads) : undefined;
    let selected = 0;
    let compressedBytes = 0;
    for (const payload of payloads) {
      compressedBytes += payload.payload.byteLength;
      if (requested?.has(payload.ordinal)) selected++;
      this.increment(this.firstPayloadRead(this.readPayloads, documentId, payload.ordinal)
        ? "uniquePayloadsRead" : "duplicatePayloadsRead");
    }
    const expanded = requested ? payloads.length - selected : 0;
    const fallback = requested ? 0 : payloads.length;
    if (requested) this.recordBlockExpansion(requested.size, payloads.length);
    this.increment("payloadReadPasses");
    this.increment("payloadsRead", payloads.length);
    this.increment("selectedPayloadsRead", selected);
    this.increment("expandedPayloads", expanded);
    this.increment("fullFallbackPayloads", fallback);
    this.increment("compressedBytesRead", compressedBytes);
    this.countValues.maxExpandedPayloads = Math.max(this.countValues.maxExpandedPayloads, expanded);
    this.countValues.maxSelectedPayloadsRead = Math.max(this.countValues.maxSelectedPayloadsRead, selected);
    this.countValues.maxPayloadsReadPerPass = Math.max(this.countValues.maxPayloadsReadPerPass, payloads.length);
    diagnostic.passes++;
    diagnostic.payloadsRead += payloads.length;
    diagnostic.selectedPayloadsRead += selected;
    diagnostic.expandedPayloads += expanded;
    diagnostic.fullFallbackPayloads += fallback;
    diagnostic.compressedBytes += compressedBytes;
  }

  recordPayloadDecompression(documentId: number, ordinal: number, bytes: number, snippet = false): void {
    const diagnostic = this.diagnosticValues.payloadReads[this.payloadReadPurpose(snippet)];
    this.increment("payloadsDecompressed");
    this.increment("decompressedBytes", bytes);
    this.increment(this.firstPayloadRead(this.decompressedPayloads, documentId, ordinal)
      ? "uniquePayloadsDecompressed" : "duplicatePayloadsDecompressed");
    diagnostic.payloadsDecompressed++;
    diagnostic.decompressedBytes += bytes;
  }

  increment<K extends keyof SearchTraceCounts>(count: K, amount = 1): void {
    this.countValues[count] += amount;
  }

  setCount<K extends keyof SearchTraceCounts>(count: K, value: number): void {
    this.countValues[count] = Math.max(0, value);
  }

  addCandidateSource(source: SearchCandidateSource): void {
    this.sources.add(source);
  }
  setTotalRelation(relation: "eq" | "gte"): void {
    this.totalRelation = relation;
  }

  setError(code: string): void {
    this.status = "error";
    this.errorCode = code;
  }

  snapshot(results = this.countValues.results, returnedResults = this.countValues.returnedResults): SearchTrace {
    const activeElapsed = this.activeSince === undefined ? 0 : performance.now() - this.activeSince;
    const durationMs = Math.max(0, this.activeElapsedMs + activeElapsed);
    const phasesMs = { ...this.phaseTotals };
    const phaseSelfMs = { ...this.phaseSelfTotals };
    const measuredInclusive = searchTracePhases
      .filter(phase => phase !== "other")
      .reduce((total, phase) => total + phasesMs[phase], 0);
    const measuredSelf = searchTracePhases
      .filter(phase => phase !== "other")
      .reduce((total, phase) => total + phaseSelfMs[phase], 0);
    phasesMs.other = Math.max(0, durationMs - measuredInclusive);
    phaseSelfMs.other = Math.max(0, durationMs - measuredSelf);
    let bottleneck: SearchTracePhase = "other";
    let inclusiveBottleneck: SearchTracePhase = "other";
    for (const phase of searchTracePhases) {
      if (phaseSelfMs[phase] > phaseSelfMs[bottleneck]) bottleneck = phase;
      if (phasesMs[phase] > phasesMs[inclusiveBottleneck]) inclusiveBottleneck = phase;
    }
    const sources = [...this.sources];
    const candidateStrategy = sources.includes("chunk-index")
      ? sources.includes("restricted-ids") ? "chunk-index+restricted-ids" : "chunk-index"
      : sources.includes("block-index")
      ? sources.includes("restricted-ids") ? "block-index+restricted-ids" : "block-index"
      : sources.includes("postings")
      ? sources.includes("restricted-ids") ? "postings+restricted-ids" : "postings"
      : sources.includes("bloom-fallback")
        ? "bloom-fallback"
        : sources.includes("restricted-ids") ? "restricted-ids"
          : sources.includes("document-scan") ? "document-scan" : "none";
    const counts = {
      ...this.countValues,
      results,
      returnedResults,
      blockExpansionRatio: this.blockExpansionInputs
        ? this.blockExpansionOutputs / this.blockExpansionInputs : 0,
      blockExpansionInputPayloads: this.blockExpansionInputs,
    };
    const trace: SearchTrace = {
      schemaVersion: SEARCH_TRACE_SCHEMA_VERSION,
      traceId: this.traceId,
      type: "search",
      startedAt: this.startedAt,
      completedAt: new Date().toISOString(),
      durationMs,
      bottleneck,
      inclusiveBottleneck,
      status: this.status,
      query: this.rawQuery,
      normalizedQuery: this.normalizedQuery || this.rawQuery.trim(),
      mode: this.mode,
      field: this.field,
      sort: this.sort,
      candidateStrategy,
      candidateSources: sources,
      phasesMs,
      phaseSelfMs,
      counts,
      totalRelation: this.totalRelation,
      diagnostics: structuredClone(this.diagnosticValues),
    };
    if (this.errorCode) trace.errorCode = this.errorCode;
    return trace;
  }
}

export function emptySearchTrace(rawQuery: string, mode: SearchTraceMode, field: SearchTraceField, sort: SearchTraceSort): SearchTrace {
  const recorder = new SearchTraceRecorder(rawQuery, mode, field, sort);
  recorder.setNormalizedQuery(rawQuery.trim().normalize("NFKC").toLowerCase());
  return recorder.snapshot(0, 0);
}
