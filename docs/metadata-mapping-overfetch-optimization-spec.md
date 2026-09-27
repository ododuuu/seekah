# Metadata / Mapping Overfetch Optimization — Implementation SPEC

日期：2026-09-27。適用專案：`C:/Users/mains/seekah`，進行中版本 0.37.0，package 仍為 0.36.2。

**狀態：已實作並完成本機驗證（2026-09-27）。** Production filtered retrieval、trace counters、sparse／fallback tests、專用 benchmark driver 與同一 snapshot 的 BEFORE／AFTER 報告均已完成；未新增 index、schema、temp table、cache 或 package version。完整 raw samples、plans、hashes 與限制見 `docs/metadata-mapping-optimization-2026-09-27-*.json`；這不是公司 Windows 人工驗收。

## 1. Problem statement

### 1.1 唯一目標

只優化 `IndexStore.streamBlocksFor()` 的 **metadata／mapping JS materialization 與 retrieval SQL**：由既有 candidate payload ordinals 在 SQLite 內找 owning blocks、只回傳必要 metadata、在 SQLite 內求完整 owning-block payload 集合，再回傳 blobs。所有候選策略、搜尋語意與正文儲存格式不變。

本階段的減量單位是「SQLite 回傳 JS 的 metadata rows／獨立 mapping-ID rows」及其附帶陣列、Set、JSON 往返；不是限制文件數、命中數或 block 大小。

### 1.2 明確排除

禁止新增 payload-level FTS postings、ngram schema redesign、Bloom redesign、bigram index、任何新 index、壓縮格式／Brotli／JSON 格式改動、cross-query cache、snippet cache、ranking redesign、block／result truncation、approximate search、correctness trade-off。不得改 `candidateFromBlooms()` 的候選條件或 full fallback 政策。不得同時優化 statement reuse、跨文件 batching、parser、UI 或 postings。

### 1.3 必須修正的 profiling interpretation

原 forward mapping SQL **已在 SQLite 以候選 payload 篩選，並 SELECT DISTINCT block_id**；不是把整份 mapping 回傳 JS 才篩選。因此：

- `SPEC.md` 的 **1,442,468 個 mapping result rows 都是當時選中的 owning block IDs**，不是 144 萬個無關 ID。
- 不改 Bloom、不截斷 block 時，正常資料的必要 metadata 仍有 **1,442,468 rows**。相較原本 1,652,374 rows，metadata 可減 **209,906 rows，約 12.70%**，不是降到 4,638 rows。
- 可消除的是這 1,442,468 筆 ID 的**獨立** JS row objects／array／Set／selected-ID JSON，再避免未選中的 metadata。owning ID 仍隨其 metadata 回傳，SQLite 也仍要計算 selected 集合。
- `測試` 是短詞 full-document fallback，ranking metadata 不會因本階段下降；`Snipaste-2.11.3-x64` 的 ranking selected blocks 等於全文件 blocks，ranking metadata 也不下降。不得為追求漂亮指標修改這些候選集合。

## 2. Measured evidence

### 2.1 已有完整搜尋基線

來源：[search-payload-profile-2026-09-27.json](search-payload-profile-2026-09-27.json)、[0.37.0-VALIDATION.md](0.37.0-VALIDATION.md)。實際資料庫為 `C:/Users/mains/AppData/Local/LocalDocSearch/index.db`，235,463 documents；Node.js v22.23.2／win32。四查詢同連線依序執行，含第一頁 20 筆，未清 OS／SQLite cache。這是單次歷史樣本，不是 p50／p95，不代表公司 Windows 人工驗收。

| 指標 | 測試 | SPEC.md | Snipaste-2.11.3-x64 | seekah_absent_20260927_f391a7 |
|---|---:|---:|---:|---:|
| postings candidate documents | 111 | 144 | 2 | 0 |
| payload summary rows | 2,601 | 4,954 | 461 | 0 |
| payloadsAfterPruning | 2,601（回退值） | 4,640 | 460 | 0 |
| ranking payload reads | 2,601 | 4,638 | 461 | 0 |
| 完成第一頁 payload reads | 2,619 | 4,638 | 462 | 0 |
| unique／duplicate reads | 2,601／18 | 4,638／0 | 461／1 | 0／0 |
| ranking metadata rows | 653,633 | 1,652,374 | 50,493 | 0 |
| 完成第一頁 metadata rows | 654,014 | 1,652,374 | 59,948 | 0 |
| ranking standalone mapping rows | 0 | 1,442,468 | 50,493 | 0 |
| 完成第一頁 standalone mapping rows | 258 | 1,442,468 | 51,374 | 0 |
| payloadLookup ms | 1,642.506 | 6,893.641 | 191.779 | 0 |
| SQL execute 合計 ms | 1,629.446 | 6,443.282 | 173.073 | 0 |
| decompression ms | 1,572.584 | 2,579.600 | 200.357 | 0 |
| exact self ms | 2,321.853 | 4,960.103 | 197.738 | 0 |
| total ms | 5,602.491 | 14,511.061 | 637.410 | 42.226 |
| result total | 96 | 85 | 1 | 0 |

`SPEC.md` 的獨立 lookup SQL：metadata 106 次／3,930.922 ms；mapping 106 次／1,500.584 ms；blob（包含反向 mapping 子查詢）106 次／1,011.776 ms；318 prepares 合計 14.940 ms。`.all()` execute 包含 SQLite 與 native→JS rows／blob 轉換，不是純磁碟時間。

4,640 Bloom ordinals 中有 33 個屬 filename-only 文件，沒有消費 generator；實際 seed 4,607＋expansion 31＝4,638，weighted expansion 1.006729×。不存在需要在本階段限制的 expansion explosion。

### 2.2 本次 planner 的唯讀 SQL 探測

在目前編譯 API 以 `collectHits('SPEC.md')` 取得實際會消費的 106 個 stream 輸入；暫時攔截 generator 只收集 document ID／candidate ordinals，不讀文件正文、不改 production 檔案。再用獨立 `DatabaseSync({readOnly:true})` 執行 SQL。這是 retrieval SQL probe，**不是新搜尋實作或端到端 AFTER**。

本文 §6 最終 SQL 形狀（selected-preserving LEFT JOIN、反向 join 指定既有 index）實測：

- metadata result rows：**1,442,468**；兩 statement 的 blob rows：**4,638**。
- 單次 metadata SQL aggregate 約 **4,026.214 ms**；blob SQL aggregate 約 **1,543.985 ms**；每個 statement 都包含自己的 selected CTE 計算。這兩數不能直接與歷史不同時段的三條 SQL 相減宣稱已達標。
- metadata 預期 row bound 已實測，不是猜測。端到端 correctness、GC／RSS、10 次 latency 分布已依 §11／§14 完成；具體命令與限制見 `docs/0.37.0-VALIDATION.md`。
- **否決的 SQL 變體**：反向 `selected CROSS JOIN mapping` 未指定 index 時，EXPLAIN 選 covering primary key 的 `document_id=?` 範圍掃描，對每個 selected block 重掃該文件 mapping；同一批 106 文件 probe 超過 **120 秒**被終止。不得交付該變體。
- 最終 SQL 以 `INDEXED BY document_payload_blocks_document_block` 固定反向 `(document_id, block_id)` lookup；沒有新增 index。
- 另對上述 **106 個文件逐一比較 SQL 回傳值**：Q1 的 1,442,468 筆 metadata（依 ordinal 對齊，逐欄比較）與舊全 metadata 經原 S 篩選的結果完全相同；Q2 的 4,638 個 payload ordinal／blob bytes 與原 SQL 完全相同。比較沒有輸出正文。這證明本次真實候選集合上的 SQL 值等價；完整搜尋、legacy／corruption fixture、排序／snippet 與 result hashes 亦已由 focused／full suite 與 benchmark 驗證。早先直接對巨型 rows 使用通用 deep-equality 的 probe 曾逾時，未作成功證據；改用逐欄／buffer 值比較後完成。
- SQL probe 的 SQLite 實際版本為 **3.51.3**（Node v22.23.2），已查到既有 `document_payload_blocks_document_block` index。最低支援 Node 22.17.0 仍須按 §12 驗證其實際 SQLite plan；不能把本機 plan 當成所有 runtime 都已驗收。

