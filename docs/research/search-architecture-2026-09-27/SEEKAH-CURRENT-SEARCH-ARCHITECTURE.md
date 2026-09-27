# Seekah 目前搜尋架構（由程式碼還原）

日期：2026-09-27。性質：研究文件，只描述現況，不提出方案。所有敘述均來自程式碼與既有量測，不依舊 SPEC 推測。

## 0. 範圍與版本區分

| 代號 | 來源 | 識別 |
|---|---|---|
| **GitHub baseline** | `github.com/ododuuu/seekah` `main` | commit `0ee292a`（2026-09-25 06:22 +0800），package 0.36.2 |
| **Current local implementation** | `C:\Users\mains\seekah` | `src/store.ts` mtime 2026-09-27 04:56（+0800），package 仍標 0.36.2，實際為 0.37.0 進行中 |

兩者在搜尋路徑上的差異（本文其餘段落預設描述 **local**，與 baseline 不同處另外標示）：

| 項目 | GitHub baseline | Current local |
|---|---|---|
| 候選來源 | 無 postings；`streamCandidates()` 逐一走完 scope 內**全部** documents，每份讀 `document_blooms` | FTS5 `search_unigrams`／`search_trigrams`（contentless、`detail=none`、rowid = `documents.id`）先取文件 ID，再進 Bloom |
| Bloom 內容 | `payload_bloom_version=1`：只有 trigram | `payload_bloom_version=2`：bigram + trigram（二字查詢可用 document Bloom） |
| payload metadata 讀取 | 每個 stream 讀整份文件的 `blocks` 列，再查 mapping | 2026-09-27 已實作 selected-block CTE（Q1／Q2），只取被選 payload 的 owning blocks |
| 搜尋欄位／排序 | 無 `field`／`sort` 參數 | `field = all｜filename｜content`、`sort = relevance｜filename｜modified` |
| 診斷 | 無 | `SearchTraceRecorder` schema 3（inclusive `phasesMs`／exclusive `phaseSelfMs`、payload SQL 子計時、trace.log JSONL） |

真實大型 store 的結構數字（取自 `docs/metadata-mapping-optimization-2026-09-27-comparison.json` 的 database identity）：

| 項目 | 數量 |
|---|---:|
| `documents` | 235,463 |
| `blocks` | 5,313,248（平均 22.6 blocks／文件） |
| `document_payloads` | 27,468 |
| `document_payload_blocks` | 5,316,529 |
| `document_payload_blooms` | 27,468 |
| 跨多個 payload 的 blocks | 786（最大一個 block 跨 182 個 payload；另有 5 個跨 ≥100 個） |
| `index.db` 大小 | 1,466,884,096 bytes（約 1.37 GiB） |

---

## A. Indexing pipeline

呼叫順序：`sync()`（`src/sync.ts`，完整校正）或 `applyPathChange`／local update（`src/local-update.ts`，日常增量）→ `parseDocument()`（`src/parser.ts`）→ `IndexStore.upsert()` 或 `touchMetadata()`（`src/store.ts`）。Workbench 手動索引改在 `worker_threads` 內執行（`src/index-worker.ts`）。

