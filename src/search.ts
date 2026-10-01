import { documentReference } from "./document-reference.js";
import path from "node:path";
import type { DocumentStatus } from "./model.js";
import { SearchTraceRecorder, type SearchTrace } from "./search-trace.js";
import type { IndexStore, StoredBlockRow, StoredDocumentRow } from "./store.js";

export function normalize(value: string): string {
  return value.normalize("NFKC").toLowerCase();
}

function comparePath(left: string, right: string): number {
  return left === right ? 0 : left < right ? -1 : 1;
}

export function parseTypes(value: string): string[] {
  const types = value.split(",").map(item => item.trim().replace(/^\./, "").toLowerCase());
  if (types.some(type => !type || type.length > 254 || !/^[^./\\\x00-\x1f]+$/u.test(type))) {
    throw new Error("--type 必須是副檔名清單，以逗號分隔且不可有空項目、路徑分隔符或多餘的句點。");
  }
  return [...new Set(types.map(type => `.${type}`))];
}

// 每個正規化 UTF-16 單位對應原文範圍；以 grapheme 保留組合字元的來源。
function normalizedRanges(content: string): { starts: number[]; ends: number[] } {
  const starts: number[] = [];
  const ends: number[] = [];
  let normalized = "";
  for (const { segment, index } of new Intl.Segmenter("und", { granularity: "grapheme" }).segment(content)) {
    const part = segment.normalize("NFKC");
    normalized += part;
    for (let i = 0; i < part.length; i++) { starts.push(index); ends.push(index + segment.length); }
  }
  if (normalized !== content.normalize("NFKC")) {
    // 某些相鄰 grapheme 在 NFKC 後仍會組合；以完整前綴重算該少見情境。
    normalized = "";
    starts.length = 0;
    ends.length = 0;
    let offset = 0;
    for (const character of content) {
      const next = content.slice(0, offset + character.length).normalize("NFKC");
      let common = 0;
      while (common < normalized.length && common < next.length && normalized[common] === next[common]) common++;
      const start = starts[common] ?? offset;
      starts.length = common;
      ends.length = common;
      for (let i = common; i < next.length; i++) { starts.push(start); ends.push(offset + character.length); }
      normalized = next;
      offset += character.length;
    }
  }
  // 大小寫轉換的語境（例如希臘 final sigma）由 normalize() 整串處理。
  // 範圍只依每個 code point 轉小寫後的長度展開，保留 İ 等一對多映射。
  const lowerStarts: number[] = [];
  const lowerEnds: number[] = [];
  let offset = 0;
  for (const character of normalized) {
    for (let i = 0; i < character.toLowerCase().length; i++) {
      lowerStarts.push(starts[offset]!);
      lowerEnds.push(ends[offset + character.length - 1]!);
    }
    offset += character.length;
  }
  return { starts: lowerStarts, ends: lowerEnds };
}

const snippetChunkSize = 32 * 1024;

/**
 * Map just the requested normalized UTF-16 offsets back to the source. Chunks
 * are only an optimisation: an unexpected context-sensitive normalization
 * change returns null so callers can retain the known-correct full mapping.
 */
function chunkedOffsets(content: string, normalized: string, start: number, end: number):
  { startOffset: number; endOffset: number } | null {
  let normalizedOffset = 0;
  let startOffset: number | undefined;
  let endOffset: number | undefined;
  let chunkStart = 0;
  let chunkEnd = 0;
  const mapChunk = (sourceStart: number, sourceEnd: number): boolean => {
    const source = content.slice(sourceStart, sourceEnd);
    const chunkNormalized = normalize(source);
    if (normalized.slice(normalizedOffset, normalizedOffset + chunkNormalized.length) !== chunkNormalized) return false;
    const chunkNormalizedEnd = normalizedOffset + chunkNormalized.length;
    if ((start >= normalizedOffset && start < chunkNormalizedEnd) || (end >= normalizedOffset && end < chunkNormalizedEnd)) {
      // Most CJK, Latin and identifier text maps one source code point at a
      // time. Verify that property before using it; combining sequences and
      // context-sensitive case changes deliberately fall back below.
      let sourceOffset = 0;
      let localNormalizedOffset = 0;
      let direct = true;
      while (sourceOffset < source.length) {
        const pointEnd = codePointEnd(source, sourceOffset);
        const pointNormalized = normalize(source.slice(sourceOffset, pointEnd));
        if (chunkNormalized.slice(localNormalizedOffset, localNormalizedOffset + pointNormalized.length) !== pointNormalized) {
          direct = false; break;
        }
        const normalizedPointEnd = localNormalizedOffset + pointNormalized.length;
        if (start >= normalizedOffset + localNormalizedOffset && start < normalizedOffset + normalizedPointEnd) startOffset = sourceStart + sourceOffset;
        if (end >= normalizedOffset + localNormalizedOffset && end < normalizedOffset + normalizedPointEnd) endOffset = sourceStart + pointEnd;
        sourceOffset = pointEnd;
        localNormalizedOffset = normalizedPointEnd;
      }
      if (!direct || localNormalizedOffset !== chunkNormalized.length) {
        const ranges = normalizedRanges(source);
        if (ranges.starts.length !== chunkNormalized.length) return false;
        if (start >= normalizedOffset && start < chunkNormalizedEnd) startOffset = sourceStart + ranges.starts[start - normalizedOffset]!;
        if (end >= normalizedOffset && end < chunkNormalizedEnd) endOffset = sourceStart + ranges.ends[end - normalizedOffset]!;
      }
    }
    normalizedOffset = chunkNormalizedEnd;
    return true;
  };
  // Intl.Segmenter over a multi-megabyte source can itself retain a large
  // segmentation structure. Split only at code point boundaries here; a
  // normalization that crosses a boundary is detected by mapChunk and falls
  // back to normalizedRanges(), whose Segmenter input is bounded to one chunk.
  while (chunkStart < content.length) {
    chunkEnd = Math.min(content.length, chunkStart + snippetChunkSize);
    if (chunkEnd < content.length && chunkEnd > chunkStart) {
      const preceding = codePointBefore(content, chunkEnd);
      if (preceding < chunkEnd) chunkEnd = preceding;
      while (chunkEnd < content.length && chunkEnd - chunkStart < snippetChunkSize) chunkEnd = codePointEnd(content, chunkEnd);
    }
    if (!mapChunk(chunkStart, chunkEnd)) return null;
    chunkStart = chunkEnd;
  }
  if (normalizedOffset !== normalized.length || startOffset === undefined || endOffset === undefined) return null;
  return { startOffset, endOffset };
}

type CollectedText = { characters: string[]; hasMore: boolean };

function codePointBefore(value: string, offset: number): number {
  let start = offset - 1;
  if (start > 0 && value.charCodeAt(start) >= 0xdc00 && value.charCodeAt(start) <= 0xdfff
    && value.charCodeAt(start - 1) >= 0xd800 && value.charCodeAt(start - 1) <= 0xdbff) start--;
  return start;
}

function codePointEnd(value: string, offset: number): number {
  return offset + String.fromCodePoint(value.codePointAt(offset)!).length;
}

function collectForward(value: string, start: number, end: number, limit: number): CollectedText {
  const characters: string[] = [];
  let offset = start;
  let previousWhitespace = false;
  while (offset < end) {
    const point = String.fromCodePoint(value.codePointAt(offset)!);
    offset += point.length;
    const whitespace = /\s/u.test(point);
    if (whitespace && previousWhitespace) continue;
    previousWhitespace = whitespace;
    if (characters.length === limit) return { characters, hasMore: true };
    characters.push(whitespace ? " " : point);
  }
  return { characters, hasMore: false };
}