### 2.3 本次實際驗證的稀疏 fixture

§10.1 的 256 blocks、每 block 32,768 ASCII bytes、ordinal 128／192 各含 `needle-739 ` 的 fixture，已用現有 `IndexStore.upsert()` 在隔離暫存 DB 建立並執行真實搜尋；暫存 DB 已移除。

實測 DB：256 blocks／256 payloads／256 mappings。BEFORE ranking 為 2 candidate payloads、2 reads、256 metadata rows、2 standalone mapping rows；first page 後為 3 reads、unique=2／duplicate=1、513 metadata rows、4 standalone mapping rows。AFTER ranking metadata 為 2 rows、standalone mapping 0；first page metadata 為 4 rows、standalone mapping 1；payload reads 仍 2／3，1 個結果、rank=1、location=`line 128`，result hash／內容一致。這證明 fixture 真正稀疏，且已完成 §10.1 驗收。

## 3. Existing architecture

本節行號是快照近似值；以符號及 SQL anchor 為準。實作已完成，後續維護仍不可因行號位移而改錯函式。

| 檔案／anchor | 約行 | 責任與資料形狀 |
|---|---:|---|
| `src/search.ts:createSearchResultSet` | 414 | 建立 recorder；呼叫 collectHits；保留輕量 ranked metadata；page 再物化 |
| `src/search.ts:collectHits` | 323 | normalization → source generator → 每文件 exact inclusive phase → rankDocument → 排序 |
| `src/store.ts:streamCandidates` | 1139 | postings IDs＋scope SQL；逐文件 document／payload Bloom |
| `src/store.ts:streamCandidatesByIds` | 1172 | restricted IDs 與 postings 交集，仍重用 candidateFromBlooms |
| `src/store.ts:postingDocumentIds` | 1114 | FTS MATCH SELECT rowid → Set<documentId>；無 payload ordinal |
| `src/store.ts:candidateFromBlooms` | 1202 | summaries → candidate payload ordinals；短詞／缺摘要／空 candidates 保守 full fallback |
| `src/store.ts:streamBlocksFor` | 1291 | 收 documentId、可選 readonly ordinals、trace、snippet flag；查 metadata／mapping／payload，重建 StoredBlockRow generator |
| `src/search.ts:rankDocument` | 274 | 檔名命中可不消費 generator；否則對每個完整 block normalize／includes，保留 ranking、representative 選擇 |
| `src/store.ts:blockSource` | 1259 | 依 documentId＋block ordinal 找 ID、mapping；再呼叫 streamBlocksFor；page snippet 可能重讀 |
| `src/search.ts:materializeHits` | 374 | blockSource 回讀後 makeSnippet，保留 page/total/reference |
| `src/store.ts:candidateByPath → blocksFor` | 1247／1286 | matchingPassages 等全文路徑，沒有候選 payload；本階段維持 full stream |
| `src/store.ts:writeDocumentPayloads` | 1383 | 按 block ordinal 寫連續 fragments；本階段完全不改 |
| `src/search-trace.ts:recordPayloadSql / recordPayloadReadPass / snapshot` | 267／294／353 | SQL 子計時、read/decompress/unique/expansion、inclusive/self；不能移除 |

實際執行順序（generator laziness 必須保留）：

```text
createSearchResultSet → collectHits
  → streamCandidates → postingDocumentIds → candidateFromBlooms
    → 回傳 {document, blocks: streamBlocksFor(...)}，尚未執行 retrieval
  → rankDocument
    → filename 命中：不 consume blocks
    → 否則 for (block of blocks)
      → streamBlocksFor: metadata → mapping → blobs → reconstruction → yield
      → rankDocument: normalize／exact／ranking
  → sort
page → materializeHits → blockSource → streamBlocksFor → snippet
```

不是先把全部 blocks 讀完再呼叫 rankDocument。也沒有使用者提到的 `postingCandidates()` 符號；實際名稱是 `postingDocumentIds()`。

## 4. Root cause：三種 SQL 分開處理

### 4.1 A — block metadata overfetch

```sql
SELECT id, ordinal, heading, content, location_kind, location_value
FROM blocks
WHERE document_id = ?
ORDER BY ordinal;
```

- input：單一 documentId。
- output：該文件全部 block metadata，`.all()` 成 JS array，後續再成 Map。
- 在知道 selected block IDs 之前執行；即使只有一個 candidate payload，也讀整份文件。
- selected pass 中，沒有被選中的 metadata 不會用於被 yield 的 block；可不回傳 JS。`SPEC.md` 正常 ranking 可省 209,906 rows。
- 必要欄位：id（重建鍵）、ordinal（排序／stable location）、heading（heading match）、location_kind/value（結果）；content 對正常壓縮索引多為空，但零 payload 的 legacy inline fallback 必須保留。本階段不另做欄位壓縮或 schema 遷移。

### 4.2 B — payload → owning block mapping 往返

```sql
SELECT DISTINCT block_id
FROM document_payload_blocks
WHERE document_id = ?
  AND payload_ordinal IN (SELECT value FROM json_each(?));
```

- input：documentId、candidate ordinals JSON。
- output：選中 payload 涉及的唯一 block IDs，**已篩選**。
- JS 建 `.all()` array → `.map(row => row.block_id)` → Set；再 `[...selectedIds]` → JSON.stringify，送回 SQLite。
- JS 並沒有把 1,442,468 rows 當無關資料丟棄；它們全部參與 fragment membership、metadata lookup 與 reverse mapping。真正可避免的是獨立 ID result 及重複表示／跨界往返。
- 新設計讓 selected 集合留在 statement-local CTE，ID 隨必要 metadata 一次回傳；重建以該 metadata Map 的 membership 取代獨立 Set。不能把 SQL 內部仍處理的 mapping rows 宣稱為 0。

### 4.3 C — payload blob retrieval

```sql
SELECT p.ordinal, p.payload
FROM document_payloads p
WHERE p.document_id = ? AND p.ordinal IN (
  SELECT DISTINCT payload_ordinal FROM document_payload_blocks
  WHERE document_id = ?
    AND block_id IN (SELECT value FROM json_each(?))
)
ORDER BY p.ordinal;
```

- input：documentId（兩次）、JS selected block IDs JSON。
- output：完整 selected owning blocks 所需的唯一 blobs，已按 ordinal 排序；不是每 payload 一條 SELECT。
- 4,638 blobs 不是這個階段要減少的目標；必須與 BEFORE 相同。
- 新版只替换 JS selected-ID JSON 的來源，改 SQLite CTE＋indexed reverse join；保留一次 owning-block closure，不能改成直接讀 seed payload，也不能遞迴把所有 co-resident blocks 加入 closure。

## 5. Target architecture：已選定，不留替代方案

### 5.1 固定決策

1. 保留原 generator、呼叫介面、full-document path、blockSource 與 search/ranking。
2. filtered path 使用 **兩條 SELECT，各自包含相同 `selected AS MATERIALIZED` CTE**：Q1 回必要 metadata，Q2 回完整 blobs。
3. selected CTE 以 `json_each(candidateJson)` 作外層，`CROSS JOIN document_payload_blocks` 依 `(document_id,payload_ordinal)` 點查，`DISTINCT block_id` 去重。
4. Q1 selected-preserving `LEFT JOIN blocks`，只回 selected metadata；以 `s.block_id AS id` 搭配 `blocks.ordinal IS NULL` 的 missing marker，避免重複回傳同一 block ID；payload SQL 完成後才建立 Map，同時表達 membership 與 metadata，不建立第二套 selected Set、不 serialize block IDs。
5. Q2 以 selected 作外層，明確指定現有 `document_payload_blocks_document_block` 做 `(document_id,block_id)` reverse probe；`DISTINCT payload_ordinal` 去重，外層 p PK lookup＋ordinal 排序。
6. **不新增 index，不新增／寫入 temp table，不 batching，不 statement/result cache，不 adaptive dense/sparse 分流。** 每 statement 使用固定數量參數，不受 32,766 等 bind-variable 上限影響。
7. 每 statement 重新算 selected 是刻意選擇：避免 readonly temp-table 生命周期與跨 statement 狀態管理，也避免把百萬 IDs 傳回 JS 再送 SQL。固定 benchmark 已完成；同一 snapshot 的 `SPEC.md` completed payloadLookup p50 與外側 wall p50 均達門檻。
8. `MATERIALIZED`／`DISTINCT` 的 SQLite 內部暫存 B-tree 允許；它不是應用建立的 temp table，也不是第二套索引。不得改 `temp_store`／cache pragmas。