| # | 步驟 | 檔案／函式 | 資料表 | Key／ID | 粒度 | 持久？ | 壓縮？ |
|---|---|---|---|---|---|---|---|
| 1 | 列舉、stat、分類是否需要重解析 | `sync.ts` → `classifyReprocess()`（`model.ts`） | — | path | 檔案 | 暫時 | — |
| 2 | 讀檔並依副檔名選 parser；>100 MB 標 `too_large` | `parser.ts: parseDocument()` | — | path | 檔案 | 暫時 | — |
| 3 | parser 產生 `TextBlock[]` | `parsers/*.ts` | — | `ordinal` | **block**（見下表） | 暫時 | 否 |
| 4 | 一個 SQLite transaction：upsert document 列、綁 root | `store.ts: upsert()` L959 | `documents`、`document_roots` | `documents.id`（replace 時不變，stable reference 依此） | 文件 | 持久 | 否 |
| 5 | 刪除舊的 blocks／payloads／mapping／blooms | `upsert()` | 各子表 | `document_id` | 文件 | — | — |
| 6 | 寫入 block metadata；**`content` 欄寫空字串**，heading 與位置字串保留原文 | `upsert()` | `blocks` | `blocks.id`（全域 rowid）；`UNIQUE(document_id, ordinal)` | block | 持久 | 否 |
| 7 | 依 ordinal 排序，將 `[blockId, 片段]` tuple 打包成 ≤64 KiB 的 JSON 陣列；單一 block 內文先以 64K UTF-16 code units 切段 | `writeDocumentPayloads()` L1454、`splitText()` L242 | — | `(document_id, ordinal)` | **payload（約 64 KiB JSON）** | 暫時 | 否 |
| 8 | Brotli quality 5 壓縮每個 payload | `compressText()` L252 | `document_payloads` | `(document_id, ordinal)` | payload | 持久 | **是** |
| 9 | 記錄 payload → block 對應（一個 payload 內出現的每個 block id 一列） | `writeDocumentPayloads()` | `document_payload_blocks` | `(document_id, payload_ordinal, block_id)` | payload×block | 持久 | 否 |
| 10 | 每個 payload 一個固定 1 KiB Bloom（bigram + trigram，2 個 hash） | `buildBloom()` L192 | `document_payload_blooms` | `(document_id, payload_ordinal)` | payload | 持久 | 否 |
| 11 | 整份文件一個固定 1 KiB Bloom（heading + content 的 bigram + trigram） | `buildBloom()` | `document_blooms` | `document_id` | 文件 | 持久 | 否 |
| 12 | *(local only)* 把 `filename + 所有 heading + 所有 content` 以 `\n` 串成一個字串，NFKC＋小寫後寫入兩張 FTS5：unigram 表寫成 `u<hex codepoint>` token 串，trigram 表寫正規化原文 | `replaceNgramDocument()` L926、`searchableDocumentText()` L177、`unigramText()` | `search_unigrams`、`search_trigrams`、`index_migration_documents('ngram_1')` | FTS rowid = `documents.id` | **文件** | 持久 | FTS5 內部 varint |
| 13 | COMMIT | `upsert()` | — | — | 文件 | — | — |

metadata-only 文件（不支援格式、錯誤、too_large）走 `touchMetadata()` L942：只寫 `documents` 與 FTS（僅 filename）。

**Parser 的 block 粒度**（決定後面所有 exact match 與 snippet 的單位）：

| 格式 | block = | heading | 程式 |
|---|---|---|---|
| `.txt .java .sql .js .adoc`、`.xml` | 一行（非空白行） | null | `text-decode.ts: lineBlocks()` |
| `.csv` | 一列 | null | `parsers/csv.ts` |
| `.xlsx .xlsm`（`.xls` 類似） | **一個儲存格** | 工作表名稱（每格重複存一次） | `parsers/xlsx.ts` |
| `.md` | 一個 heading section | section heading | `parsers/markdown.ts` |
| `.docx` | 一個段落 | 最近的 heading | `parsers/docx.ts` |
| `.pdf` | 一頁 | null | `parsers/pdf.ts` |

migration 路徑：`upgrade()` 依序執行 `migratePayloads()`（content_storage_version 2）→ multi-root → root-merge → `migratePayloadBlooms()`（v2）→ `migrateNgramIndex()`（local only）。每份文件一個 transaction 加上 `index_migration_documents` marker，可中斷後接續；read-only 開啟（CLI search／status、MCP）永遠不遷移、不寫入。

---

## B. Storage schema

```text
documents (id PK) ─┬─< blocks (id PK; UNIQUE(document_id, ordinal))        heading/location 明文，content = ''
                   ├─< document_payloads (PK document_id, ordinal)         Brotli(JSON [[blockId, text], ...])
                   ├─< document_payload_blocks (PK document_id, payload_ordinal, block_id) ──> blocks.id
                   ├─< document_payload_blooms (PK document_id, payload_ordinal)  1 KiB
                   ├── document_blooms (PK document_id)                            1 KiB
                   ├── document_roots (PK document_id) ──> roots(path)
                   └── index_migration_documents (PK version, document_id)
search_unigrams  FTS5 contentless, detail=none, rowid = documents.id    (local only)
search_trigrams  FTS5 contentless, detail=none, rowid = documents.id    (local only)
metadata (key PK) · roots · root_ignore_scopes · root_merge_history · root_trash · block_payloads(舊格式，遷移用)
```