function collectBackward(value: string, start: number, end: number, limit: number): CollectedText {
  const reverse: string[] = [];
  let offset = end;
  let previousWhitespace = false;
  let hasMore = false;
  while (offset > start) {
    const pointStart = codePointBefore(value, offset);
    const point = value.slice(pointStart, offset);
    offset = pointStart;
    const whitespace = /\s/u.test(point);
    if (whitespace && previousWhitespace) continue;
    previousWhitespace = whitespace;
    if (reverse.length === limit) hasMore = true;
    else reverse.push(whitespace ? " " : point);
  }
  return { characters: reverse.reverse(), hasMore };
}

export function makeSnippet(content: string, query: string): { text: string; truncated: boolean } {
  const normalized = normalize(content);
  const position = normalized.indexOf(query);
  if (position < 0) throw new Error("命中片段的來源沒有查詢文字。");
  const endPosition = position + query.length - 1;
  const mapped = chunkedOffsets(content, normalized, position, endPosition);
  const ranges = mapped ? null : normalizedRanges(content);
  const startOffset = mapped?.startOffset ?? ranges!.starts[position]!;
  const endOffset = mapped?.endOffset ?? ranges!.ends[endPosition]!;
  const matched = collectForward(content, startOffset, endOffset, 161);
  if (matched.characters.length >= 159 && matched.characters.length <= 160 && !matched.hasMore) {
    const after = collectForward(content, endOffset, content.length, 1);
    return { text: matched.characters.join("") + (matched.characters.length === 159 && after.characters.length > 0 ? "…" : ""), truncated: false };
  }
  const truncated = matched.characters.length > 160 || matched.hasMore;
  const before = truncated ? { characters: [], hasMore: false } : collectBackward(content, 0, startOffset, 45);
  const leftCount = Math.min(45, before.characters.length, Math.max(0, 158 - matched.characters.length));
  const rightCount = Math.max(0, 158 - leftCount - matched.characters.length);
  const after = collectForward(content, endOffset, content.length, rightCount);
  const text = `${before.hasMore || before.characters.length > leftCount ? "…" : ""}${before.characters.slice(before.characters.length - leftCount).join("")}${matched.characters.slice(0, 158).join("")}${after.characters.join("")}${after.hasMore || matched.characters.length > 158 || matched.hasMore ? "…" : ""}`.trim();
  return { text, truncated };
}

export interface SearchPassage {
  /** Unique normalized query terms represented by this passage, in document order. */
  terms: string[];
  heading: string | null;
  location: string | null;
  snippet: string;
  snippetTruncated: boolean;
}

export interface SearchResult {
  reference: string;
  path: string;
  extension: string;
  modifiedAtMs: number;
  heading: string | null;
  location: string | null;
  snippet: string;
  rank: number;
  reason: string;
  filenameOnly: boolean;
  status: DocumentStatus;
  snippetTruncated: boolean;
  passages?: SearchPassage[];
  omittedTerms?: number;
  condition?: string;
}

export type SearchMode = "phrase" | "all-terms";
export type SearchField = "all" | "filename" | "content";
export type SearchSort = "relevance" | "filename" | "modified";

type RankedResult = Omit<SearchResult, "passages" | "omittedTerms">;

interface RankedSearchResult {
  result: RankedResult;
  documentId: number;
  ordinal: number | null;
  sourceKind: "filename" | "heading" | "content";
  passageOrdinals?: number[] | undefined;
}

export interface SearchResultPage {
  page: number;
  pageSize: number;
  total: number;
  pageCount: number;
  start: number;
  end: number;
  results: SearchResult[];
}

export interface SearchResultSet {
  /** Exact when `totalRelation` is `eq`; otherwise a lower bound (SPEC §52.3). */
  readonly total: number;
  readonly totalRelation: "eq" | "gte";
  readonly dataVersion: number;
  readonly trace: SearchTrace;
  page(page: number, pageSize: number): SearchResultPage;
}

function queryTerms(rawQuery: string, mode: SearchMode): { query: string; terms: string[] } {
  const query = normalize(rawQuery.trim());
  if (!query) throw new Error("搜尋文字不可為空白。");
  const terms = mode === "all-terms"
    ? [...new Set(rawQuery.trim().split(/\s+/u).map(normalize).filter(Boolean))]
    : [query];
  return { query, terms };
}
function searchTraceErrorCode(error: unknown): string {
  if (error instanceof Error && "code" in error && typeof (error as Error & { code?: unknown }).code === "string") {
    return (error as Error & { code: string }).code;
  }
  return "SEARCH_FAILED";
}

function includesAll(value: string, terms: readonly string[]): boolean {
  return terms.every(term => value.includes(term));
}

function snippetTerm(source: string, terms: readonly string[]): string {
  const normalized = normalize(source);
  return terms.map(term => ({ term, position: normalized.indexOf(term) })).filter(hit => hit.position >= 0)
    .sort((a, b) => a.position - b.position)[0]!.term;
}

const MAX_PASSAGE_TERMS = 4;

function termsInDocumentOrder(source: string, terms: readonly string[]): string[] {
  const normalized = normalize(source);
  return [...new Set(terms)]
    .map((term, index) => ({ term, index, position: normalized.indexOf(term) }))
    .filter(hit => hit.position >= 0)
    .sort((left, right) => left.position - right.position || left.index - right.index)
    .map(hit => hit.term);
}

type PassageBlock = { block: StoredBlockRow; terms: string[]; source: string };

function matchingPassageBlock(block: StoredBlockRow, terms: readonly string[]): PassageBlock | undefined {
  const heading = block.heading ? normalize(block.heading) : "";
  const content = normalize(block.content);
  const matched = terms.filter(term => heading.includes(term) || content.includes(term));
  if (!matched.length) return undefined;
  const sourceParts: string[] = [];
  if (block.heading && matched.some(term => heading.includes(term))) sourceParts.push(block.heading);
  if (matched.some(term => content.includes(term))) sourceParts.push(block.content);
  const source = sourceParts.join("\n");
  return { block, terms: termsInDocumentOrder(source, matched), source };
}

function toSearchPassage(item: PassageBlock): SearchPassage {
  const terms = termsInDocumentOrder(item.source, item.terms);
  const snippet = makeSnippet(item.source, snippetTerm(item.source, terms));
  return {
    terms,
    heading: item.block.heading,
    location: item.block.location_value,
    snippet: snippet.text,
    snippetTruncated: snippet.truncated,
  };
}