### 5.2 集合與重建契約

定義同一 document d：

```text
C = unique(candidate payload ordinals)
S = DISTINCT mapping.block_id WHERE document_id=d AND payload_ordinal ∈ C
E = DISTINCT mapping.payload_ordinal WHERE document_id=d AND block_id ∈ S
```

- Q1 回 S 的 metadata（缺失 metadata 需保留 selected membership marker）。
- Q2 回現有 document_payloads 中 ordinal∈E 的 blobs。
- 解碼只處理 block ID∈S 的 fragments；E 的其他 co-resident blocks 不得被新納入。
- payload ordinal 排序及既有 fragment 連接順序不變。
- C={10}，A 跨 9,10,11：E 必含 9,10,11。無任何 expansion cap。
- S 為空才沿用既有 full-document fallback；**metadata join 找不到 row 不等於 S 為空**。

## 6. SQL design

### 6.1 Existing schema／indexes（禁止改動）

```sql
-- blocks: id INTEGER PRIMARY KEY
-- UNIQUE(document_id, ordinal)
CREATE INDEX blocks_document_id ON blocks(document_id);

-- document_payloads: PRIMARY KEY(document_id, ordinal)
-- document_payload_blocks: PRIMARY KEY(document_id, payload_ordinal, block_id)
CREATE INDEX document_payload_blocks_document_block
  ON document_payload_blocks(document_id, block_id);
CREATE INDEX document_payload_blocks_block_id
  ON document_payload_blocks(block_id);
```

以上是現存 schema 的說明，**不是要重新執行 CREATE INDEX**。本批沒有 DDL／migration／version marker／ANALYZE 寫入。

### 6.2 Existing plan（真實 DB EXPLAIN）

| query | 已觀測 plan | 意義 |
|---|---|---|
| 全 metadata | `SEARCH blocks USING INDEX sqlite_autoindex_blocks_1 (document_id=?)` | 該文件 ordinal 範圍全讀；不是全庫 table scan |
| forward mapping | `SEARCH document_payload_blocks USING INDEX document_payload_blocks_document_block (document_id=?)`；json_each list subquery | 先掃 document mapping 範圍，再篩 ordinals；回傳 DISTINCT owning IDs |
| reverse mapping subquery | `SEARCH document_payload_blocks USING COVERING INDEX sqlite_autoindex_document_payload_blocks_1 (document_id=?)` | 掃 document mapping 範圍，篩 selected block IDs |
| 外層 blob | `SEARCH p USING INDEX sqlite_autoindex_document_payloads_1 (document_id=? AND ordinal=?)` | 已是按 ordinal 的 lookup |

舊計畫觀測到 `SCAN json_each`／`CREATE BLOOM FILTER`；沒有把這解讀為 application Bloom 變更。原紀錄沒有上述 SQL 的全表掃描或明示 temporary B-tree；不得只根據「SEARCH」就宣稱讀取範圍小。

### 6.3 Q1：selected metadata

**逐字採用下列 SQL 形狀。** `?1`=documentId，`?2`=candidateJson，`?3`=同一 documentId；Node `StatementSync.all(documentId,candidateJson,documentId)`。重用同一個 candidateJson 字串給 Q2，不建立 block-ID JSON。

```sql
WITH selected AS MATERIALIZED (
  SELECT DISTINCT m.block_id
  FROM json_each(?2) AS seed
  CROSS JOIN document_payload_blocks AS m
  WHERE m.document_id = ?1
    AND m.payload_ordinal = seed.value
)
SELECT s.block_id AS owner_id,
       b.id, b.ordinal, b.heading, b.content,
       b.location_kind, b.location_value
FROM selected AS s
LEFT JOIN blocks AS b
  ON b.id = s.block_id AND b.document_id = ?3;
```

- 不在正常 Q1 加 ORDER BY：正常 reconstructed block 順序來自 Q2 的 payload ordinal，不來自 Map insertion order。
- metadata 缺失時 b.id=NULL，但 owner_id 仍存在；Map 留下 `owner_id → null`，不是丟棄 selected ID。這保留後續「selected fragment 指向未知 block」錯誤。
- 同時限制 b.document_id，避免不一致 mapping 借用其他文件的 metadata；原程式也是只載入當前文件 metadata。
- Q1 result 長度=|S|（正常資料即 metadata rows）。若為 0，走 §7 的空 mapping fallback。
- 同一 pass 的 Map 以單一 for-loop 建立，避免 `.map()` 額外 pair-array；Q1 的原始 rows 陣列在 helper 返回後不再保留。不要建立平行 selectedIds Set。
- 應保留 `StoredBlockDatabaseRow` 的正常型別；新增 private query row type：`{owner_id:number} & (正常 metadata | b.*皆可 null 的 missing row)`，以 `id === null` 判斷，不把 ordinal=0 或 heading=null 誤當 missing。

### 6.4 Q2：complete owning-block blobs

`?1`=documentId，`?2`=與 Q1 相同 candidateJson，`?3`、`?4`=同一 documentId；`.all(documentId,candidateJson,documentId,documentId)`。

```sql
WITH selected AS MATERIALIZED (
  SELECT DISTINCT m.block_id
  FROM json_each(?2) AS seed
  CROSS JOIN document_payload_blocks AS m
  WHERE m.document_id = ?1
    AND m.payload_ordinal = seed.value
)
SELECT p.ordinal, p.payload
FROM document_payloads AS p
WHERE p.document_id = ?3
  AND p.ordinal IN (
    SELECT DISTINCT m.payload_ordinal
    FROM selected AS s
    CROSS JOIN document_payload_blocks AS m
      INDEXED BY document_payload_blocks_document_block
    WHERE m.document_id = ?4
      AND m.block_id = s.block_id
  )
ORDER BY p.ordinal;
```

**不可移除 INDEXED BY。** 不使用 `block_id IN (JSON of JS ids)`，不將 CTE 改成對每 payload／block 發一條 SQL，不把 reverse join 改成僅 document-prefix lookup。

### 6.5 Proposed plan 與 cardinality

已觀測 final probe 的關鍵節點：

```text
Q1 / Q2 selected:
  MATERIALIZE selected
  SCAN seed VIRTUAL TABLE INDEX 1:
  SEARCH m USING COVERING INDEX sqlite_autoindex_document_payload_blocks_1
    (document_id=? AND payload_ordinal=?)
  USE TEMP B-TREE FOR DISTINCT
Q1:
  SCAN s
  SEARCH b USING INTEGER PRIMARY KEY (rowid=?) LEFT-JOIN
Q2 reverse:
  SCAN s
  SEARCH m USING INDEX document_payload_blocks_document_block
    (document_id=? AND block_id=?)
  USE TEMP B-TREE FOR DISTINCT
Q2 outer:
  SEARCH p USING INDEX sqlite_autoindex_document_payloads_1
    (document_id=? AND ordinal=?)
```

Q1 正常 rows=|S|；Q2 rows=|E 中有 blob 的 ordinals|。SQLite 內部 forward 訪問量為 seed payload 對應 mapping rows；reverse 為 S 的全部 mapping rows，允許因完整 block 擴大，但不是每 owner 重掃全 document。大量 S 仍然會昂貴，不可聲稱是 O(payload count)；最多有百萬個必要 block。

SQLite 版本可能改 plan 格式／數字；驗收看 lookup constraints、實際輸出集合及 latency，不把整段 EXPLAIN 字串固定成永久測試。若目標 runtime 出現新的 document-prefix nested scan，視為不通過；不要自行加 index。

## 7. Exact file/function changes／Implementation steps

以下為**後續模型**的 ordered steps；本次不執行。

### Step 1 — 鎖定 BEFORE，先建可重用 benchmark driver