| 表 | Primary key | 用途 | 基數（真實 store） | 讀取路徑 | 寫入路徑 |
|---|---|---|---:|---|---|
| `documents` | `id` | 文件 metadata；`id` 是 stable reference 的基礎 | 235,463 | `streamCandidates()`、`candidateByPath()`、`getDocument*()` | `upsert()`、`touchMetadata()`、remove 系列 |
| `blocks` | `id`；`UNIQUE(document_id, ordinal)`；索引 `blocks_document_id` | block 的 heading、location、ordinal。**正文不在此表**（寫空字串） | 5,313,248 | `readAllBlockMetadata()`、`selectedBlockMetadata()`、`blockSource()` | `upsert()` |
| `document_payloads` | `(document_id, ordinal)` | 正文唯一存放處：Brotli q5 壓縮的 `[[blockId, fragment], ...]` JSON，約 64 KiB／個 | 27,468 | `streamBlocksFor()` | `writeDocumentPayloads()` |
| `document_payload_blocks` | `(document_id, payload_ordinal, block_id)`；索引 `(document_id, block_id)`、`(block_id)` | payload ↔ owning block 對應；用來把 payload 候選擴展成完整 block | 5,316,529 | `selectedBlockMetadata()`、payload blob CTE、`blockSource()` | `writeDocumentPayloads()` |
| `document_payload_blooms` | `(document_id, payload_ordinal)` | 每個 payload 一個 1 KiB bigram＋trigram Bloom | 27,468（約 27 MiB） | `candidateFromBlooms()`：每個候選文件一次 `.all()` | `writeDocumentPayloads()`、`migratePayloadBlooms()` |
| `document_blooms` | `document_id` | 每份文件一個 1 KiB Bloom | 235,463（約 230 MiB） | `candidateFromBlooms()`：每個候選文件一次 `.get()` | `upsert()` |
| `search_unigrams` *(local)* | FTS rowid = document id | 1–2 字查詢：code point token 的文件級 AND | 每份文件 1 列 | `postingDocumentIds()` | `replaceNgramDocument()`、`migrateNgramIndex()` |
| `search_trigrams` *(local)* | FTS rowid = document id | ≥3 字查詢：trigram 的文件級 AND | 每份文件 1 列 | `postingDocumentIds()` | 同上 |
| `index_migration_documents` | `(version, document_id)` | 逐文件 migration 完成 marker（`content_storage_2`、`payload_bloom_2`、`ngram_1`） | ≤ 文件數 × 版本數 | `formatStatus()`、migrations | migrations、`replaceNgramDocument()` |
| `metadata` | `key` | 格式版本（`content_storage_version`、`payload_bloom_version`、`ngram_index_version`…）、root、UI 設定 | 少量 | 開庫、`formatStatus()` | 開庫、migration |
| `roots`、`document_roots`、`root_ignore_scopes`、`root_merge_history`、`root_trash` | 見 schema | 多根目錄歸屬、合併、垃圾桶 | 少量／每文件 1 列 | `documentWhere()` 產生 scope 條件 | root 操作 |
| `block_payloads` | `(block_id, ordinal)` | 舊版（per-block payload）格式，只在 `migratePayloads()` 讀 | 新庫為 0 | migration | — |

---

## C. Search pipeline（local）

### C.1 Call graph