function allTermsPassages(store: IndexStore, filePath: string, terms: readonly string[],
  trace?: SearchTraceRecorder): { passages: SearchPassage[]; omittedTerms: number } {
  const passageTerms = terms.slice(0, MAX_PASSAGE_TERMS);
  const omittedTerms = Math.max(0, terms.length - passageTerms.length);
  if (!passageTerms.length) return { passages: [], omittedTerms };
  const candidate = store.candidateByPath(filePath, trace);
  if (!candidate) return { passages: [], omittedTerms };

  const occurrences = new Map<string, PassageBlock[]>();
  for (const block of candidate.blocks) {
    const match = matchingPassageBlock(block, passageTerms);
    if (!match) continue;
    for (const term of match.terms) {
      const termOccurrences = occurrences.get(term) ?? [];
      termOccurrences.push({ ...match, terms: [term] });
      occurrences.set(term, termOccurrences);
    }
  }

  const selected = new Map<number, PassageBlock>();
  for (const term of passageTerms) {
    const termOccurrences = occurrences.get(term) ?? [];
    if (!termOccurrences.length) continue;
    const otherOccurrences = [...occurrences.entries()]
      .filter(([otherTerm]) => otherTerm !== term)
      .flatMap(([, values]) => values)
      .sort((left, right) => left.block.ordinal - right.block.ordinal);
    let chosen = termOccurrences[0]!;
    if (otherOccurrences.length) {
      const distance = (item: PassageBlock, other: PassageBlock): number =>
        Math.abs(item.block.ordinal - other.block.ordinal);
      const nearestDistance = (item: PassageBlock): number => {
        let low = 0;
        let high = otherOccurrences.length;
        while (low < high) {
          const middle = Math.floor((low + high) / 2);
          if (otherOccurrences[middle]!.block.ordinal < item.block.ordinal) low = middle + 1;
          else high = middle;
        }
        const previous = otherOccurrences[low - 1];
        const next = otherOccurrences[low];
        return Math.min(
          previous ? distance(item, previous) : Number.POSITIVE_INFINITY,
          next ? distance(item, next) : Number.POSITIVE_INFINITY,
        );
      };
      chosen = termOccurrences.reduce((best, item) => {
        const itemDistance = nearestDistance(item);
        const bestDistance = nearestDistance(best);
        return itemDistance < bestDistance || (itemDistance === bestDistance && item.block.ordinal < best.block.ordinal)
          ? item : best;
      });
    }
    const existing = selected.get(chosen.block.ordinal);
    if (existing) existing.terms.push(term);
    else selected.set(chosen.block.ordinal, chosen);
  }

  const selectedBlocks = [...selected.values()].sort((left, right) => left.block.ordinal - right.block.ordinal);
  const passages: SearchPassage[] = [];
  let group: PassageBlock[] = [];
  const flush = () => {
    if (!group.length) return;
    const source = group.map(item => item.source).join("\n");
    const groupTerms = termsInDocumentOrder(source, group.flatMap(item => item.terms));
    const snippet = makeSnippet(source, snippetTerm(source, groupTerms));
    passages.push({
      terms: groupTerms,
      heading: group[0]!.block.heading,
      location: group[0]!.block.location_value,
      snippet: snippet.text,
      snippetTruncated: snippet.truncated,
    });
    group = [];
  };
  for (const item of selectedBlocks) {
    const previous = group.at(-1);
    if (previous && item.block.ordinal !== previous.block.ordinal + 1) flush();
    group.push(item);
  }
  flush();
  return { passages, omittedTerms };
}

function phrasePassageBlocks(store: IndexStore, documentId: number, filePath: string, terms: readonly string[],
  preferredOrdinal: number | null, primarySource: string, passageOrdinals: readonly number[] | undefined,
  trace?: SearchTraceRecorder): PassageBlock[] {
  let ordinals = passageOrdinals ? [...passageOrdinals] : [];
  if (!passageOrdinals) {
    if (store.chunkStoreReady()) {
      for (const chunk of store.chunkCandidatesForDocument(terms[0]!, documentId, trace)) {
        ordinals.push(...(store.chunkTermHits(chunk, terms, false, trace).get(terms[0]!) ?? []));
      }
    } else if (store.blockIndexReady()) {
      ordinals.push(...store.indexHeadingCandidates(terms[0]!, trace)
        .filter(row => row.documentId === documentId && normalize(row.heading).includes(terms[0]!))
        .map(row => row.ordinal));
      ordinals.push(...store.indexContentBlocks(terms, [documentId], trace)
        .filter(row => row.documentId === documentId)
        .map(row => row.ordinal));
    } else if (preferredOrdinal === null) {
      const candidate = store.candidateByPath(filePath, trace);
      for (const block of candidate?.blocks ?? []) {
        if (matchingPassageBlock(block, terms)) ordinals.push(block.ordinal);
      }
    }
  }
  if (preferredOrdinal !== null) ordinals.push(preferredOrdinal);
  const uniqueOrdinals = [...new Set(ordinals)].sort((left, right) =>
    Number(right === preferredOrdinal) - Number(left === preferredOrdinal) || left - right).slice(0, 2);
  const matches: PassageBlock[] = [];
  for (const ordinal of uniqueOrdinals) {
    const display = store.blockDisplay(documentId, ordinal);
    const headingMatches = display.heading !== null && terms.every(term => normalize(display.heading!).includes(term));
    const content = ordinal === preferredOrdinal ? primarySource
      : headingMatches ? "" : store.blockSource(documentId, ordinal, "content", trace) ?? "";
    const block: StoredBlockRow = {
      ordinal,
      heading: display.heading,
      content,
      location_kind: display.location_kind,
      location_value: display.location,
    };
    const match = matchingPassageBlock(block, terms);
    if (match) matches.push(match);
  }
  return matches;
}

type SelectedBlock = { block: StoredBlockRow; source: string; coverage: number; headingHit: boolean };

function rankDocument(document: StoredDocumentRow, blocks: Iterable<StoredBlockRow>, query: string, terms: readonly string[],
  mode: SearchMode, field: SearchField, trace?: SearchTraceRecorder): RankedSearchResult | undefined {
  const filename = normalize(document.filename);
  const filenameRank = field === "content" ? 0 : filename === query ? 4 : includesAll(filename, terms) ? 3 : 0;
  let headingBlock: StoredBlockRow | undefined;
  let contentBlock: StoredBlockRow | undefined;
  let representative: SelectedBlock | undefined;
  const phraseOrdinals = new Set<number>();
  const unmatched = new Set(terms.filter(term => field === "content" || !filename.includes(term)));
  if (!filenameRank && field !== "filename") {
    for (const block of blocks) {
      const exactTextStarted = performance.now();
      const heading = normalize(block.heading ?? "");
      const content = normalize(block.content);
      if (mode === "phrase" && phraseOrdinals.size < 2 && (heading.includes(query) || content.includes(query))) phraseOrdinals.add(block.ordinal);
      if (mode === "all-terms") {
        for (const term of unmatched) if (heading.includes(term) || content.includes(term)) unmatched.delete(term);
      }
      if (block.heading && includesAll(heading, terms) && !headingBlock) headingBlock = block;
      if (includesAll(content, terms) && !contentBlock) contentBlock = block;
      if (mode === "all-terms") {
        const source = block.heading && terms.some(term => heading.includes(term)) ? block.heading : block.content;
        const normalizedSource = source === block.heading ? heading : content;
        const candidate: SelectedBlock = { block, source, coverage: terms.filter(term => normalizedSource.includes(term)).length,
          headingHit: source === block.heading };
        if (candidate.coverage > 0 && (!representative || candidate.coverage > representative.coverage
          || (candidate.coverage === representative.coverage && (Number(candidate.headingHit) > Number(representative.headingHit)
            || (candidate.headingHit === representative.headingHit && candidate.block.ordinal < representative.block.ordinal))))) {
          representative = candidate;
        }
      }
      trace?.increment("exactTextMs", performance.now() - exactTextStarted);
    }
  }
  if (mode === "all-terms" && !filenameRank && unmatched.size > 0) return undefined;
  const block = filenameRank ? undefined : headingBlock ?? contentBlock ?? representative?.block;
  const rank = filenameRank || (headingBlock ? 2 : contentBlock ? 1 : 0);
  const effectiveRank = rank || (mode === "all-terms" && representative ? 1 : 0);
  if (!effectiveRank) return undefined;
  if (filenameRank) trace?.increment("filenameOnlyFallbacks");
  const sourceKind = filenameRank ? "filename" : headingBlock ? "heading" : contentBlock ? "content"
    : representative?.headingHit ? "heading" : "content";
  return { result: { reference: documentReference(document.id, document.path), path: document.path, extension: document.extension,
    modifiedAtMs: document.modified_at_ms, heading: block?.heading ?? null,
    location: block?.location_value ?? null, snippet: "", rank: effectiveRank,
    reason: rankReason(mode, effectiveRank),
    filenameOnly: !block, status: document.status, snippetTruncated: false },
    documentId: document.id, ordinal: block?.ordinal ?? null, sourceKind,
    passageOrdinals: mode === "phrase" && !filenameRank ? [...phraseOrdinals] : undefined };
}

