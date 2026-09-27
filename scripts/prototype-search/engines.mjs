// Query engines for the five prototype variants. Phrase mode, field=all,
// sort=relevance, no type/root filter (the configuration the research traces use).
// Every engine returns the complete ranked list plus snippets for requested pages.
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import {
  biToken, distDir, ftsString, newMetrics, normalize, productModules, relevanceOrder, snapshotPath, trigrams,
  uniToken, variantPaths,
} from "./common.mjs";
import { brotliDecompressSync } from "node:zlib";

export const PAGE_SIZE = 20;
const hasNul = value => value.includes("\u0000");

function pagesFor(total, pages) {
  const last = Math.max(1, Math.ceil(total / PAGE_SIZE));
  return [...new Set(pages.map(page => page === "last" ? last : page))].filter(page => page <= last);
}

// ---------------------------------------------------------------------------
// A: the current product build (dist/src), unchanged.
export async function createEngineA() {
  const { IndexStore, collectHits, materializeHits } = await productModules();
  const { SearchTraceRecorder } = await import(pathToFileURL(path.join(distDir, "search-trace.js")).href);
  class PrototypeStore extends IndexStore {
    recordSearchTrace(trace) { super.recordSearchTrace(trace, false); }
  }
  const store = new PrototypeStore(snapshotPath, { readOnly: true });
  return {
    name: "A",
    close: () => store.close(),
    search(raw, { pages = [1] } = {}) {
      const metrics = newMetrics();
      const started = performance.now();
      const recorder = new SearchTraceRecorder(raw, "phrase", "all", "relevance");
      const ranked = collectHits(store, raw, undefined, undefined, "phrase", undefined, undefined, "all", undefined,
        "relevance", recorder);
      const rankedAt = performance.now();
      const snippets = {};
      for (const page of pagesFor(ranked.length, pages)) {
        if (!ranked.length) break;
        snippets[page] = materializeHits(store, ranked, raw, "phrase", page, PAGE_SIZE, undefined, recorder)
          .results.map(result => result.snippet);
      }
      const finished = performance.now();
      const trace = recorder.snapshot(ranked.length);
      const reads = trace.diagnostics.payloadReads;
      Object.assign(metrics, {
        postingMs: trace.phasesMs.postingsLookup,
        candidateDocs: trace.counts.documentsConsidered,
        verifiedDocs: trace.counts.documentsExactVerified,
        falsePositiveDocs: trace.counts.documentsExactVerified - trace.counts.documentsMatched,
        candidatePayloads: trace.counts.payloadsAfterPruning,
        payloadReads: reads.ranking.payloadsRead,
        compressedBytes: reads.ranking.compressedBytes,
        decompressedBytes: reads.ranking.decompressedBytes,
        decompressMs: trace.phasesMs.payloadDecompression,
        payloadLookupMs: trace.phasesMs.payloadLookup,
        verificationMs: trace.phasesMs.exactVerification,
        rankingMs: rankedAt - started,
        snippetMs: finished - rankedAt,
        snippetPayloadReads: reads.snippet.payloadsRead,
        totalMs: finished - started,
        results: ranked.length,
      });
      return {
        ranked: ranked.map(item => ({ documentId: item.documentId, rank: item.result.rank, sourceKind: item.sourceKind,
          ordinal: item.ordinal, heading: item.result.heading, location: item.result.location,
          modifiedAtMs: item.result.modifiedAtMs, path: item.result.path })),
        snippets, metrics,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Shared machinery for B / C1 / C2 / D.
class Base {
  constructor(name, attachments, makeSnippet) {
    this.name = name;
    this.makeSnippet = makeSnippet;
    this.db = new DatabaseSync(snapshotPath, { readOnly: true });
    for (const [schema, file] of Object.entries(attachments)) this.db.exec(`ATTACH '${file.replaceAll("'", "''")}' AS ${schema}`);
    const db = this.db;
    this.sql = {
      documents: db.prepare(`SELECT id, path, filename, modified_at_ms FROM documents WHERE id IN (SELECT value FROM json_each(?))`),
      blockRows: db.prepare(`SELECT b.document_id, b.ordinal, b.heading, b.location_value FROM json_each(?) AS j
        JOIN blocks AS b ON b.document_id = j.value ->> 0 AND b.ordinal = j.value ->> 1`),
      blockPayloads: db.prepare(`SELECT payload_ordinal FROM document_payload_blocks INDEXED BY document_payload_blocks_document_block
        WHERE document_id = ? AND block_id = ? ORDER BY payload_ordinal`),
      payload: db.prepare("SELECT payload FROM document_payloads WHERE document_id = ? AND ordinal = ?"),
      blockId: db.prepare("SELECT id FROM blocks WHERE document_id = ? AND ordinal = ?"),
      headingMap: db.prepare("SELECT id, document_id, min_ordinal, heading FROM f.heading_map WHERE id IN (SELECT value FROM json_each(?))"),
    };
    this.statements = new Map();
  }

  close() { this.db.close(); }

  prepared(sql) {
    let statement = this.statements.get(sql);
    if (!statement) { statement = this.db.prepare(sql); this.statements.set(sql, statement); }
    return statement;
  }

  /** Rowids from one FTS table: n=1 unigram token, n=2 bigram token, n>=3 trigram AND (detail=none tables). */
  shortOrTrigramRowids(prefix, schema, query, metrics) {
    const characters = [...query];
    let table; let match;
    if (characters.length === 1) { table = `${prefix}_uni`; match = ftsString(uniToken(characters[0])); }
    else if (characters.length === 2) { table = `${prefix}_bi`; match = ftsString(biToken(characters[0], characters[1])); }
    // SQLite ends an FTS5 query string at NUL, so a trigram containing NUL cannot be
    // expressed; the hex unigram tokens can (a superset, callers verify).
    else if (hasNul(query)) { table = `${prefix}_uni`; match = [...new Set(characters.map(uniToken))].map(ftsString).join(" AND "); }
    else { table = `${prefix}_tri`; match = [...new Set(trigrams(query))].map(ftsString).join(" AND "); }
    const started = performance.now();
    const rows = this.prepared(`SELECT rowid FROM ${schema}.${table} WHERE ${table} MATCH ?`).all(match);
    metrics.postingMs += performance.now() - started;
    metrics.postingRows += rows.length;
    return rows.map(row => Number(row.rowid));
  }

  filenameHits(query, metrics) {
    const ids = this.shortOrTrigramRowids("fname", "f", query, metrics);
    const started = performance.now();
    const hits = new Map();
    const documents = new Map();
    for (const row of this.sql.documents.all(JSON.stringify(ids))) {
      const filename = normalize(row.filename);
      documents.set(Number(row.id), row);
      if (filename === query) hits.set(Number(row.id), 4);
      else if (filename.includes(query)) hits.set(Number(row.id), 3);
    }
    metrics.verificationMs += performance.now() - started;
    return { hits, documents };
  }

  /** document id -> smallest ordinal whose heading contains the query (heading text is plain, verification is cheap). */
  headingHits(query, excluded, metrics) {
    const ids = this.shortOrTrigramRowids("head", "f", query, metrics);
    const started = performance.now();
    const hits = new Map();
    for (const row of this.sql.headingMap.all(JSON.stringify(ids))) {
      const documentId = Number(row.document_id);
      if (excluded.has(documentId) || !normalize(row.heading).includes(query)) continue;
      const ordinal = Number(row.min_ordinal);
      if (!hits.has(documentId) || ordinal < hits.get(documentId)) hits.set(documentId, ordinal);
    }
    metrics.verificationMs += performance.now() - started;
    return hits;
  }

  /** Complete block text, decoding each owning payload once per query (cache keyed by document/payload). */
  blockContent(documentId, blockId, cache, metrics, snippet = false) {
    let text = "";
    for (const { payload_ordinal: ordinal } of this.sql.blockPayloads.all(documentId, blockId)) {
      const key = `${documentId}:${ordinal}`;
      let decoded = cache.get(key);
      if (!decoded) {
        const started = performance.now();
        const blob = this.sql.payload.get(documentId, ordinal).payload;
        const raw = brotliDecompressSync(blob);
        decoded = new Map();
        for (const [id, fragment] of JSON.parse(raw.toString("utf8"))) decoded.set(id, (decoded.get(id) ?? "") + fragment);
        cache.set(key, decoded);
        metrics.decompressMs += performance.now() - started;
        if (snippet) metrics.snippetPayloadReads++;
        else { metrics.payloadReads++; metrics.compressedBytes += blob.byteLength; metrics.decompressedBytes += raw.byteLength; }
      }
      text += decoded.get(blockId) ?? "";
    }
    return text;
  }

  /** C1/D verification: candidates are sorted by ordinal; the first one that really contains the query wins. */
  verifySequential(query, candidatesByDocument, excluded, metrics) {
    const started = performance.now();
    const hits = new Map();
    for (const [documentId, blocks] of candidatesByDocument) {
      if (excluded.has(documentId)) continue;
      metrics.verifiedDocs++;
      const cache = new Map();
      let found;
      for (const block of blocks) {
        metrics.verifiedBlocks++;
        if (normalize(this.blockContent(documentId, block.id, cache, metrics)).includes(query)) { found = block; break; }
        metrics.falsePositiveBlocks++;
      }
      if (found) hits.set(documentId, { ordinal: found.ordinal });
      else metrics.falsePositiveDocs++;
    }
    metrics.verificationMs += performance.now() - started;
    return hits;
  }

  /** Group block-level candidate rowids (block ids) per document in ordinal order. */
  groupBlocks(blockIds, metrics) {
    const started = performance.now();
    const rows = this.prepared(`SELECT b.id, b.document_id, b.ordinal FROM json_each(?) AS j JOIN blocks AS b ON b.id = j.value
      ORDER BY b.document_id, b.ordinal`).all(JSON.stringify(blockIds));
    const grouped = new Map();
    for (const row of rows) {
      const documentId = Number(row.document_id);
      let list = grouped.get(documentId);
      if (!list) grouped.set(documentId, list = []);
      list.push({ id: Number(row.id), ordinal: Number(row.ordinal) });
    }
    metrics.candidateBlocks += rows.length;
    metrics.candidateDocs += grouped.size;
    metrics.postingMs += performance.now() - started;
    return grouped;
  }

  /** Exact block-level postings (no verification): document -> first ordinal. */
  firstBlockPerDocument(table, schema, match, metrics) {
    const started = performance.now();
    const rows = this.prepared(`SELECT b.document_id, min(b.ordinal) AS ordinal, count(*) AS blocks
      FROM ${schema}.${table} AS t JOIN blocks AS b ON b.id = t.rowid WHERE ${table} MATCH ? GROUP BY b.document_id`).all(match);
    metrics.postingMs += performance.now() - started;
    const hits = new Map();
    let blocks = 0;
    for (const row of rows) {
      blocks += Number(row.blocks);
      hits.set(Number(row.document_id), { ordinal: Number(row.ordinal) });
    }
    metrics.candidateBlocks += blocks;
    metrics.postingRows += blocks;
    metrics.candidateDocs += hits.size;
    return hits;
  }

  /** Assemble, sort and materialise the requested pages, mirroring collectHits()/materializeHits(). */
  finish(query, { filename, heading, content }, pages, metrics, started) {
    const rankingStarted = performance.now();
    const results = [];
    const missing = [];
    for (const [documentId, rank] of filename.hits) results.push({ documentId, rank, sourceKind: "filename", ordinal: null });
    for (const [documentId, ordinal] of heading) results.push({ documentId, rank: 2, sourceKind: "heading", ordinal });
    for (const [documentId, hit] of content) {
      if (filename.hits.has(documentId) || heading.has(documentId)) continue;
      results.push({ documentId, rank: 1, sourceKind: "content", ordinal: hit.ordinal });
    }
    for (const result of results) if (!filename.documents.has(result.documentId)) missing.push(result.documentId);
    for (const row of missing.length ? this.sql.documents.all(JSON.stringify(missing)) : []) filename.documents.set(Number(row.id), row);
    const blockKeys = results.filter(result => result.ordinal !== null).map(result => [result.documentId, result.ordinal]);
    const blockInfo = new Map();
    for (let start = 0; start < blockKeys.length; start += 100_000) {
      for (const row of this.sql.blockRows.all(JSON.stringify(blockKeys.slice(start, start + 100_000)))) {
        blockInfo.set(`${row.document_id}:${row.ordinal}`, row);
      }
    }
    for (const result of results) {
      const document = filename.documents.get(result.documentId);
      const block = result.ordinal === null ? undefined : blockInfo.get(`${result.documentId}:${result.ordinal}`);
      result.path = document.path;
      result.modifiedAtMs = document.modified_at_ms;
      result.heading = block?.heading ?? null;
      result.location = block?.location_value ?? null;
    }
    results.sort(relevanceOrder);
    const rankedAt = performance.now();
    metrics.rankingMs = rankedAt - rankingStarted;
    const snippets = {};
    for (const page of pagesFor(results.length, pages)) {
      if (!results.length) break;
      snippets[page] = results.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE).map(result => {
        let source;
        if (result.sourceKind === "filename") source = path.basename(result.path);
        else if (result.sourceKind === "heading") source = result.heading;
        else {
          const id = Number(this.sql.blockId.get(result.documentId, result.ordinal).id);
          source = this.blockContent(result.documentId, id, new Map(), metrics, true);
        }
        try { return this.makeSnippet(source, query).text; } catch (error) { return `SNIPPET_ERROR:${error.message}`; }
      });
    }
    const finished = performance.now();
    metrics.snippetMs = finished - rankedAt;
    metrics.totalMs = finished - started;
    metrics.results = results.length;
    return { ranked: results.map(({ documentId, rank, sourceKind, ordinal, heading, location, modifiedAtMs, path: filePath }) =>
      ({ documentId, rank, sourceKind, ordinal, heading, location, modifiedAtMs, path: filePath })), snippets, metrics };
  }
}

// ---------------------------------------------------------------------------
// B: payload-level detail=none postings; verification still reads owning blocks.
class EngineB extends Base {
  constructor(makeSnippet) {
    super("B", { f: variantPaths.fields, v: variantPaths.B }, makeSnippet);
    // Row directory (~30K rows) is cached once per process, as the product would.
    this.rows = new Map();
    this.byKey = new Map();
    for (const row of this.db.prepare("SELECT id, document_id, payload_ordinal, kind FROM v.pay_rows").all()) {
      const info = { id: Number(row.id), documentId: Number(row.document_id), ordinal: Number(row.payload_ordinal), kind: Number(row.kind) };
      this.rows.set(info.id, info);
      this.byKey.set(`${info.documentId}:${info.ordinal}:${info.kind}`, info.id);
    }
    this.blocksOfPayloads = this.db.prepare(`SELECT DISTINCT m.block_id FROM json_each(?) AS j
      CROSS JOIN document_payload_blocks AS m WHERE m.document_id = ? AND m.payload_ordinal = j.value`);
    this.blockMeta = this.db.prepare(`SELECT id, ordinal, heading FROM blocks WHERE id IN (SELECT value FROM json_each(?)) ORDER BY ordinal`);
  }

  search(raw, { pages = [1] } = {}) {
    const metrics = newMetrics();
    const started = performance.now();
    const query = normalize(raw.trim());
    const filename = this.filenameHits(query, metrics);
    const characters = [...query];
    const unigrams = characters.length < 3 || hasNul(query);
    const grams = unigrams ? [...new Set(characters.map(uniToken))] : [...new Set(trigrams(query))];
    const table = unigrams ? "pay_uni" : "pay_tri";
    let postingStarted = performance.now();
    const sets = grams.map(gram => new Set(this.prepared(`SELECT rowid FROM v.${table} WHERE ${table} MATCH ?`).all(ftsString(gram))
      .map(row => Number(row.rowid))));
    for (const set of sets) metrics.postingRows += set.size;
    sets.sort((a, b) => a.size - b.size);
    const selected = new Map();
    const select = (documentId, ordinal) => {
      let set = selected.get(documentId);
      if (!set) selected.set(documentId, set = new Set());
      set.add(ordinal);
    };
    for (const id of sets[0] ?? []) {
      const info = this.rows.get(id);
      if (info.kind === 0 && sets.every(set => set.has(id))) select(info.documentId, info.ordinal);
    }
    // A phrase can straddle payload i -> i+1 inside one block: accept the pair
    // when every gram is in row i, row i+1 or their boundary row.
    for (const info of this.rows.values()) {
      if (info.kind !== 1) continue;
      const left = this.byKey.get(`${info.documentId}:${info.ordinal}:0`);
      const right = this.byKey.get(`${info.documentId}:${info.ordinal + 1}:0`);
      if (sets.every(set => set.has(info.id) || set.has(left) || set.has(right))) {
        select(info.documentId, info.ordinal); select(info.documentId, info.ordinal + 1);
      }
    }
    metrics.postingMs += performance.now() - postingStarted;
    metrics.candidateDocs = selected.size;
    const verificationStarted = performance.now();
    const content = new Map();
    const headingHits = new Map();
    for (const [documentId, ordinals] of selected) {
      if (filename.hits.has(documentId)) continue;
      metrics.candidatePayloads += ordinals.size;
      metrics.verifiedDocs++;
      const blockIds = this.blocksOfPayloads.all(JSON.stringify([...ordinals]), documentId).map(row => Number(row.block_id));
      const blocks = this.blockMeta.all(JSON.stringify(blockIds));
      const cache = new Map();
      let headingBlock; let contentBlock;
      for (const block of blocks) {
        metrics.verifiedBlocks++;
        if (!headingBlock && block.heading && normalize(block.heading).includes(query)) headingBlock = block;
        if (!contentBlock && normalize(this.blockContent(documentId, Number(block.id), cache, metrics)).includes(query)) contentBlock = block;
      }
      if (headingBlock) headingHits.set(documentId, Number(headingBlock.ordinal));
      else if (contentBlock) content.set(documentId, { ordinal: Number(contentBlock.ordinal) });
      else metrics.falsePositiveDocs++;
    }
    metrics.verificationMs += performance.now() - verificationStarted;
    return this.finish(query, { filename, heading: headingHits, content }, pages, metrics, started);
  }
}

// ---------------------------------------------------------------------------
// C1: block-level detail=none. 1/2 chars are exact tokens; >=3 verifies candidates in ordinal order.
class EngineC1 extends Base {
  constructor(makeSnippet, name = "C1", attachments = { f: variantPaths.fields, v: variantPaths.C1 }) {
    super(name, attachments, makeSnippet);
  }

  shortContent(query, metrics) {
    const characters = [...query];
    return characters.length === 1
      ? this.firstBlockPerDocument("content_uni", "v", ftsString(uniToken(characters[0])), metrics)
      : this.firstBlockPerDocument("content_bi", "v", ftsString(biToken(characters[0], characters[1])), metrics);
  }

  search(raw, { pages = [1] } = {}) {
    const metrics = newMetrics();
    const started = performance.now();
    const query = normalize(raw.trim());
    const filename = this.filenameHits(query, metrics);
    const heading = this.headingHits(query, new Set(filename.hits.keys()), metrics);
    const excluded = new Set([...filename.hits.keys(), ...heading.keys()]);
    let content;
    if ([...query].length < 3) content = this.shortContent(query, metrics);
    else {
      const ids = this.shortOrTrigramRowids("content", "v", query, metrics);
      content = this.verifySequential(query, this.groupBlocks(ids, metrics), excluded, metrics);
    }
    return this.finish(query, { filename, heading, content }, pages, metrics, started);
  }
}

// ---------------------------------------------------------------------------
// C2: block-level detail=full. The phrase query itself proves contiguity; no verification.
class EngineC2 extends Base {
  constructor(makeSnippet) {
    super("C2", { f: variantPaths.fields, v: variantPaths.C2 }, makeSnippet);
  }

  search(raw, { pages = [1] } = {}) {
    const metrics = newMetrics();
    const started = performance.now();
    const query = normalize(raw.trim());
    const filename = this.filenameHits(query, metrics);
    const heading = this.headingHits(query, new Set(filename.hits.keys()), metrics);
    const characters = [...query];
    // A unigram phrase is equally exact and survives NUL (see shortOrTrigramRowids).
    const content = characters.length < 3 || hasNul(query)
      ? this.firstBlockPerDocument("content_uni_full", "v", ftsString(characters.map(uniToken).join(" ")), metrics)
      : this.firstBlockPerDocument("content_tri_full", "v", ftsString(query), metrics);
    return this.finish(query, { filename, heading, content }, pages, metrics, started);
  }
}

// ---------------------------------------------------------------------------
// D: 1/2 chars -> C1 tokens; >=3 -> two rarest trigrams from fts5vocab on the
// detail=full table, distance check on instance offsets, verify unless covered.
class EngineD extends EngineC1 {
  constructor(makeSnippet) {
    super(makeSnippet, "D", { f: variantPaths.fields, v: variantPaths.C1, w: variantPaths.C2 });
    this.db.exec(`CREATE VIRTUAL TABLE temp.d_row USING fts5vocab(w, content_tri_full, row);
      CREATE VIRTUAL TABLE temp.d_inst USING fts5vocab(w, content_tri_full, instance);`);
    this.frequency = this.db.prepare("SELECT doc FROM temp.d_row WHERE term = ?");
    this.instances = this.db.prepare("SELECT doc, offset FROM temp.d_inst WHERE term = ?");
  }

  search(raw, { pages = [1] } = {}) {
    const metrics = newMetrics();
    const started = performance.now();
    const query = normalize(raw.trim());
    const filename = this.filenameHits(query, metrics);
    const heading = this.headingHits(query, new Set(filename.hits.keys()), metrics);
    const excluded = new Set([...filename.hits.keys(), ...heading.keys()]);
    const characters = [...query];
    let content;
    if (characters.length < 3) content = this.shortContent(query, metrics);
    else if (hasNul(query)) {
      content = this.verifySequential(query, this.groupBlocks(this.shortOrTrigramRowids("content", "v", query, metrics), metrics), excluded, metrics);
    } else {
      const postingStarted = performance.now();
      const grams = trigrams(query);
      const frequency = new Map();
      for (const gram of new Set(grams)) frequency.set(gram, Number(this.frequency.get(gram)?.doc ?? 0));
      let first; let second;
      if ([...frequency.values()].some(count => count === 0)) first = undefined;
      else if (characters.length < 6) { first = 0; second = grams.length - 1; }
      else {
        const order = grams.map((gram, position) => ({ position, count: frequency.get(gram) })).sort((a, b) => a.count - b.count || a.position - b.position);
        first = order[0].position;
        // Prefer the rarest non-overlapping partner; a middle rarest gram may have none, then take the farthest.
        second = (order.find(item => Math.abs(item.position - first) >= 3)
          ?? order.filter(item => item.position !== first)
            .sort((a, b) => Math.abs(b.position - first) - Math.abs(a.position - first) || a.count - b.count)[0]).position;
      }
      let candidates = [];
      let proven = false;
      if (first !== undefined) {
        if (first > second) [first, second] = [second, first];
        proven = first === 0 && second <= 3 && second + 3 >= characters.length;
        const left = new Map();
        for (const row of this.instances.all(grams[first])) {
          const doc = Number(row.doc);
          let set = left.get(doc);
          if (!set) left.set(doc, set = new Set());
          set.add(Number(row.offset));
        }
        metrics.postingRows += [...left.values()].reduce((sum, set) => sum + set.size, 0);
        const distance = second - first;
        const matched = new Set();
        const rightRows = second === first ? [] : this.instances.all(grams[second]);
        metrics.postingRows += rightRows.length;
        if (second === first) for (const doc of left.keys()) matched.add(doc);
        for (const row of rightRows) {
          const doc = Number(row.doc);
          if (left.get(doc)?.has(Number(row.offset) - distance)) matched.add(doc);
        }
        candidates = [...matched];
      }
      metrics.postingMs += performance.now() - postingStarted;
      const grouped = this.groupBlocks(candidates, metrics);
      if (proven) {
        content = new Map();
        for (const [documentId, blocks] of grouped) content.set(documentId, { ordinal: blocks[0].ordinal });
      } else content = this.verifySequential(query, grouped, excluded, metrics);
    }
    return this.finish(query, { filename, heading, content }, pages, metrics, started);
  }
}

export async function createEngine(name) {
  if (name === "A") return createEngineA();
  const { makeSnippet } = await productModules();
  return new ({ B: EngineB, C1: EngineC1, C2: EngineC2, D: EngineD })[name](makeSnippet);
}