```text
createSearchResultSet(store, rawQuery, types, root, mode, subtree, field, statuses, sort)   search.ts L414
└─ collectHits(...)                                                                           search.ts L323
   ├─ queryTerms(): query = NFKC(trim(raw)).toLowerCase()
   │    phrase → terms=[query] ; all-terms → split on whitespace, normalize each      search.ts L247
   ├─ store.streamCandidates(types, root, terms, allTerms, subtree, trace)               store.ts L1147
   │  ├─ postingDocumentIds(terms, allTerms)                                            store.ts L1122
   │  │    phrase: 只查 terms[0]；all-terms: 每個 term 各查一次再取交集
   │  │    term < 3 code points → search_unigrams MATCH '"u6e2c" AND "u8a66"'
   │  │    term ≥ 3 code points → search_trigrams MATCH '"spe" AND "pec" AND ...'
   │  │    回傳 Set<documents.id>                      ← 候選資訊只剩 document id
   │  ├─ SELECT count(*) FROM documents <scope>   → documentsInScope（名義上是 trace 用，但 collectHits 一定會建 recorder，所以每次都執行）
   │  ├─ SELECT ... FROM documents <scope> AND id IN json_each(postingIds)   (iterate)
   │  └─ for each document: candidateFromBlooms()                                        store.ts L1210
   │       ├─ document_blooms.get(id); filename 已含 term 則該 term 不需要 Bloom
   │       │    bloomMayContain(): 2 字查 bigram（v2），≥3 字查全部 trigram（AND）
   │       │    不可能 → {pruned:true}
   │       ├─ document_payload_blooms.all(id)
   │       │    任一 term < 3 字、或沒有 summary → candidates = undefined（整份文件）
   │       │    否則 bloomMayContainAny(): payload 只要含「任一個」trigram 就保留
   │       └─ blocks = streamBlocksFor(id, candidates | undefined)   ← lazy generator，尚未執行
   └─ for each {document, blocks, pruned}:
        if pruned → skip
        beginPhase("exactVerification")
        rankDocument(document, blocks, query, terms, mode, field)                       search.ts L274
          filenameRank = field≠content && (filename == query ? 4 : filename ⊇ all terms ? 3 : 0)
          if !filenameRank && field ≠ filename:
            for block of blocks:                         ← 此時才驅動 generator
              streamBlocksFor()                                                           store.ts L1331
                ├─ selectedBlockMetadata(): payload ordinals → owning block ids + metadata (Q1)
                │    或 readAllBlockMetadata()（全文件 fallback）
                ├─ payload blob SELECT：包含這些 owning blocks 的「所有」payload (Q2 closure)
                ├─ for payload: brotliDecompressSync → toString → JSON.parse
                └─ 依 blockId 串接 fragment，重建完整 block → yield
              heading = normalize(block.heading); content = normalize(block.content)
              記錄第一個 heading 命中、第一個 content 命中、all-terms 覆蓋度
              **不提前結束**：即使已有 content 命中，仍掃完所有 block 找 heading 命中
          rank: 4 檔名完全相同 > 3 檔名包含 > 2 heading > 1 content
        endPhase
   ├─ sort：rank desc → modifiedAtMs desc → path（或 filename／modified 排序）
   └─ 回傳所有命中文件的 RankedSearchResult（不含 snippet）

resultSet.page(page, pageSize) → materializeHits()                                         search.ts L374
   for 本頁每筆結果:
     sourceKind = filename → snippet 取檔名
     否則 store.blockSource(docId, ordinal, heading|content)                              store.ts L1267
        SELECT blocks.id → SELECT payload_ordinal FROM document_payload_blocks WHERE block_id
        → streamBlocksFor(docId, those payloads) → 找到 ordinal 相同的 block
     makeSnippet(source, 最先出現的 term)：NFKC 對照回原文位置，前 45／總長約 160 字元   search.ts L179
```

`matchingPassages()`（L451）走 `candidateByPath()` → `blocksFor()`，**一律讀整份文件**所有 payload，再逐 block 排名取前 N 個段落。`SearchSession` 的「結果內搜尋」走 `streamCandidatesByIds()`，其餘流程相同。

### C.2 各階段說明

| 階段 | 做什麼 | 讀什麼 | 有無使用索引 |
|---|---|---|---|
| raw query → normalize | `NFKC` + `toLowerCase()`；all-terms 以空白分詞 | — | — |
| candidate generation | FTS5 `detail=none` 的 AND 查詢 | FTS doclists | 有；只得到文件 ID |
| document pruning | 文件級 1 KiB Bloom | `document_blooms`（每候選 1 列） | 有 |
| payload pruning | payload 級 1 KiB Bloom，「任一 trigram」即保留；<3 字不做 | `document_payload_blooms`（每候選文件所有列） | 有 |
| payload lookup | Q1：payload → owning blocks 的 metadata；Q2：這些 blocks 涵蓋的所有 payload blob | `document_payload_blocks`、`blocks`、`document_payloads` | B-tree |
| decompression | Brotli + UTF-8 decode + `JSON.parse` | payload blob | — |
| block reconstruction | 依 blockId 串接跨 payload fragment | 記憶體 | — |
| exact verification | 每個 block 的 heading 與 content 各做一次 NFKC＋小寫，再 `String.includes` | 記憶體 | 無 |
| ranking | 文件層級 rank（檔名／heading／content）＋ mtime＋path | 記憶體 | 無 |
| snippet | 只為本頁結果回讀代表 block，NFKC 位移對照 | 1 個 block 的 owning payload | B-tree |
| pagination | `SearchResultSet` 保留完整排序後的結果；`PRAGMA data_version` 偵測索引變動 | — | — |