function rankReason(mode: SearchMode, rank: number): string {
  return mode === "all-terms" ? ["", "內容（全部關鍵字）", "標題（全部關鍵字）", "檔名包含（全部關鍵字）", "檔名完全符合"][rank]!
    : ["", "內容", "標題", "檔名包含", "檔名完全符合"][rank]!;
}

type IndexedRank = { rank: number; sourceKind: RankedSearchResult["sourceKind"]; ordinal: number | null; passageOrdinals?: number[] | undefined };

/**
 * SPEC §50.2: the same ranking as rankDocument(), computed from the block
 * index instead of reading document content. Filename and heading candidates
 * are verified on their plain text; content hits are exact.
 */
function indexedHits(store: IndexStore, query: string, terms: readonly string[], mode: SearchMode, field: SearchField,
  types: readonly string[] | undefined, root: string | undefined, subtree: string | undefined,
  statuses: readonly DocumentStatus[] | undefined, restrictIds: readonly number[] | undefined,
  trace: SearchTraceRecorder): RankedSearchResult[] {
  trace.addCandidateSource("block-index");
  const restrict = restrictIds ? [...new Set(restrictIds)] : undefined;
  const allowed = restrict ? new Set(restrict) : undefined;
  if (restrict) trace.addCandidateSource("restricted-ids");
  trace.setCount("documentsInScope", restrict ? restrict.length : store.documentsInScope(types, root, subtree));
  const documents = new Map<number, StoredDocumentRow>();
  const fetched = new Set<number>();
  const load = (ids: Iterable<number>) => {
    const missing = [...ids].filter(id => !fetched.has(id) && (!allowed || allowed.has(id)));
    for (const id of missing) fetched.add(id);
    if (!missing.length) return;
    // Restricted ids (search within results) ignore type／root scope, as streamCandidatesByIds does.
    const rows = restrict ? store.indexDocuments(missing, undefined, undefined, undefined, trace)
      : store.indexDocuments(missing, types, root, subtree, trace);
    for (const row of rows) {
      if (statuses?.length && !statuses.includes(row.status)) continue;
      documents.set(Number(row.id), row);
    }
  };
  const verify = <T>(work: () => T): T => {
    const phase = trace.beginPhase("exactVerification");
    try { return work(); } finally { trace.endPhase(phase); }
  };
  const ranks = new Map<number, IndexedRank>();

  // Filename: 4 exact, 3 contains every term; it wins over any block hit.
  if (field !== "content") {
    let candidates: Set<number> | undefined;
    for (const term of terms) {
      const ids = store.indexFilenameCandidates(term, trace);
      candidates = candidates ? new Set(ids.filter(id => candidates!.has(id))) : new Set(ids);
      if (!candidates.size) break;
    }
    load(candidates ?? []);
    verify(() => {
      for (const id of candidates ?? []) {
        const document = documents.get(id);
        if (!document) continue;
        trace.increment("documentsExactVerified");
        const filename = normalize(document.filename);
        const rank = filename === query ? 4 : includesAll(filename, terms) ? 3 : 0;
        if (rank) ranks.set(id, { rank, sourceKind: "filename", ordinal: null });
      }
    });
  }

  if (field !== "filename") {
    // Distinct headings (first ordinal) that really contain each term.
    const headingHits = new Map<string, { documentId: number; ordinal: number; heading: string; normalized: string }[]>();
    for (const term of new Set(terms)) {
      const candidates = store.indexHeadingCandidates(term, trace);
      headingHits.set(term, verify(() => candidates
        .filter(row => !allowed || allowed.has(row.documentId))
        .map(row => ({ ...row, normalized: normalize(row.heading) }))
        .filter(row => row.normalized.includes(term))));
    }
    const headingAll = new Map<number, number>();
    for (const row of headingHits.get(terms[0]!)!) {
      if (!includesAll(row.normalized, terms)) continue;
      const previous = headingAll.get(row.documentId);
      if (previous === undefined || row.ordinal < previous) headingAll.set(row.documentId, row.ordinal);
    }
    const contentAll = store.indexContentFirstBlocks(terms, restrict, trace);
    const phraseContentOrdinals = new Map<number, number[]>();
    if (mode === "phrase") {
      for (const row of store.indexContentBlocks(terms, restrict, trace)) {
        const ordinals = phraseContentOrdinals.get(row.documentId) ?? [];
        ordinals.push(row.ordinal);
        phraseContentOrdinals.set(row.documentId, ordinals);
      }
    }
    const phrasePassageOrdinals = (documentId: number): number[] => {
      const ordinals = [
        ...(headingHits.get(terms[0]!) ?? []).filter(row => row.documentId === documentId).map(row => row.ordinal),
        ...(phraseContentOrdinals.get(documentId) ?? []),
      ];
      return [...new Set(ordinals)].sort((left, right) => left - right);
    };
    const blockRank = (documentId: number): IndexedRank | undefined => {
      const heading = headingAll.get(documentId);
      if (heading !== undefined) return { rank: 2, sourceKind: "heading", ordinal: heading,
        passageOrdinals: mode === "phrase" ? phrasePassageOrdinals(documentId) : undefined };
      const content = contentAll.get(documentId);
      return content === undefined ? undefined : { rank: 1, sourceKind: "content", ordinal: content,
        passageOrdinals: mode === "phrase" ? phrasePassageOrdinals(documentId) : undefined };
    };

    if (mode === "phrase") {
      const candidates = new Set([...headingAll.keys(), ...contentAll.keys()].filter(id => !ranks.has(id)));
      load(candidates);
      for (const id of candidates) {
        if (!documents.has(id)) continue;
        trace.increment("documentsExactVerified");
        ranks.set(id, blockRank(id)!);
      }
    } else {
      // all-terms: every term not in the filename must occur in some heading or block.
      const present = new Map<string, Set<number>>();
      for (const term of new Set(terms)) {
        const set = new Set(headingHits.get(term)!.map(row => row.documentId));
        const single = terms.length === 1 ? contentAll : store.indexContentFirstBlocks([term], restrict, trace);
        for (const id of single.keys()) set.add(id);
        present.set(term, set);
      }
      const candidates = new Set<number>();
      for (const set of present.values()) for (const id of set) if (!ranks.has(id)) candidates.add(id);
      load(candidates);
      const representatives: number[] = [];
      verify(() => {
        for (const id of candidates) {
          const document = documents.get(id);
          if (!document) continue;
          trace.increment("documentsExactVerified");
          const filename = normalize(document.filename);
          const unmatched = terms.filter(term => field === "content" || !filename.includes(term));
          if (!unmatched.every(term => present.get(term)!.has(id))) continue;
          const ranked = blockRank(id);
          if (ranked) ranks.set(id, ranked);
          else representatives.push(id);
        }
      });
      if (representatives.length) {
        // Coverage representative: heading source when the heading holds any term,
        // otherwise block content; best coverage, then heading, then smallest ordinal.
        const best = new Map<number, { coverage: number; headingHit: boolean; ordinal: number }>();
        const offer = (documentId: number, candidate: { coverage: number; headingHit: boolean; ordinal: number }) => {
          const current = best.get(documentId);
          if (!current || candidate.coverage > current.coverage || (candidate.coverage === current.coverage
            && (Number(candidate.headingHit) > Number(current.headingHit)
              || (candidate.headingHit === current.headingHit && candidate.ordinal < current.ordinal)))) best.set(documentId, candidate);
        };
        const wanted = new Set(representatives);
        const headingSeen = new Set<string>();
        for (const rows of headingHits.values()) {
          for (const row of rows) {
            const key = `${row.documentId}:${row.ordinal}:${row.heading}`;
            if (!wanted.has(row.documentId) || headingSeen.has(key)) continue;
            headingSeen.add(key);
            offer(row.documentId, { coverage: terms.filter(term => row.normalized.includes(term)).length, headingHit: true, ordinal: row.ordinal });
          }
        }
        const contentTerms = new Map<string, { documentId: number; ordinal: number; terms: Set<string> }>();
        for (const term of new Set(terms)) {
          for (const block of store.indexContentBlocks([term], representatives, trace)) {
            // A block whose heading holds any term is represented by its heading (offered above).
            if (block.heading && terms.some(item => normalize(block.heading!).includes(item))) continue;
            const key = `${block.documentId}:${block.ordinal}`;
            let entry = contentTerms.get(key);
            if (!entry) contentTerms.set(key, entry = { documentId: block.documentId, ordinal: block.ordinal, terms: new Set() });
            entry.terms.add(term);
          }
        }
        for (const entry of contentTerms.values()) {
          offer(entry.documentId, { coverage: terms.filter(term => entry.terms.has(term)).length, headingHit: false, ordinal: entry.ordinal });
        }
        for (const [id, candidate] of best) {
          ranks.set(id, { rank: 1, sourceKind: candidate.headingHit ? "heading" : "content", ordinal: candidate.ordinal });
        }
      }
    }
  }

  const blockKeys = [...ranks].filter(([, ranked]) => ranked.ordinal !== null).map(([id, ranked]) => [id, ranked.ordinal!] as const);
  const display = store.indexBlockDisplay(blockKeys);
  trace.setCount("documentsConsidered", fetched.size);
  const order = restrict ?? [...ranks.keys()];
  const results: RankedSearchResult[] = [];
  for (const id of order) {
    const ranked = ranks.get(id);
    const document = documents.get(id);
    if (!ranked || !document) continue;
    const block = ranked.ordinal === null ? undefined : display.get(`${id}:${ranked.ordinal}`);
    if (ranked.sourceKind === "filename") trace.increment("filenameOnlyFallbacks");
    trace.increment("documentsMatched");
    results.push({ result: { reference: documentReference(document.id, document.path), path: document.path, extension: document.extension,
      modifiedAtMs: document.modified_at_ms, heading: block?.heading ?? null, location: block?.location ?? null, snippet: "",
      rank: ranked.rank, reason: rankReason(mode, ranked.rank), filenameOnly: !block, status: document.status, snippetTruncated: false },
    documentId: document.id, ordinal: ranked.ordinal, sourceKind: ranked.sourceKind,
    passageOrdinals: ranked.passageOrdinals });
  }
  return results;
}