- 檔案：新增 `scripts/benchmark-metadata-mapping.mjs`；不得改 production。介面與 protocol 按 §11。
- input：明確的唯讀 database path、compiled module directory、output path、label。
- output：BEFORE JSON（samples／hashes／counts／plans／RSS），並保留 baseline dist。
- invariants：先跑 baseline，再碰 store；不得用歷史單次值冒充本機 BEFORE p50；不寫真實 SQLite，不執行 index／upgrade。
- 實作 scripts 後只在一次整合 build 完成時執行需要的 build；後續驗證順序見 §12。

### Step 2 — 新增局部 private metadata helper，實作 Q1

- 檔案：`src/store.ts`，`streamBlocksFor` 旁新增 `selectedBlockMetadata(documentId,candidateJson,trace)` private helper；不 export，不新增通用 query framework。
- input：documentId、唯一一次 JSON.stringify 的 seed array、optional trace。
- output：`Map<number, StoredBlockDatabaseRow | null>`；keys 精確等於 S；null 表示 selected owner 的 metadata 缺失。
- prepare／execute 的時間沿 `recordPayloadSql('blocksMetadata',...)` 記錄；Q1 rows 計入 `blocksMetadataRows`，不要另加一份 mapping rows。正常資料 rows=必要 metadata；null sentinel 仍是 SQL 回傳 row，計入 rows 並以 §9 說明定義。
- 增加 `owningBlocksFound` 為 Map.size；不增額外 SELECT COUNT。
- 不改 statement caching：和 baseline 一樣每 pass prepare，避免把兩種優化混在一起。

### Step 3 — 調整 streamBlocksFor 的 filtered branch

- 檔案：`src/store.ts:streamBlocksFor`。
- input/output 介面完全不變：`(documentId,candidatePayloads?,trace?,snippet=false) → Generator<StoredBlockRow>`。
- 必須依序分流：
  1. `candidatePayloads === undefined`：執行原 full metadata（ordinal 排序）＋full payload SQL，fullDocumentFallbacks／fullFallbackPayloads 計數不變。
  2. 明確 `candidatePayloads.length===0`：直接 return；不載入 metadata；不是全文 fallback。
  3. nonempty：沿既有 numeric ordinal 契約建立 `uniqueCandidatePayloads=[...new Set(candidatePayloads)]`，只 stringify 一次；重複 ordinals 不造成重複 metadata／blob。
  4. Q1 Map.size===0：沿用原空 mapping fallback，查原 full metadata＋full payload。Q1 的真實花費／零 rows 仍計入 trace；不能 catch 任意 SQL／JSON／Brotli error 當 fallback。
  5. Q1 Map.size>0：執行 Q2；保留 null membership，不因缺 metadata 改全文讀取。
- filtered 不再先執行全 metadata SQL，不再執行獨立 SELECT DISTINCT block_id `.all()`，不再有 mappedBlocks array、selectedIds Set、selected block IDs JSON。
- `recordPayloadReadPass()`：filtered 傳 unique seed ordinals；fallback 傳 undefined；snippet flag 不變。不可將 E 當成 seed，否則 expansion 計數失真。
- `payloadLookup` begin/end 邊界保留涵蓋 metadata／mapping／blob／JSON／Map 準備；請注意移入 helper 的 metadata Map 建立從原本 exact self 改歸 lookup，報告必須記錄此 attribution 差異，不能把 self 下降全當 CPU 節省。不額外包一層重複 phase。

### Step 4 — 保留 reconstruction 與 legacy／error 行為

- 檔案：同一 `streamBlocksFor` 的 decode／pending／yield 區塊。
- 正常 filtered：`selectedMetadata.has(id)` 決定是否屬於 S；`selectedMetadata.get(id)` 決定 metadata 是否可用。不可單用 truthiness 決定 membership。
- filtered／full 共用現有 Brotli、UTF-8、JSON.parse、pending.content 串接與 yield 邏輯；不得換 JSON shape、改成 per-payload exact 或省略未命中完整 fragment。
- 有 blobs 時，即使 inline content 非空也仍使用 payload，不另加 fallback。
- **零 blob rows**：沿用原 inline content path。filtered 只取 Map 中非 null 的 metadata，按 ordinal 遞增排序後套原 truthy content 判斷／yield；full 使用原已排序 blocks。null owner 沒有可遍歷 metadata 時不新增錯誤政策；若之後有 selected decoded fragment 指向 null，仍在原位置拋「索引 payload 指向未知區塊，請執行 rebuild。」。
- 其他 missing payload／Brotli／JSON failures 原樣傳播，不以空結果或文件略過掩蓋。
- full path 不為本次優化改成 selected CTE；保留 `blocksFor`／matchingPassages 語意。

### Step 5 — 保留 snippet 與所有 callers

- 檔案：`src/store.ts:blockSource`、`src/search.ts:materializeHits`，以檢視為主，預設不改碼。
- blockSource 的 id lookup、target block→payload mapping、再送 streamBlocksFor 全部保留。因此 filtered snippet 自動得到新 metadata pruning；它仍可能讀 co-resident owning blocks，仍可能重讀 payload。
- 不增加 snippet cache、不改成只重建 target block、不更改 filename basename／sourceKind fallback。
- `collectHits`／`rankDocument`／FTS／Bloom／upsert／delete／upgrade／SearchSession 不改行為。必要型別引用調整限定在新增 metrics；不改 exported 搜尋 API。

### Step 6 — Diagnostics、tests、benchmark 與交付

- `src/search-trace.ts`：只新增 §9 的實際 counter，emptyCounts、snapshot、lastSearchTrace deep-copy 契約一致；不得刪 schema 3 欄位。
- `test/m23.test.ts`：加入 §10.1 稀疏 fixture 與特殊 correctness 案例；重用既有 temp cleanup 模式。
- `test/m38.test.ts`：擴充 complete block／FTS semantic fixture，不建立新里程碑 m40。
- `test/m39.test.ts`：diagnostics 分割／ranking-snippet／error／self 契約。
- `scripts/benchmark-metadata-mapping.mjs`：照 §11 跑原 dataset BEFORE／AFTER；driver 不成為 production fallback 實作。
- 完成 §12 後更新 `docs/SPEC.md` §49、`docs/DECISIONS.md` D080、`docs/STATUS.md`、`docs/USER-GUIDE.md`、`docs/handoff/CURRENT.md`／`0.37.0.md` 與 `docs/0.37.0-VALIDATION.md`。只記已觀察結果；package 不升版。

## 8. Correctness invariants／Special cases

### 8.1 全域 invariants

對同一未變更索引與查詢，AFTER 必須與 BEFORE 相同：完整 total、ordered returned paths、ranking／reason、heading/location、snippet／snippetTruncated、stable reference、filenameOnly/status、page boundaries。phrase／all-terms／field／sort／root／type／subtree／restricted refinement 語意不變。不能只比較前 20 筆或排序後的無序 path set。

Payload blobs 的 ordinal 集合、順序、bytes，以及實際 yield 的 block ordinal/content/heading/location 必須一致；metadata query 的順序可不同，因不是正常 yield 順序來源。full-document fallback 不新增、不省略。

### 8.2 逐項 special cases