### C.3 Trace 計時的巢狀關係（解讀 profiling 的前提）

`streamBlocksFor()` 是 lazy generator，在 `rankDocument()` 迭代時才執行，因此 `payloadLookup` 與 `payloadDecompression` 的時間**包含在** `exactVerification` 之內。schema 3 以 `phasesMs`（inclusive）與 `phaseSelfMs`（exclusive）區分。實測 `SPEC.md`：

```text
exactVerification inclusive 14,433 ms = payloadLookup 6,894 + payloadDecompression 2,580 + exact self 4,960
```

使用者提供的舊 trace（29,094 ms）中，`payloadLookup 15,469 + payloadDecompression 4,562 + …` 同樣都落在 `exactVerification 28,923` 內，不能相加。

---

## D. Granularity map

| 概念 | 目前粒度 | 證據 |
|---|---|---|
| **document** | 一個檔案；`documents.id` 是 stable reference | `documents` 表 |
| **block** | parser 決定：一行／一列／一個儲存格／一段／一頁／一個 md section | `parsers/*`、`TextBlock` |
| **payload** | 同一文件內依 ordinal 串接的 block fragments，JSON 約 64 KiB（CJK 約 2 萬字元、ASCII 約 6 萬字元），Brotli 壓縮；是 I/O、解壓與 payload Bloom 的單位 | `writeDocumentPayloads()` |
| **posting row**（local） | **一份文件一列**；內容是 filename＋所有 heading＋所有 content 串成的一個字串；`detail=none`：只有 rowid，沒有欄位、位置、block、payload | `replaceNgramDocument()`、schema L507–514 |
| **Bloom summary** | 文件級 1 KiB＋payload 級 1 KiB；bigram＋trigram；2 個 hash；大小固定，不隨文字量變化 | `buildBloom()` |
| **FTS row** | 同 posting row（每份文件一列） | 同上 |
| **exact match unit** | **單一 block 的 heading 或 content**（各自比對；跨 block、跨 heading／content 的片語永遠不命中）；檔名另外比對 | `rankDocument()` |
| **ranking unit** | 文件（每份文件一筆結果，代表 block 為第一個 heading 命中，其次第一個 content 命中） | `rankDocument()`、`collectHits()` |
| **snippet unit** | 單一代表 block（或檔名），擷取約 160 字元 | `materializeHits()`、`makeSnippet()` |

重點：**同一次查詢跨越四種不同粒度**：候選是「文件」，剪枝與讀取是「64 KiB payload」，比對是「block」，排序是「文件」。唯一能把文件縮小到 block 的資料結構只有 payload Bloom。

---

## E. GitHub baseline 的搜尋路徑（對照）

- `streamCandidates()` 以 `SELECT … FROM documents <scope>` 逐列走過 scope 內全部文件（235,463 份），每份讀一次 `document_blooms`（全庫合計約 230 MiB），再讀 `document_payload_blooms`。沒有 postings、沒有 trace。
- `bloomMayContain()` 對 <3 字的 term 一律回傳 true（v1 沒有 bigram），因此 1–2 字查詢等於全庫 full scan 加上每份文件完整解壓。
- `streamBlocksFor()` 每次先 `SELECT … FROM blocks WHERE document_id = ?` 取回整份文件的 block metadata，再以 `IN (json_each)` 過濾。這正是 local 在 2026-09-27 以 Q1／Q2 CTE 修掉的 overfetch。
- `rankDocument()`、`makeSnippet()`、分頁語意與 local 相同（local 只加了 `field`／`sort`）。