export type TotalMode = "fast" | "exact";
/** Fast mode verifies until this many documents match; beyond it the total is a lower bound (SPEC §52.3). */
export const FAST_TOTAL_LIMIT = 500;

/** Search results produced lazily in their final order (SPEC §52.2). */
export interface HitStream {
  /** Verify until at least `count` results are known or every candidate has been checked. */
  fill(count: number): void;
  readonly results: readonly RankedSearchResult[];
  readonly done: boolean;
}

/** An already complete result list (the pre-0.39 paths). */
class ArrayHitStream implements HitStream {
  readonly done = true;
  constructor(readonly results: RankedSearchResult[]) {}
  fill(): void {}
}


type HeadingRow = { ordinal: number; heading: string; normalized: string };

/**
 * SPEC §52.2: the same ranking as rankDocument() over the chunk store. Filename
 * and heading hits come from their small indexes; content hits are verified on
 * decompressed chunks in the final order, only as far as `fill()` asks.
 * `restrictIds` (search within results) replaces the candidate order and ignores
 * type／root scope, as the pre-0.39 path does.
 */
function chunkHitStream(store: IndexStore, query: string, terms: readonly string[], mode: SearchMode, field: SearchField,
  sort: SearchSort, types: readonly string[] | undefined, root: string | undefined, subtree: string | undefined,
  statuses: readonly DocumentStatus[] | undefined, restrict: HitStream | readonly number[] | undefined,
  trace: SearchTraceRecorder): HitStream {
  trace.addCandidateSource("chunk-index");
  if (restrict) trace.addCandidateSource("restricted-ids");
  const uniqueTerms = [...new Set(terms)];
  const verify = <T>(work: () => T): T => {
    const phase = trace.beginPhase("exactVerification");
    try { return work(); } finally { trace.endPhase(phase); }
  };

  // These caches contain only documents that the cursor has reached. Batch
  // posting maps are built on first content/heading verification, never while
  // opening the stream, so a filename page can finish without scanning them.
  const headingRows = new Map<string, Map<number, HeadingRow[]>>();
  const contentChunks = new Map<string, Map<number, number[]>>();
  const normalizedQueryLength = [...query].length;
  const canBatchPhrase = !restrict && mode === "phrase" && field !== "filename"
    && normalizedQueryLength >= 3 && !query.includes("\u0000");
  const longPhrase = canBatchPhrase && normalizedQueryLength >= 8;
  let phraseHeadingCandidates: Map<number, { ordinal: number; heading: string }[]> | undefined;
  let phraseHeadingCandidatesLoaded = false;
  const ensurePhraseHeadingCandidates = (): Map<number, { ordinal: number; heading: string }[]> | undefined => {
    if (!canBatchPhrase) return undefined;
    if (!phraseHeadingCandidatesLoaded) {
      phraseHeadingCandidatesLoaded = true;
      phraseHeadingCandidates = store.chunkHeadingCandidates(query, types, root, subtree, statuses, trace);
    }
    return phraseHeadingCandidates;
  };
  let phraseContentCandidates: Map<number, number[]> | undefined;
  let phraseContentCandidatesLoaded = false;
  const ensurePhraseContentCandidates = (): Map<number, number[]> | undefined => {
    if (!canBatchPhrase) return undefined;
    if (!phraseContentCandidatesLoaded) {
      phraseContentCandidatesLoaded = true;
      phraseContentCandidates = store.chunkCandidateChunks(query, types, root, subtree, statuses, trace);
    }
    return phraseContentCandidates;
  };
  let phraseDocumentHits: Map<number, number[]> | undefined;
  let phraseDocumentHitsLoaded = false;
  const ensurePhraseDocumentHits = (): Map<number, number[]> | undefined => {
    if (!longPhrase) return undefined;
    if (!phraseDocumentHitsLoaded) {
      phraseDocumentHitsLoaded = true;
      phraseDocumentHits = store.chunkPhraseDocumentHits(query, types, root, subtree, statuses, trace);
    }
    return phraseDocumentHits;
  };
  const headingRowsFor = (term: string, documentId: number): HeadingRow[] => {
    let byDocument = headingRows.get(term);
    if (!byDocument) headingRows.set(term, byDocument = new Map());
    const cached = byDocument.get(documentId);
    if (cached !== undefined) return cached;
    const batch = ensurePhraseHeadingCandidates();
    const candidates = batch
      ? batch.get(documentId) ?? []
      : store.chunkHeadingCandidatesForDocument(term, documentId, trace);
    const rows = candidates
      .map(row => ({ ...row, normalized: normalize(row.heading) }))
      .filter(row => row.normalized.includes(term));
    byDocument.set(documentId, rows);
    return rows;
  };
  const contentChunksFor = (term: string, documentId: number): number[] => {
    let byDocument = contentChunks.get(term);
    if (!byDocument) contentChunks.set(term, byDocument = new Map());
    const cached = byDocument.get(documentId);
    if (cached !== undefined) return cached;
    const batch = ensurePhraseContentCandidates();
    const chunks = batch
      ? batch.get(documentId) ?? []
      : store.chunkCandidatesForDocument(term, documentId, trace);
    byDocument.set(documentId, chunks);
    return chunks;
  };
  const phrasePassageOrdinals = (documentId: number): number[] => {
    const ordinals = new Set<number>(headingRowsFor(query, documentId).map(row => row.ordinal));
    const indexed = ensurePhraseDocumentHits();
    if (indexed) {
      for (const ordinal of indexed.get(documentId) ?? []) ordinals.add(ordinal);
    } else {
      for (const chunk of contentChunksFor(query, documentId)) {
        for (const ordinal of store.chunkTermHits(chunk, [query], false, trace).get(query) ?? []) ordinals.add(ordinal);
      }
    }
    return [...ordinals].sort((left, right) => left - right);
  };
  const headingAllFor = (documentId: number): number | undefined => {
    if (field === "filename") return undefined;
    let first: number | undefined;
    for (const row of headingRowsFor(uniqueTerms[0]!, documentId)) {
      if (!includesAll(row.normalized, terms)) continue;
      if (first === undefined || row.ordinal < first) first = row.ordinal;
    }
    return first;
  };
  const filenameRank = (document: StoredDocumentRow): number => {
    if (field === "content") return 0;
    const filename = normalize(document.filename);
    return filename === query ? 4 : includesAll(filename, terms) ? 3 : 0;
  };

  const rankOne = (document: StoredDocumentRow): IndexedRank | undefined => {
    const byFilename = filenameRank(document);
    if (byFilename) return { rank: byFilename, sourceKind: "filename", ordinal: null };
    if (field === "filename") return undefined;
    const id = Number(document.id);
    const heading = headingAllFor(id);
    if (heading !== undefined) {
      return mode === "phrase"
        ? { rank: 2, sourceKind: "heading", ordinal: heading, passageOrdinals: phrasePassageOrdinals(id) }
        : { rank: 2, sourceKind: "heading", ordinal: heading };
    }
    if (mode === "phrase") {
      const passageOrdinals = phrasePassageOrdinals(id);
      const first = passageOrdinals[0];
      return first === undefined ? undefined : { rank: 1, sourceKind: "content", ordinal: first, passageOrdinals };
    }
    // all-terms: every term not in the filename must occur in some heading or block.
    const chunkIds = [...new Set(uniqueTerms.flatMap(term => contentChunksFor(term, id)))];
    const presentByOrdinal = new Map<number, string[]>();
    for (const chunk of chunkIds) {
      for (const [term, ordinals] of store.chunkTermHits(chunk, uniqueTerms, false, trace)) {
        for (const ordinal of ordinals) {
          let list = presentByOrdinal.get(ordinal);
          if (!list) presentByOrdinal.set(ordinal, list = []);
          list.push(term);
        }
      }
    }
    const blocks = [...presentByOrdinal].map(([ordinal, present]) => ({ ordinal, present }));
    blocks.sort((a, b) => a.ordinal - b.ordinal);
    const filename = normalize(document.filename);
    const present = (term: string) => headingRowsFor(term, id).length > 0
      || blocks.some(block => block.present.includes(term));
    if (!terms.filter(term => field === "content" || !filename.includes(term)).every(present)) return undefined;
    const allTerms = blocks.find(block => block.present.length === uniqueTerms.length);
    if (allTerms) return { rank: 1, sourceKind: "content", ordinal: allTerms.ordinal };
    // Coverage representative: heading source when the heading holds any term,
    // otherwise block content; best coverage, then heading, then smallest ordinal.
    let best: { coverage: number; headingHit: boolean; ordinal: number } | undefined;
    const offer = (candidate: { coverage: number; headingHit: boolean; ordinal: number }) => {
      if (!best || candidate.coverage > best.coverage || (candidate.coverage === best.coverage
        && (Number(candidate.headingHit) > Number(best.headingHit)
          || (candidate.headingHit === best.headingHit && candidate.ordinal < best.ordinal)))) best = candidate;
    };
    const seen = new Set<string>();
    for (const term of uniqueTerms) {
      for (const row of headingRowsFor(term, id)) {
        const key = `${row.ordinal}:${row.heading}`;
        if (seen.has(key)) continue;
        seen.add(key);
        offer({ coverage: terms.filter(item => row.normalized.includes(item)).length, headingHit: true, ordinal: row.ordinal });
      }
    }
    for (const block of blocks) {
      // A block whose heading holds any term is represented by its heading (offered above).
      const blockHeading = store.blockDisplay(id, block.ordinal).heading;
      if (blockHeading && terms.some(item => normalize(blockHeading).includes(item))) continue;
      offer({ coverage: block.present.length, headingHit: false, ordinal: block.ordinal });
    }
    const chosen = best as { coverage: number; headingHit: boolean; ordinal: number } | undefined;
    return chosen ? { rank: 1, sourceKind: chosen.headingHit ? "heading" : "content", ordinal: chosen.ordinal } : undefined;
  };

  let nextDocument: () => StoredDocumentRow | undefined;
  let expectedRank: number | undefined;
  if (restrict) {
    const source = Array.isArray(restrict) ? new ArrayHitStream([]) : restrict as HitStream;
    const ids = Array.isArray(restrict) ? [...new Set(restrict as readonly number[])] : undefined;
    let position = 0;
    trace.setCount("documentsInScope", ids ? ids.length : source.results.length);
    nextDocument = () => {
      while (true) {
        const id = ids
          ? ids[position++]
          : (position >= source.results.length ? (source.fill(position + 256), undefined) : undefined);
        const resolvedId = ids ? id : source.results[position++]?.documentId;
        if (resolvedId === undefined) return undefined;
        const row = store.indexDocuments([resolvedId], undefined, undefined, undefined, trace)[0];
        if (!row || (statuses?.length && !statuses.includes(row.status))) continue;
        return row;
      }
    };
  } else {
    trace.setCount("documentsInScope", store.documentsInScope(types, root, subtree));
    type RelevancePhase = { phase: "filename" | "heading" | "possible"; rank: number };
    const pathOrder = store.chunkPathOrder();
    const phases: RelevancePhase[] = sort === "relevance"
      ? [
        ...(field !== "content" ? [{ phase: "filename" as const, rank: 4 }, { phase: "filename" as const, rank: 3 }] : []),
        ...(field !== "filename" ? [{ phase: "heading" as const, rank: 2 }, { phase: "possible" as const, rank: 1 }] : []),
      ]
      : [{ phase: "possible", rank: 0 }];
    let phaseIndex = 0;
    let candidates = store.chunkCandidateDocuments(uniqueTerms, mode === "all-terms", field, phases[0]!.phase,
      types, root, subtree, statuses, sort, trace, pathOrder);
    expectedRank = phases[0]!.rank || undefined;
    nextDocument = () => {
      while (true) {
        const next = candidates.next();
        if (!next.done) return next.value;
        phaseIndex++;
        if (phaseIndex >= phases.length) return undefined;
        const phase = phases[phaseIndex]!;
        candidates = store.chunkCandidateDocuments(uniqueTerms, mode === "all-terms", field, phase.phase,
          types, root, subtree, statuses, sort, trace, pathOrder);
        expectedRank = phase.rank || undefined;
      }
    };
  }
  trace.setCount("documentsConsidered", 0);

  const results: RankedSearchResult[] = [];
  let done = false;
  return {
    results,
    get done() { return done; },
    fill(count: number) {
      while (!done && results.length < count) {
        const document = nextDocument();
        if (!document) { done = true; break; }
        trace.increment("documentsConsidered");
        trace.increment("documentsExactVerified");
        const ranked = verify(() => rankOne(document));
        if (!ranked || (expectedRank !== undefined && ranked.rank !== expectedRank)) continue;
        const id = Number(document.id);
        const display = ranked.ordinal === null ? undefined : store.blockDisplay(id, ranked.ordinal);
        if (ranked.sourceKind === "filename") trace.increment("filenameOnlyFallbacks");
        trace.increment("documentsMatched");
        results.push({ result: { reference: documentReference(document.id, document.path), path: document.path, extension: document.extension,
          modifiedAtMs: document.modified_at_ms, heading: display?.heading ?? null, location: display?.location ?? null, snippet: "",
          rank: ranked.rank, reason: rankReason(mode, ranked.rank), filenameOnly: ranked.ordinal === null, status: document.status,
          snippetTruncated: false }, documentId: id, ordinal: ranked.ordinal, sourceKind: ranked.sourceKind,
        passageOrdinals: ranked.passageOrdinals });
      }
      trace.setTotalRelation(done ? "eq" : "gte");
    },
  };
}