| 情況 | 修改後必須如何處理 |
|---|---|
| single-payload block | S 包含其 block，E 包含原 payload；只載 selected metadata。共用 payload 的其他原本 selected blocks 不能漏掉 |
| block spanning 2 payloads | 任一 seed 選到 block，都回讀兩個 fragments，保持原文與 snippet |
| large multi-payload block | 無上限，完整 E；大 block 不截斷、不 approximate，也不改 parser 切塊 |
| heading hit | 沿 `candidateFromBlooms → rankDocument` 原行為；metadata 必須保留 heading。payload Bloom 不含 heading，空候選仍 full fallback；不新增 heading shortcut |
| body hit | 同一完整 normalized block exact，不能在單 payload 上判定長片語 |
| filename-only hit | 沿 rankDocument 跳過 generator；不得預先執行 Q1/Q2；正文即使損壞也不能因本改動被讀取 |
| short query | 任一 term.length<3 的既有 full path 不變（這是 JS UTF-16 length，不改 code-point 判斷） |
| long phrase | 原 Bloom 條件不變；owning-block closure 保護跨 payload phrase |
| all-terms across blocks | 保留所有 S 的完整 blocks，原 unmatched／representative 邏輯不變；terms 可跨 filename、heading、不同 blocks |
| corrupt unrelated payload | 若不在 E 且原路徑不讀取，仍不得讀／解壓；若因 full fallback 或 shared owning block 在 E，仍照原路徑拋錯，不能為通過测试吞掉錯誤 |
| no-result query | postings 空則不進 retrieval；postings 假陽性但 exact 無結果仍完成同一候選 verification，不提前截斷 |
| duplicate payload ordinal | SQL DISTINCT／IN 的集合語意；JS 只在入 filtered pass 去重一次；不得導致 duplicate blob／fragment 或 expansion ratio 分母膨脹 |
| snippet reread | 沿 blockSource 原 path；原本重讀次數／payload 集合不減少，只有 metadata／standalone mapping materialization 可變少 |
| empty explicit list | `streamBlocksFor(d,[])` yield 空；與 public Bloom 空候選轉 undefined 分開 |
| missing summaries／empty forward map | 前者由 caller 選 full，後者 Q1.size=0 選 full；nonempty partial map **沒有既有完整性偵測**，不得自行新增修復策略 |
| missing selected metadata | LEFT JOIN 留 membership sentinel；遇 selected fragment 時保留 unknown-block error。不能把 join 丟掉的 ID 當 unrelated fragment |
| legacy inline content | 沒有 blobs 才使用；仍依 ordinal yield；缺 truthy content 的同一錯誤保留 |

**既有語意風險邊界**：文件 Bloom／FTS 含 heading，但 payload Bloom 是正文摘要。如果 heading-only block 未被選中、另一 block 卻有 trigram 假陽性，原邏輯可能無法完整覆蓋該 heading；本批不改候選政策、不把它宣稱為已修正。測試至少覆蓋既有能保證的 heading fallback 與同 selected block heading 優先，並以 BEFORE／AFTER parity 防止本批新 regression；若發現新／既有漏搜，分開記錄，不藉機擴大本 scope。

## 9. Diagnostics changes

### 9.1 不移除、不重新定義既有欄位

保持 schemaVersion=3、`phasesMs` inclusive、`phaseSelfMs` self、self bottleneck、reads／decompression／bytes／unique／duplicate／full fallback／filename-only／expansion／SQL prepare-execute。SQL 子計時不能再加到 phase self 合計。

新增三個 number counts，初值 0：

- `candidatePayloadOrdinals`：實際啟動的 nonempty filtered stream 之 distinct seed 數累計，包含 snippet；filename-only 未消費 generator 不計。即使 Q1 空而後 full fallback，也計這次嘗試的 seed。
- `owningBlocksFound`：Q1 selected Map.size 累計，包含 snippet；不把 Q2 重算同一 selected 再加一次；fallback without seeds 不計。
- `blockExpansionInputPayloads`：直接在 snapshot 揭露現有 private `blockExpansionInputs` 累計值；不另建重複 accumulator。其來源已由 `recordBlockExpansion(requestedPayloads,readPayloads)` 記錄成功 filtered pass 的 distinct seeds。

不新增逐 row log、document path log、blob log 或 SQL text log。計數用現有 `.length`／Map.size，禁止為 metrics 多掃一次資料庫。SQL query stats 維持每 statement 一次計時；不用 per-row performance.now。

### 9.2 必要比較欄位的固定對應

以下名稱是 benchmark／驗收報表欄名；不在 production 複製同義 counter：

| 報表欄位 | production source／定義 |
|---|---|
| candidateDocuments | counts.documentsConsidered；另保留 documentsAfterPruning／ExactVerified；不要稱 fallback source 的此數為 postings 數 |
| candidatePayloadOrdinals | 新 counts.candidatePayloadOrdinals；歷史 BEFORE 用 instrumented stream inputs 取值，不誤用含 filename-only 的 Bloom總量 |
| blockMetadataRowsRead | counts.blocksMetadataRows；Q1 的 fused selected-metadata rows＋full metadata＋blockSource id probe；missing sentinel 也屬 SQL 回傳 row |
| payloadBlockMappingRowsRead | counts.owningBlockMappingRows；**獨立** mapping result rows 跨 SQL→JS 的數量，不含 CTE 內部工作，也不把 metadata row 中的 owner_id 再算一筆 |
| owningBlocksFound | 新 counts.owningBlocksFound；BEFORE 可用原 filtered mapping result count、剔除 blockSource target→payload 查詢取得等價值 |
| payloadsBeforeBlockExpansion | 新 counts.blockExpansionInputPayloads；成功 selected pass 的 distinct seed 數；不含空 mapping 後 full fallback 的嘗試；raw seeds另列 candidatePayloadOrdinals |
| payloadsAfterBlockExpansion | counts.selectedPayloadsRead＋counts.expandedPayloads；不含 fullFallbackPayloads；實際全部 read 另列 |
| payloadBlobRowsRead | counts.payloadsRead；SQL已回傳 rows，可能大於實際解壓 |
| blockMetadataSqlMs | diagnostics.payloadSql.blocksMetadata.executeMs；prepareMs另列 |
| payloadMappingSqlMs | diagnostics.payloadSql.owningBlockMapping.executeMs；新版只反映仍獨立執行的 mapping SQL（例如 blockSource） |
| payloadBlobSqlMs | diagnostics.payloadSql.payloadBlob.executeMs；包含 Q2 的 selected／reverse mapping |
| payloadLookupTotalMs | phasesMs.payloadLookup；不重加子計時 |

報表必須同時列 `mappingSelectionPlacement=standalone-js-roundtrip`（BEFORE）／`statement-local-cte`（AFTER）。AFTER 獨立 mapping rows／ms 可為 0，**不能寫 SQLite mapping 計算為 0**。Q1 CTE SQL 計時歸 metadata，Q2 CTE＋reverse 歸 blob；selected metadata Map 在 payload SQL boundary 後建立，這段 materialization 歸 exact self，並在報表說明。固定列出三者 SQL execute 合計、lookup total、wall total，避免以歸類轉移假造效益。

`selectedPayloadsRead` 是實際回傳 blobs 中屬於 seed 的數量，不能一般性替代 seed input 數；缺 mapping／缺 blob 時兩者可能不同。BEFORE 缺少新欄位，依 §11.3 的非計時 characterization pass 取得，不用不精確的除法由 ratio 反推。

### 9.3 預定正常 SPEC.md AFTER 結構（不是 runtime 承諾）

```text
                               BEFORE           AFTER
ranking metadata rows          1,652,374        1,442,468
standalone mapping rows        1,442,468                0
logical owning blocks          1,442,468        1,442,468
metadata + standalone rows     3,094,842        1,442,468
payload blob rows                   4,638            4,638
```

正常相同 snapshot 下這些是集合等價要求，不是可以透過少讀候選來達成的目標。metadata+standalone rows 約減 53.4%，但 row 寬度不同，不能把它直接稱為 53.4% bytes／CPU 節省。

## 10. Test plan

新增永久測試必須使用真實 store／SQLite／壓縮 payload；不 mock 查詢回傳、不比 source text、不把 SQL 字串或固定毫秒當行為測試。保留現有 m20–m25、m38／m39 行為回歸。

### 10.1 必做：稀疏兩 seed、整份 metadata 不再 materialize

位置：`test/m23.test.ts`，獨立 test，名稱 `sparse payload candidates only materialize owning block metadata`。

Fixture：

1. mkdtemp／try-finally cleanup，建立 `sparse.txt` DocumentRecord，256 blocks，ordinal 0..255，heading=null，locationKind=line，locationValue=`line ${ordinal}`，modifiedAtMs=1000。
2. 每個 content 恰 32,768 ASCII bytes。ordinal 128 與 192 是 `"needle-739 " + "x".repeat(32768-11)`；其他是 `"x".repeat(32768)`。注意 marker 實際長度是 11，以 `marker.length` 算，不手寫偏移。filename 不含 query。
3. sizeBytes=8,388,608；使用 `IndexStore.upsert`，不得手工偽造 compressed rows／Bloom。
4. 唯讀 SQL 確認 256 blocks／256 payloads／256 mappings，各 payload 一個 block；兩個 target blocks 在不同 payload。close writer，readOnly reopen，避免自動 repair 影響測試。
5. `createSearchResultSet(store,'needle-739')`，先擷取 ranking trace，再 page(1,20)。