export interface OpenHitsOptions {
  types?: readonly string[] | undefined;
  root?: string | undefined;
  subtree?: string | undefined;
  mode?: SearchMode;
  field?: SearchField;
  statuses?: readonly DocumentStatus[] | undefined;
  sort?: SearchSort;
  /** Search within results: the previous layer (or its document ids) gives the order. */
  within?: HitStream | readonly number[] | undefined;
  trace?: SearchTraceRecorder;
}

/**
 * Open a lazily verified result stream. On an index whose chunk store migration
 * has not finished, the pre-0.39 path computes the complete list (always exact).
 */
export function openHits(store: IndexStore, rawQuery: string, options: OpenHitsOptions = {}): HitStream {
  const mode = options.mode ?? "phrase";
  const field = options.field ?? "all";
  const sort = options.sort ?? "relevance";
  const recorder = options.trace ?? new SearchTraceRecorder(rawQuery, mode, field, sort);
  if (!store.chunkStoreReady()) {
    const within = options.within;
    const ids = within === undefined ? undefined : Array.isArray(within) ? within as readonly number[]
      : (() => { const stream = within as HitStream; stream.fill(Number.POSITIVE_INFINITY); return stream.results.map(item => item.documentId); })();
    return new ArrayHitStream(collectHits(store, rawQuery, options.types, options.root, mode, ids, options.subtree, field,
      options.statuses, sort, recorder));
  }
  store.prepareSearchCache();
  try {
    const normalizationStarted = performance.now();
    const { query, terms } = queryTerms(rawQuery, mode);
    recorder.addPhase("queryNormalization", performance.now() - normalizationStarted);
    recorder.setNormalizedQuery(query);
    const stream = chunkHitStream(store, query, terms, mode, field, sort, options.types, options.root, options.subtree,
      options.statuses, options.within, recorder);
    return {
      get results() { return stream.results; },
      get done() { return stream.done; },
      fill(count: number) {
        recorder.resume();
        try {
          stream.fill(count);
          recorder.setCount("results", stream.results.length);
          store.recordSearchTrace(recorder.snapshot(stream.results.length));
        } catch (error) {
          recorder.setError(searchTraceErrorCode(error));
          store.recordSearchTrace(recorder.snapshot(), true);
          throw error;
        } finally {
          recorder.pause();
        }
      },
    };
  } catch (error) {
    recorder.setError(searchTraceErrorCode(error));
    store.recordSearchTrace(recorder.snapshot(), true);
    recorder.pause();
    throw error;
  }
}