AFTER 必須：

- ranking：total=1；candidatePayloadOrdinals=2、owningBlocksFound=2；metadata rows=2、standalone mapping rows=0；payloadsRead=2、expanded=0、full fallback=0。
- page complete：metadata rows=4（ranking 2＋blockSource id probe 1＋snippet selected metadata 1）；standalone mapping rows=1（保留 blockSource 的 target mapping）；payloadsRead=3、unique=2、duplicate=1。
- rank=1，location=`line 128`，heading=null，stable reference 對應同 documentId/path；snippet 必須含完整 `needle-739`、來自第一個命中 block，並與 BEFORE 捕獲的完整 result projection（含 snippetTruncated）完全一致。不要新增釘死填充字元個數／既有 incidental snippet budget 的測試。
- 這些 row assertions 是 consumer-visible resource boundary：2 seed 不得載全文件 metadata。禁止把 expected metadata 改回 256 使測試通過。
- mapping 從 BEFORE ranking 2→0 是取消獨立 materialization，不是原本有 256 mapping rows；不要寫錯基線。

### 10.2 完整 block／boundary／密集集合

位置：`test/m38.test.ts`，重用 document helper，必要時直接測 generator（以 test-local TypeScript structural cast，不新增 production export）。

- single-payload：一個小 body marker；搜尋與 page 的完整 fields 檢查。
- 2-payload／cross-64KiB：ASCII `"x".repeat(65534) + "ABCDEF" + "y".repeat(20)`，查 `ABCDEF`。由真實 mapping 確认同 block 兩 payload，至少一 seed；完整 E=兩者，exact／snippet 含整個片語。
- expansion 明確案例：沿用 `test/m38.test.ts` 的 `target + x.repeat(65535)`，只有部分 payload 有 marker，仍讀完整 owning block。
- large block：ASCII `"target" + "x".repeat(65536*128)`；真實 mapping 確認 span>=128。透過直接 `streamBlocksFor(id,[含 target 的 ordinal])` 驗證完整 content／length／末尾，不只查 query 是否命中；不得截斷。搜尋 page parity 另驗證一次。
- shared payload：數個小 blocks 共用 seed payload，另有一個跨 payload 大 block；比較 generator 的原始 block ordinal／完整 content，防止擴展 payload 的 incidental block 被遞迴納入。
- duplicate ordinals：同一 fixture 以 `[p,p]` 與 `[p]` 直接 generator 比較輸出、payload read／expansion inputs；兩者相同。
- 保留 m23 的 33,001 candidate payload fixture（防 bind limit）與真實 40,000 blocks upsert fixture（dense selected set）。不用把新 fixture 放大到數百萬 rows 的單元測試。

### 10.3 搜尋語意與特殊情況

位置：現有 m38／m23，重用 m16／m25 的 fixture 模式，不改 ranking。

| 案例 | 必須斷言 |
|---|---|
| heading-only | body=`x` 重複、heading=`heading-only-739`；空 payload candidates 時 full fallback，rank=2、heading snippet |
| heading＋body 同 selected block | heading 優先於 body，reason/location/snippet 與 baseline 相同 |
| filename exact／contains | 不 consume generator；payloadReadPasses=0；檔名 snippet、reference、rank正確 |
| short query | `測試` 命中正文，full fallback 次數／reads 維持；不為降低 metadata 走新 CTE |
| phrase／long query | 長片語不因 payload boundary／JSON entry 邊界漏失；不同 blocks 串接不可誤命中 phrase |
| all-terms across blocks | 兩個 32,768-byte blocks 各含 alpha-739／beta-741，真實 map 確認不同 payload；document total=1、代表 snippet 及 rank 與 baseline 相同；另含 filename+body 與 mixed short/long |
| no result | 不存在 postings 詞：metadata/mapping/blob rows=0；另以兩字 unigram 假陽性但 phrase 不在原文驗證 exact total=0 |
| 排序／stable reference | 四份 document：檔名 exact、檔名 contains、heading、body；固定 timestamps/path，檢查完整 ordered paths/ranks/references/snippets，不只 set |
| total／分頁 | 保留 45 documents 的 m24-pagination-xml／m25 驗證；所有頁拼接無遺漏重複、total不截斷 |

### 10.4 Corruption／fallback／legacy

位置：`test/m23.test.ts`，只修改隔離 temp DB。

1. 在稀疏 fixture 將 ordinal 0 對應的無關 payload blob 改成 X'00'；`needle-739` 搜尋＋page 仍成功。沿用既有 `does not decompress an unrelated payload` 技法。不得對真實索引做 corruption。
2. 另例 corrupt 真正 selected payload：Brotli error 必須傳播，不能空結果；full fallback 遇 corrupt unrelated（但在全文內）也仍傳播。
3. 清空指定文件的全部 mapping，保留 payloads：非空 seeds 的 Q1為空，full fallback，結果與 baseline一致。不要把此測試當成非空 partial map 完整性證明。
4. 明確 `[]` direct stream 為空；public 空 Bloom候選仍 fallback。缺 summaries 的既有案例繼續通過。
5. FK 關閉的隔離 DB，刪除 selected block metadata、保留 mapping與payload；Q1 保留 owner marker，消費其 fragment 時仍拋 unknown-block錯誤。不要因 Map.get(null) 被當 unrelated 而漏錯。
6. 無 payload、保留非空 inline content 的 legacy fixture：按 ordinal yield；inline content 空時同 missing-payload error。沿用 m20 legacy setup，不改 migration。

### 10.5 Diagnostics tests

位置：`test/m39.test.ts`。

- 新 counters 初值／累計、ranking 與 snippet 區分，所有值 finite／nonnegative。
- `selectedPayloadsRead+expandedPayloads+fullFallbackPayloads=payloadsRead`，`unique+duplicate=read` 保持。
- filtered Q1/Q2 不再有 standalone forward mapping execute，blockSource 的獨立 mapping 仍可非零；以稀疏 fixture 的資源邊界斷言，不把某個 SQL 字串當測試。
- inclusive／self 守恆；SQL 子計時是 parent 子集，不重複相加。
- CLI JSON、SearchSession trace、Workbench `/api/search`／`/api/traces` 與 lastSearchTrace 深複製保持；不改 UI 渲染。

## 11. Benchmark plan

### 11.1 為什麼需要新 driver

`package.json` 目前有 `benchmark`、`benchmark:ngram`、`benchmark:m24`、`benchmark:m27`。`scripts/benchmark-ngram.mjs` 是合成資料的 FTS enabled/disabled 比較，採其自己的暖機／5 samples，不能當成本階段 BEFORE/AFTER。m24 是 migration benchmark，不能用來證明 retrieval pruning。

新增的專用 driver 明確屬本批驗收工具；不新增 package script，直接 `node scripts/benchmark-metadata-mapping.mjs ...`。沿用現有 `percentile` 的 nearest-rank 定義、獨立 process／`measure-process.mjs` 的 RSS 思路，不另引入依賴。

### 11.2 固定 CLI 與輸出契約

```text
node scripts/benchmark-metadata-mapping.mjs
  --database <absolute existing index.db>
  --module-dir <compiled directory containing store.js and search.js>
  --label before|after
  --out <new json path>

node scripts/benchmark-metadata-mapping.mjs
  --compare <before.json> <after.json>
  --out <new comparison.json>
```

- 未提供參數、output已存在、DB不存在、scope不是预期 snapshot，明確失敗；不建立／修復／升級使用者 DB。
- Driver 用傳入 module-dir 的 file URL dynamic import，不複製 production retrieval 到 benchmark，不提供 runtime切換舊／新 SQL的產品 flag。
- Data 安全：讀 SQLite只用 readOnly；trace persistence 可在 benchmark專用 subclass覆寫 `recordSearchTrace(trace)` 為 `super.recordSearchTrace(trace,false)`，**兩個版本同樣套用**，避免 JSONL落盤干擾；真實 production CLI smoke仍驗證原log路徑。不輸出document正文、paths或snippets；只輸出hash/count/timing/plan。
- Dataset固定、背景writer必須沒有更新。Driver保留一條獨立 readonly sentinel connection，before/after每輪檢查 `PRAGMA data_version`；任何變更使整份sample集無效。另記DB size/mtime與 metadata versions。BEFORE/AFTER必須同一 snapshot；需要跨時段時使用在writer已停止且DB乾淨狀態下取得的完整測試副本，不在writer活躍時直接複製主db漏WAL/journal。不要由driver擅自停止daemon。

### 11.3 固定 workload／採樣

查詢順序固定：

1. `測試`
2. `SPEC.md`
3. `Snipaste-2.11.3-x64`
4. `seekah_absent_20260927_f391a7`

每 variant／process 一條 IndexStore connection。**3 個完整暖機 rounds，10 個完整 measurement rounds**；每 round按上述順序。每次建立新 resultSet，不跨查詢重用結果或 cache。每次執行 `createSearchResultSet`，存 ranking snapshot，再 `.page(1,20)`，存 completed snapshot及外側 wall time。暖機不計入percentiles。p50=sort第5個，p95=sort第10個（10 samples的nearest-rank），保留原始10筆，明示p95等於該批最大值。

另在计時循環之外建立每query一次resultSet，逐頁20完整物化：對 ordered result fields `{reference,path,extension,modifiedAtMs,heading,location,snippet,rank,reason,filenameOnly,status,snippetTruncated}` 的固定欄位序列JSON累積 SHA-256；加total/pageCount。BEFORE/AFTER完整hash必須一致；不把診斷ID／timestamps當結果比較欄位。這個全頁驗證成本不混入first-page benchmark。

新 counters 的 BEFORE 對照採一次**非計時 characterization pass**，不要修改 baseline production：benchmark 暫時包裝該 store instance 的 `streamBlocksFor` generator，進入時保存 trace counts、distinct seeds 數，`finally` 記錄完成後差值，再原樣 `yield*` 原 generator。只在真正消費 generator 時累計；四個原參數包含 snippet flag 全部轉交。每 pass 若為 nonempty seeds，累計 candidatePayloadOrdinals；fullDocumentFallbacks 差值為 0 的成功 filtered pass 累計 blockExpansionInputPayloads；BEFORE 的 owningBlocksFound 取該 pass owningBlockMappingRows 差值（blockSource 的前置 mapping 已在 wrapper 外，不會混入）。AFTER 可用同樣 wrapper 核對新增欄位。characterization 完畢立即恢復方法；**3＋10 計時期間沒有此 wrapper、沒有 per-pass snapshot**。這些 structural counts 在相同 dataset 上應與測量輪的既有 counts 相容；不相容即報錯。此工具只觀察既有結果，不含替代 retrieval 實作。

- Driver先記一輪EXPLAIN（至少one-seed sparse、`SPEC.md`最大seed pass、33,001 synthetic可另於測試取plan）；不在每sample執行EXPLAIN。
- 同時記 `process.resourceUsage().maxRSS`（KiB）與 `process.memoryUsage().rss`、Node／SQLite版本、OS、DB標識、sample protocol。不要用5ms timer宣稱精準涵蓋同步SQL尖峰；OS maxRSS是必要值。
- 不執行GC、不清OScache、不改SQLitepragmas；不與其他tests/benchmarks並行。
- before與after各跑一次3+10；若no-regression或效益閾值不過，再完整重跑一組配對3+10並保存兩組，不能挑最好sample。第二組仍不過即不達標，回報planner；不得擴大scope硬湊效益。

### 11.4 報表格式（ranking／completed各一份）

```text
query / scope / protocol / dataset identity
metric                              BEFORE p50/p95   AFTER p50/p95   AFTER/BEFORE
metadata rows                       deterministic    deterministic  ratio
standalone mapping rows             deterministic    deterministic  ratio
logical owning blocks               deterministic    deterministic  ratio
payload blob rows                   deterministic    deterministic  ratio
metadata SQL execute ms
standalone mapping SQL execute ms
blob SQL execute ms
SQL execute sum ms
SQL prepare count / ms
payload lookup ms
Brotli / decode-parse ms
decompression ms
exact self / exact inclusive ms
exactTextMs
total trace / wall ms
compressed / decompressed bytes
unique / duplicate reads
process maxRSS
```

counts必須在10次固定dataset上相同；不同即標記不穩定而非只取平均。BEFORE為0的ratio寫null／N/A，不除零。`mappingSelectionPlacement`、Q1內含CTE、metadata Map計時歸屬改變必須出現在報表說明。

## 12. Verification commands

以下路徑／現有命令已由 `package.json` 和目前 test layout 核對。新driver是§11要求後續實作的檔案，**目前尚不存在，不冒稱已有package command**。

### 12.1 建立 baseline（production改碼前）

建立新driver後：

```powershell
npm run build
node -e "const fs=require('node:fs'); const p='.bench/metadata-baseline/dist'; if(fs.existsSync(p)) throw Error('baseline exists'); fs.mkdirSync('.bench/metadata-baseline',{recursive:true}); fs.cpSync('dist',p,{recursive:true});"
node scripts/benchmark-metadata-mapping.mjs --database "C:/Users/mains/AppData/Local/LocalDocSearch/index.db" --module-dir ".bench/metadata-baseline/dist/src" --label before --out ".bench/metadata-before.json"
```

Baseline副本放repo下以沿用node_modules解析；只複製build產物，不改SQLite。確認`.bench`不加入交付／Git；輸出位置不存在才執行，不覆寫歷史資料。

### 12.2 整合完成後

```powershell
npm run build
node --test --test-concurrency=1 dist/test/m20.test.js dist/test/m21.test.js dist/test/m22.test.js dist/test/m23.test.js dist/test/m24.test.js dist/test/m24-pagination-xml.test.js dist/test/m25.test.js dist/test/m38.test.js
node --test --test-concurrency=1 dist/test/m39.test.js
node --test --test-concurrency=1 dist/test/m5.test.js dist/test/m16.test.js dist/test/m19.test.js dist/test/m35.test.js dist/test/m37.test.js dist/test/m37-stage5-6.test.js
npm test
node scripts/benchmark-metadata-mapping.mjs --database "C:/Users/mains/AppData/Local/LocalDocSearch/index.db" --module-dir "dist/src" --label after --out ".bench/metadata-after.json"
node scripts/benchmark-metadata-mapping.mjs --compare ".bench/metadata-before.json" ".bench/metadata-after.json" --out ".bench/metadata-comparison.json"
```

`npm test`本身會build，這是現有script；不改package。完整suite是驗收命令，不要求mid-flight反覆執行。已知win32 M26 path coverage／M36 chmod失敗需依現有STATUS標註，不把它們稱為本批新增或吞掉；不得以此拒跑受影響路徑，亦不得宣稱full suite零失敗。與baseline相比不得新增失敗。

可額外跑現有FTS benchmark作周邊回歸，**不能代替以上新driver**：

```powershell
npm run benchmark:ngram -- .bench/ngram-after.json
```

### 12.3 Workbench smoke（不只單元測試）

現有protected HTTP smoke命令：

```powershell
node --test --test-concurrency=1 --test-name-pattern="independent Trace UI" dist/test/m39.test.js
```

另用§10.1真實隔離fixture啟動 `createWorkbench({databasePath,port:0})`：

1. `origin=new URL(handle.url).origin`，取得handle.token。
2. POST `/api/search`，headers `content-type:application/json`、`origin`、`X-LocalDocSearch-Token`；body `{query:'needle-739',mode:'phrase',page:1,pageSize:20,field:'all',sort:'relevance'}`。
3. 預期200、total=1、完整result projection等於CLI/API baseline、trace為§10.1 AFTER counts。
4. 再搜尋filename-only與不存在詞，檢查0正文讀取；GET `/api/traces?type=search&limit=10`帶token，最新JSON有metrics且不含正文。
5. 用實際瀏覽器開handle.url，搜尋`needle-739`、查看snippet/location、開Trace頁raw JSON；保存觀測值／截圖路徑，console/page errors應為0。不得開真實UI自動index來作benchmark。
6. `finally await handle.close()`再清理fixture。不存在UI改碼，仍要證明經Workbench的真實搜尋路徑沒有被storage改動破壞。