/** How far a result set verifies before reporting its total (SPEC §52.3). */
export function totalTarget(totalMode: TotalMode, needed = 0): number {
  return totalMode === "exact" ? Number.POSITIVE_INFINITY : Math.max(FAST_TOTAL_LIMIT, needed);
}

export function collectHits(store: IndexStore, rawQuery: string, types?: readonly string[], root?: string,
  mode: SearchMode = "phrase", restrictIds?: readonly number[], subtree?: string, field: SearchField = "all",
  statuses?: readonly DocumentStatus[], sort: SearchSort = "relevance", trace?: SearchTraceRecorder): RankedSearchResult[] {
  const recorder = trace ?? new SearchTraceRecorder(rawQuery, mode, field, sort);
  try {
    const normalizationStarted = performance.now();
    const { query, terms } = queryTerms(rawQuery, mode);
    recorder.addPhase("queryNormalization", performance.now() - normalizationStarted);
    recorder.setNormalizedQuery(query);
    let results: RankedSearchResult[];
    if (store.chunkStoreReady()) {
      const stream = chunkHitStream(store, query, terms, mode, field, sort, types, root, subtree, statuses, restrictIds, recorder);
      stream.fill(Number.POSITIVE_INFINITY);
      results = [...stream.results];
    } else if (store.blockIndexReady()) {
      results = indexedHits(store, query, terms, mode, field, types, root, subtree, statuses, restrictIds, recorder);
    } else {
      // Pre-0.38.0 index whose block migration has not finished (SPEC §50.2).
      results = [];
      const source = restrictIds
        ? store.streamCandidatesByIds(restrictIds, terms, mode === "all-terms", recorder)
        : store.streamCandidates(types, root, terms, mode === "all-terms", subtree, recorder);
      for (const { document, blocks, pruned } of source) {
        if (statuses?.length && !statuses.includes(document.status)) continue;
        if (pruned) continue;
        recorder.increment("documentsExactVerified");
        const verification = recorder.beginPhase("exactVerification");
        let ranked: RankedSearchResult | undefined;
        try {
          ranked = rankDocument(document, blocks, query, terms, mode, field, recorder);
        } finally {
          recorder.endPhase(verification);
        }
        if (ranked) {
          recorder.increment("documentsMatched");
          results.push(ranked);
        }
      }
    }
    const rankingStarted = performance.now();
    if (!restrictIds) {
      results.sort(sort === "filename"
        ? (a, b) => comparePath(a.result.path, b.result.path) || b.result.modifiedAtMs - a.result.modifiedAtMs
        : sort === "modified"
          ? (a, b) => b.result.modifiedAtMs - a.result.modifiedAtMs || comparePath(a.result.path, b.result.path)
          : (a, b) => b.result.rank - a.result.rank || b.result.modifiedAtMs - a.result.modifiedAtMs
            || comparePath(a.result.path, b.result.path));
    }
    recorder.addPhase("resultRanking", performance.now() - rankingStarted);
    recorder.setCount("results", results.length);
    store.recordSearchTrace(recorder.snapshot(results.length));
    return results;
  } catch (error) {
    recorder.setError(searchTraceErrorCode(error));
    store.recordSearchTrace(recorder.snapshot(), true);
    throw error;
  } finally {
    recorder.pause();
  }
}