smoke若以throwaway script完成，交付前移除script；保留非敏感measurement與證據。

## 13. Risks / rollback

| 風險 | 固定處理／禁止事項 |
|---|---|
| 完整block／phrase漏搜 | E必須由S的全部mapping得到；不能只讀C；保留ordinal順序與pending重建 |
| INNER JOIN隱藏損壞 | 使用selected-preserving LEFT JOIN及null membership；錯誤不可變成空結果 |
| heading／all-terms／ranking | 不改caller candidate policy或rankDocument；用BEFORE/AFTER完整projection驗證 |
| SQL variable limit | 每statement固定3／4參數，seed用json_each；不展開IN (?,...,?)。**batch size：不使用batch**，整個文件candidate JSON一次送入；33,001 regression必須通過 |
| 大candidate JSON | 有限於該文件candidate ordinals，去重一次、stringify一次、兩statement重用；不把百萬block IDs序列化。不得新增任意截斷上限 |
| SQLite planner災難 | reverse join必須指定既有document_payload_blocks_document_block；未指定變體本次120s逾時。EXPLAIN需見doc+block兩欄lookup，不接受只doc範圍nested scan |
| 現有index缺失 | 支援schema已有該index；不在readonly search偷偷建立。若真實DB缺失，保留SQLite錯誤／回報schema異常，不catch成空結果、不自行加DDL；已確認標準migration與現有 index plan |
| memory／temp B-tree | CTE statement-local，完成即釋放；Map只存selected metadata，Q1 rows不可另存於search session；不保留兩份ID集合。報maxRSS；SQLite暫存可能spill，不能宣稱零額外記憶體 |
| 大block／dense S | 全部讀完；本階段不保證所有query大幅加速；dense fixture＋真實SPEC workload驗證兩次selected計算成本 |
| no-result／小query固定成本 | filename與postings空保持lazy不進Q1；no-result與稀疏query需過§14門檻 |
| concurrent writer／snapshot | 沿原statement一致性與SearchSession data_version行為，不新增long read transaction；benchmark任何data_version變更作廢 |
| timing分類改變 | Q1/Q2吸收mapping、Map提早進lookup；比較SQL sum／wall，不只獨立mapping欄歸零 |

Rollback：沒有schema／資料migration，不需要rebuild／回復索引。若correctness不過，不合併；若performance門檻不過，保留本機報告並回復本批production retrieval／新增counter改動到baseline（只回復自己的變更，不使用破壞其他工作的大範圍reset）。保留診斷報告／SPEC與有意義的baseline regression。不要以永久feature flag、雙套search implementation或保留舊SQL production fallback作交付。重新設計須回報planner，不由低階模型自行加入excluded features。

## 14. Definition of Done／Success criteria

### 14.1 Correctness（全部必須）

- 同一dataset完整result total、ordered paths、ranking、snippets、stable references與BEFORE完全一致，所有頁均比較。
- 完整payload closure／bytes／block content／order不變，跨payload phrase不漏，無新corrupt payload讀取或被吞掉的錯誤。
- §10新測試及受影響既有測試通過；完整suite相較已知baseline無新增regression；平台既有失敗如實記錄。
- 沒有偷偷改Bloom、FTS、ranking、compression、snippet讀取策略、結果limit或schema。

### 14.2 Structural（全部必須）

- §10.1 ranking metadata **256→2**，first-page metadata **513→4**；standalone mapping ranking **2→0**、page **4→1**；payload reads仍2／3。
- 相同真實snapshot `SPEC.md` ranking metadata **1,652,374→1,442,468**、standalone mapping **1,442,468→0**，payload reads仍4,638、expansion31、logical owners仍1,442,468。
- 沒有獨立selected-ID `.all()`陣列／Set／block-ID JSON往返；SQL內部mapping工作仍披露，不能用改metric名稱假造row下降。
- `測試` ranking metadata不下降是預期，不得為此改短詞full fallback。Snipaste ranking metadata不下降同樣預期；page可以因selected metadata而下降。

### 14.3 Runtime（相對門檻，不承諾固定ms）

使用§11同一snapshot／runtime／3 warmup＋10 samples：

- 主要工作負載 `SPEC.md` **completed payloadLookup p50 ≤ BEFORE×0.90**（至少10%改善）；同時外側wall total p50不得增加超過5%。第二組完整配對實測為 `0.804×` 與 `0.889×`，達標。
- `測試` total p50／p95 不得增加超過 `max(BEFORE×10%, 50ms)`。
- 稀有query total p50／p95 不得增加超過 `max(BEFORE×10%, 10ms)`；不存在詞不得增加超過 `max(BEFORE×10%, 5ms)`。
- process maxRSS 不得增加超過 `max(BEFORE×10%, 32MiB)`；需同樣sample順序與process生命周期。
- 任一門檻未達時，按§11重跑一組完整配對排除噪音；第二組配對已完成且 SPEC、測試、稀有 query、不存在詞與 maxRSS gates 均達標。不得偷偷降低門檻、挑最好sample或擴大scope。

### 14.4 交付

- 實際命令、完整BEFORE/AFTER/ratio表、raw samples、result hashes、SQL plans、memory、測試輸出及Workbench smoke證據均可定位。
- 文件用繁體中文，query/SQL/API保留原文；不提交機密正文／paths/snippets。
- 暫時scaffold/script清除，正式benchmark driver保留；不提交baseline dist／真實DB／node_modules。
- 狀態與handoff如實更新；package不升版，不把本機win32當公司Windows人工驗收。

## Implementation Checklist

- [x] 閱讀本文與AGENTS指定文件，確認只做metadata／mapping scope。
- [x] 核對實際source anchors、schema、既有indexes；查store／trace exported references。
- [x] 先新增§11benchmark driver，freeze baseline dist，取得同snapshot BEFORE 3＋10與完整result hashes。
- [x] 將實際DB EXPLAIN保存；確認反向doc+block lookup，禁止未指定index的災難變體。
- [x] 實作Q1 selected-preserving LEFT JOIN與private metadata helper。
- [x] 實作Q2 complete owning-block payload closure；只使用既有index、固定JSON參數。
- [x] streamBlocksFor明確區分undefined、[]、empty selected、nonempty selected；保持lazy。
- [x] 移除filtered full metadata、獨立mapped-ID materialization、Set與block-ID JSON；不改full path。
- [x] 保留selected missing-metadata marker、inline legacy排序、Brotli/JSON錯誤與fragment重建順序。
- [x] blockSource／snippet reread、rankDocument、Bloom／FTS／matchingPassages保持原策略。
- [x] 新增candidatePayloadOrdinals、owningBlocksFound、blockExpansionInputPayloads；保留所有diagnostics並披露計時歸類。
- [x] 加入已驗證的256-block／2-seed fixture與明確row減量assertions。
- [x] 加入single／2／large block、duplicate ordinal、cross-boundary與shared-payload correctness cases。
- [x] 補heading／filename／body／phrase／all-terms／short／long／no-result／ranking／snippet／reference／total驗證。
- [x] 補corrupt unrelated與selected payload、empty-map／[]／missing metadata／inline fallback測試。
- [x] 執行build、focused payload/block、diagnostics、相關semantic tests與完整suite；逐項記錄結果。
- [x] 執行AFTER 3＋10與compare，核對結構門檻、runtime／RSS門檻與完整result hashes。
- [x] 執行真實Workbench HTTP與瀏覽器smoke，保留證據；不改UI或對真實庫觸發index。
- [x] 更新SPEC／D080／STATUS／USER-GUIDE／CURRENT／0.37.0 handoff／validation，附BEFORE/AFTER報告。
- [x] 清除暫時工具與baseline產物，核對沒有excluded scope、schema migration、cache、截斷或雙套production實作。
- [x] Definition of Done 已完成；完整 `npm test` 仍如 validation 所記有兩個既有 win32 environment failures，非本批 regression，不能宣稱全套零失敗。