function materializeHits(store: IndexStore, ranked: readonly RankedSearchResult[], rawQuery: string, mode: SearchMode,
  page: number, pageSize: number, condition?: string, trace?: SearchTraceRecorder, field: SearchField = "all"): SearchResultPage {
  trace?.resume();
  try {
    const { terms } = queryTerms(rawQuery, mode);
    if (!Number.isSafeInteger(page) || page <= 0) throw new Error("--page 必須是正整數。");
    if (!Number.isSafeInteger(pageSize) || pageSize <= 0) throw new Error("每頁筆數必須是正整數。");
    const pageCount = Math.max(1, Math.ceil(ranked.length / pageSize));
    if (ranked.length > 0 && page > pageCount) throw new Error(`頁碼超出範圍；共有 ${pageCount} 頁。`);
    const offset = (page - 1) * pageSize;
    const selected = ranked.slice(offset, offset + pageSize).map(({ result, documentId, ordinal, sourceKind, passageOrdinals }) => {
      const source = sourceKind === "filename" ? path.basename(result.path)
        : ordinal === null ? path.basename(result.path) : store.blockSource(documentId, ordinal, sourceKind, trace) ?? path.basename(result.path);
      const snippetStarted = performance.now();
      try {
        const snippetQuery = snippetTerm(source, terms);
        const snippet = makeSnippet(source, snippetQuery);
        let passageData: { passages: SearchPassage[]; omittedTerms: number };
        if (mode === "all-terms") {
          passageData = field === "filename"
            ? { passages: [], omittedTerms: Math.max(0, terms.length - MAX_PASSAGE_TERMS) }
            : allTermsPassages(store, result.path, terms, trace);
        } else if (field === "filename") {
          passageData = { passages: [], omittedTerms: 0 };
        } else {
          const primaryPassage: SearchPassage = {
            terms: [terms[0]!],
            heading: result.heading,
            location: result.location,
            snippet: snippet.text,
            snippetTruncated: snippet.truncated,
          };
          const matches = phrasePassageBlocks(store, documentId, result.path, terms, ordinal, source, passageOrdinals, trace);
          const extraPassages = matches
            .filter(item => item.block.ordinal !== ordinal)
            .slice(0, 1)
            .map(toSearchPassage);
          passageData = {
            passages: result.filenameOnly
              ? matches.slice(0, 2).map(toSearchPassage)
              : [primaryPassage, ...extraPassages],
            omittedTerms: 0,
          };
        }
        const materialized = {
          ...result,
          snippet: snippet.text,
          snippetTruncated: snippet.truncated,
          passages: passageData.passages,
          omittedTerms: passageData.omittedTerms,
        };
        return condition === undefined ? materialized : { ...materialized, condition };
      } finally {
        trace?.addPhase("snippet", performance.now() - snippetStarted);
      }
    });
    trace?.setCount("results", ranked.length);
    trace?.setCount("returnedResults", selected.length);
    if (trace) store.recordSearchTrace(trace.snapshot(ranked.length, selected.length), true);
    return { page, pageSize, total: ranked.length, pageCount,
      start: selected.length ? offset + 1 : 0, end: offset + selected.length, results: selected };
  } catch (error) {
    if (trace) {
      trace.setError(searchTraceErrorCode(error));
      store.recordSearchTrace(trace.snapshot(ranked.length), true);
    }
    throw error;
  } finally {
    trace?.pause();
  }
}

export function createSearchResultSet(store: IndexStore, rawQuery: string, types?: readonly string[], root?: string,
  mode: SearchMode = "phrase", subtree?: string, field: SearchField = "all", statuses?: readonly DocumentStatus[],
  sort: SearchSort = "relevance", totalMode: TotalMode = "fast"): SearchResultSet {
  const trace = new SearchTraceRecorder(rawQuery, mode, field, sort);
  const stream = openHits(store, rawQuery, { types, root, subtree, mode, field, statuses, sort, trace });
  stream.fill(totalTarget(totalMode));
  const dataVersion = store.dataVersion();
  let returnedResults = 0;
  return {
    get total() { return stream.results.length; },
    get totalRelation() { return stream.done ? "eq" as const : "gte" as const; },
    dataVersion,
    get trace() { return trace.snapshot(stream.results.length, returnedResults); },
    page(page, pageSize) {
      if (Number.isSafeInteger(page) && page > 0 && Number.isSafeInteger(pageSize) && pageSize > 0) stream.fill(page * pageSize);
      const resultPage = materializeHits(store, stream.results, rawQuery, mode, page, pageSize, undefined, trace, field);
      returnedResults = resultPage.results.length;
      return resultPage;
    },
  };
}

export { materializeHits };
export type { RankedSearchResult };

export function search(store: IndexStore, rawQuery: string, limit = 20, types?: readonly string[], root?: string,
  mode: SearchMode = "phrase", subtree?: string): SearchResult[] {
  if (!Number.isSafeInteger(limit) || limit <= 0) throw new Error("--limit 必須是正整數。");
  return createSearchResultSet(store, rawQuery, types, root, mode, subtree).page(1, limit).results;
}

export interface PassageHit {
  reason: string;
  heading: string | null;
  location: string | null;
  snippet: string;
  snippetTruncated: boolean;
}

/** Collect up to `limit` matching text blocks for one document path (title hits before content). */
export function matchingPassages(store: IndexStore, rawQuery: string, filePath: string, limit = 3,
  mode: SearchMode = "phrase"): PassageHit[] {
  const trace = new SearchTraceRecorder(rawQuery, mode, "all", "relevance");
  const finish = (results: PassageHit[]): PassageHit[] => {
    trace.setCount("results", results.length);
    trace.setCount("returnedResults", results.length);
    trace.pause();
    store.recordSearchTrace(trace.snapshot(results.length, results.length), true);
    return results;
  };
  try {
    const normalizationStarted = performance.now();
    const { query, terms } = queryTerms(rawQuery, mode);
    trace.addPhase("queryNormalization", performance.now() - normalizationStarted);
    trace.setNormalizedQuery(query);
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new Error("--passages 必須是正整數。");
    trace.addCandidateSource("restricted-ids");
    const candidate = store.candidateByPath(filePath, trace);
    if (!candidate) return finish([]);
    trace.setCount("documentsInScope", 1);
    const verificationStarted = performance.now();
    if (mode === "all-terms") {
      const searchable = [normalize(candidate.document.filename), ...candidate.blocks.flatMap(block =>
        [normalize(block.heading ?? ""), normalize(block.content)])];
      if (!terms.every(term => searchable.some(value => value.includes(term)))) {
        trace.addPhase("exactVerification", performance.now() - verificationStarted);
        trace.increment("documentsExactVerified");
        return finish([]);
      }
    }
    type Ranked = { rank: number; ordinal: number; heading: string | null; location: string | null; source: string; reason: string; matched: string[] };
    const ranked: Ranked[] = [];
    for (const block of candidate.blocks) {
      const headingTerms = block.heading ? terms.filter(term => normalize(block.heading!).includes(term)) : [];
      const contentTerms = terms.filter(term => normalize(block.content).includes(term));
      if (headingTerms.length) {
        ranked.push({ rank: 2, ordinal: block.ordinal, heading: block.heading, location: block.location_value, source: block.heading!,
          reason: mode === "all-terms" ? `標題（多詞命中 ${headingTerms.length}/${terms.length}）` : "標題", matched: headingTerms });
      } else if (contentTerms.length) {
        ranked.push({ rank: 1, ordinal: block.ordinal, heading: block.heading, location: block.location_value, source: block.content,
          reason: mode === "all-terms" ? `內容（多詞命中 ${contentTerms.length}/${terms.length}）` : "內容", matched: contentTerms });
      }
    }
    trace.addPhase("exactVerification", performance.now() - verificationStarted);
    trace.increment("documentsExactVerified");
    if (ranked.length) trace.increment("documentsMatched");
    const rankingStarted = performance.now();
    const selected: Ranked[] = [];
    const remaining = [...ranked];
    const covered = new Set<string>();
    while (selected.length < limit && remaining.length) {
      remaining.sort((a, b) => b.matched.filter(term => !covered.has(term)).length - a.matched.filter(term => !covered.has(term)).length
        || b.matched.length - a.matched.length || b.rank - a.rank || a.ordinal - b.ordinal);
      const item = remaining.shift()!;
      selected.push(item);
      for (const term of item.matched) covered.add(term);
    }
    trace.addPhase("resultRanking", performance.now() - rankingStarted);
    const snippetStarted = performance.now();
    const results = selected.map(item => {
      const snippet = makeSnippet(item.source, snippetTerm(item.source, item.matched));
      return { reason: item.reason, heading: item.heading, location: item.location, snippet: snippet.text, snippetTruncated: snippet.truncated };
    });
    trace.addPhase("snippet", performance.now() - snippetStarted);
    return finish(results);
  } catch (error) {
    trace.setError(searchTraceErrorCode(error));
    store.recordSearchTrace(trace.snapshot(), true);
    throw error;
  } finally {
    trace.pause();
  }
}
