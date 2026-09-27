# Seekah 搜尋：Architecture options、性能上限、prototype 計畫與開發規則

日期：2026-09-27。前置文件：現況架構、問題分析、prior-art gap。
本文**不選 winner、不寫 implementation SPEC**。所有時間都是依既有量測推導的**範圍估計**，必須由 §4 的 prototype 驗證；推導依據寫在每個數字旁邊。

共用的成本模型（來自 `SPEC.md` 的 09-27 實測，同一台機器）：

| 每 byte 成本（解壓後 JSON） | 實測 | 推得吞吐 |
|---|---|---|
| Brotli 解壓 | 1,289 ms／285 MB | 約 220 MB/s |
| UTF-8 decode＋`JSON.parse` | 1,290 ms／285 MB | 約 220 MB/s |
| NFKC＋小寫＋`includes` | 2,174 ms／285 MB | 約 130 MB/s |
| payload blob 讀取 | 1,012 ms／61.8 MB 壓縮 | 約 60 MB/s（含 native→JS copy） |

只要工作量與「候選文件 bytes」成正比，這四項合計就是一個無法用 SQL 優化消除的下限：**約 20 ms／每 MB 解壓後的 JSON**。

---

## 1. Options

### Option A — 保留目前架構，做戰術性優化

**Expected architecture**：不動 schema，或只做小幅調整。可能的 tactics（只列出，不實作）：
- A1：heading 命中改由 `blocks.heading`（明文、未壓縮）以 SQL 判斷，讓 phrase mode 找到第一個 content 命中就提早停止（保留 rank 語意）。
- A2：payload Bloom 改成依文字量配置（約 10 bits／gram、k≈7，等同 09-19 原型的參數），並把 ANY 改成「payload ∪ 相鄰 payload 含全部 trigram」。需要另外證明跨界不漏。
- A3：在 postings 存在時停止讀 document Bloom（P10）；把 `field` 下推，讓 `field=filename` 不讀 Bloom（P9）。
- A4：降低每 byte 成本：ASCII-only block 跳過 NFKC、以 binary framing 取代 JSON、以 `worker_threads` 平行解壓（降延遲、不降總工作量）。
- A5：若候選中的相同大小文件確實是重複內容（目前只是推測），以內容 hash 讓驗證只做一次。

| 項目 | 評估 |
|---|---|
| Expected latency shape | 仍是 **O(候選文件 bytes)**。A1 只對已命中的文件有效；false-positive 文件（`SPEC.md` 有 59 份）仍然要讀全文。A2 對 ≥3 字有效，對 1–2 字無效 |
| Short query behavior | 不變（全文） |
| Index size impact | 約 0；A2 會讓大型文件的 payload Bloom 變大，可以拿掉 230 MiB 的 document Bloom 來抵銷 |
| Migration complexity | 低（A2 需要重建 payload Bloom，可沿用逐文件 marker） |
| Implementation complexity | 低到中 |
| Portability | 不變 ✔ |
| Risks | A2 跨界語意容易出錯；成果受候選文件大小支配，換一份資料就可能失效；常見詞（P8）完全不改善 |
| Survives | 全部 |
| Deleted | 可能只刪 document Bloom |

### Option B — 目前的 FTS5 `detail=none` 改成 payload 級 postings（仍無 positions）

**Expected architecture**：FTS row 從「一份文件」改成「一個 payload」（rowid 對應 `(document_id, payload_ordinal)`，需要一張 id 對照表）。trigram／unigram 仍是 AND。跨 payload 的片語需要查「payload i ∪ i+1」的組合，或在 row 內附加下一個 payload 的前 N 字元（N 會限制可查的片語長度）。取代 payload Bloom。

| 項目 | 評估 |
|---|---|
| Expected latency shape | O(**含有全部 query gram 的 payload** bytes)。對稀有組合可能有好幾倍改善；對常見 trigram（`spe`、`pec`）與 CJK 常用字，64 KiB 窗口（CJK 約 2 萬字元）幾乎一定全部含有，改善有限 |
| Short query behavior | unigram AND 以 payload 為單位：在中文大型文件中，「測」「試」兩字同時出現在同一個 2 萬字窗口的機率很高 → 接近全文 |
| Index size impact | 比文件級大（同一文件內的 gram 不再只算一次）。粗估 1.2–2 倍於現有 FTS 表，需要實測 |
| Migration complexity | 中：需要解壓所有 27,468 個 payload 一次，建立 row；可沿用逐文件 marker |
| Implementation complexity | 中（跨界組合、rowid 對照） |
| Portability | ✔（同樣是 FTS5） |
| Risks | 仍然需要讀 payload 才能驗證、找出 block、做排序；「驗證是 authority」的結構不變；跨界邏輯是新的錯誤來源 |
| Survives | parser、blocks、payload 儲存、mapping、驗證器、ranking、snippet |
| Deleted | payload Bloom；文件級 FTS（或保留給 all-terms） |

### Option C — block 級 SQLite FTS5（依 positions 分兩個變體）

**Expected architecture**：FTS row = 一個 block 的 content（rowid = `blocks.id`，經 `blocks` join 回 `document_id`）；heading 與 filename 另外建獨立的小表（heading 依「文件＋不同 heading」去重；filename 每份文件一列），欄位因此天然分開。所有文字都以 NFKC＋小寫寫入（與現在相同）。

- **C1：block 級、`detail=none`**。trigram AND 的範圍縮小到一個 block（一行、一格、一段、一頁）。對小 block 來說 AND 已經非常接近 phrase；少數大 block（786 個跨 payload 的 block、長段落、PDF 頁）仍需驗證。1 字查詢以 unigram token 做**精確**判斷（1 字 substring 等於該 code point 出現在 block 內，不需要相鄰資訊）；2 字查詢另建 **bigram token**（同樣精確，不需 positions）。
- **C2：block 級、`detail=full`**。trigram phrase＝連續子字串（見 PRIOR-ART-GAP §6 實測）；2 字可用 unigram phrase（`detail=full`）或 bigram token。索引本身就能證明命中。

查詢流程（兩者相同的部分）：
```text
normalize → FTS 查 content / heading / filename 三張表 → 命中的 block ids
→ JOIN blocks 取 document_id（+ ordinal）→ 以 SQL GROUP BY document_id 算出 rank 訊號
  （filename 命中、有 heading 命中、有 content 命中、代表 block = 最小 ordinal）
→ 以 rank、mtime、path 排序 → total = 文件數
→ 驗證（C1：只驗證代表 block，失敗再換下一個；C2：只在 tokenizer folding 可能與 NFKC 不一致時驗證）
→ page：只為本頁 ≤20 個代表 block 讀 owning payload → makeSnippet（沿用）
```

| 項目 | C1（block, `detail=none`） | C2（block, `detail=full`） |
|---|---|---|
| Expected latency shape | O(posting 長度)＋O(命中文件數，SQL 聚合)＋O(驗證的代表 block bytes)＋O(本頁 snippet) | O(phrase 中所有 token 的 position list 長度)＋SQL 聚合＋snippet；驗證接近 0 |
| Short query behavior | 1 字：unigram token 精確；2 字：bigram token 精確；成本等於 posting 長度。常見 1 字的問題移到「命中文件數非常大」（需要 top-K／計數策略，見 D） | 同左；也可以用 unigram phrase |
| Index size impact | 比目前文件級大（同一文件內重複的 gram 會在不同 block 各算一次）。估計約為 0.5–1.5 倍的正規化文字量，**必須實測**。可以拿掉約 257 MiB 的 Bloom 與目前的文件級 FTS 來抵銷 | positions 很大：官方範例 full／none ≈ 5.5×；Zoekt 的 positional trigram 約為語料的 2 倍。本庫粗估可能多出數 GB，**這是 C2 最大的風險，必須實測** |
| Migration complexity | 中：解壓全部 payload 一次、逐文件建表（沿用 `migrateNgramIndex` 的逐文件 marker 與可取消模式）；遷移期間舊路徑作為 fallback | 同左，但寫入量更大 |
| Implementation complexity | 中：三張 field 表、SQL 聚合、代表 block 驗證、刪除時清理 block rows | 中：同左，再加上 folding 等價的論證 |
| Portability | ✔ 只用 `node:sqlite` 內建 FTS5，沒有新相依 | ✔ 同左 |
| Risks | 大 block 仍需要讀取；bigram 字彙量（CJK）很大；posting 讀取量對常見 gram 仍很高；5.3M rows 的寫入時間 | 索引大小；FTS5 phrase 無法挑最稀有的 trigram，常見 trigram 的 position list 會全部被讀；刪除成本 |
| Survives | parser、`TextBlock`、`documents`（stable reference）、`blocks`、payload 儲存（降為 snippet／context 用的 docstore）、mapping（給 snippet 用）、root 管理、migration 框架、trace、SearchSession、`makeSnippet`、rank 語意 | 同左 |
| Deleted | `document_blooms`、`document_payload_blooms`、Bloom 程式、文件級 unigram／trigram 表、「對整份文件逐 block 驗證」的熱路徑 | 同左 |

### Option D — 自建 positional unigram／bigram／trigram postings（放在 SQLite 表中）

**Expected architecture**：以一般 SQLite 表存 posting，例如 `(gram, segment) → 壓縮 blob（block_id delta＋offset delta）`，由 JS 編解碼。查詢規劃器仿照 Zoekt：挑頻率最低、且不重疊的兩個 gram，做距離檢查，再以 block 為單位輸出。短查詢以 unigram／bigram 為 term。

**D-lite 變體**（先評估）：沿用 C2 的 FTS5 `detail=full`，以 `fts5vocab(…,'row')` 取得 gram 的文件頻率，選出最稀有的 2 個 trigram，再用 `fts5vocab(…,'instance') WHERE term=?` 取出它們的 offset，在 JS 做距離檢查。不讀常見 gram 的 position list。這樣可以用 FTS5 的儲存換取 Zoekt 的選擇性，而不必自建儲存格式。

| 項目 | 評估 |
|---|---|
| Expected latency shape | O(最稀有兩個 gram 的 posting 長度)，最接近 Zoekt；常見 trigram 不再支配成本 |
| Short query behavior | unigram／bigram term，精確；常見 1 字仍受命中數支配 |
| Index size impact | 自訂壓縮可以比 FTS5 小，也可能更大；D-lite 與 C2 相同 |
| Migration complexity | 高（全新格式、merge／compaction、刪除） |
| Implementation complexity | **高**：等於重寫一個 inverted index（segment、merge、delete、crash safety）。D-lite 為中 |
| Portability | ✔（純 JS＋SQLite） |
| Risks | 自創資料結構，正是 PART 10 規則要攔下的情況；維護成本；fts5vocab instance 在大 list 上逐列回傳 JS 物件的開銷未知 |
| Survives | 與 C 相同 |
| Deleted | 與 C 相同，另外可能不需要 FTS5 表 |

### Option E — 外部搜尋引擎 sidecar（Tantivy／Zoekt／Xapian）

**Expected architecture**：Node 以子程序啟動一個本機 binary（不是 service），parser 仍在 Node。文件（或 block）送進 sidecar 建索引；查詢回傳 (document id, block id, positions)；snippet 仍由 Seekah 的 payload 讀取。

| 項目 | Tantivy | Zoekt | Xapian |
|---|---|---|---|
| Latency shape | ngram＋positional phrase，top-K；以成熟度而言最好 | positional trigram，最適合 substring | positional，但非 CJK 以詞為單位 |
| Short query | ngram tokenizer（min 1） | brute force（需要未壓縮內容） | CJK unigram＋bigram |
| Index size | positions＋（可選）docstore；中到大 | 約 3–3.5 倍語料，而且另存一份未壓縮內容 | 中 |
| Migration | 全量重建，約 1.7 GB 文字 | 全量重建；增量模型是 shard 重建 | 全量 |
| Implementation | 中：需要自己的 Rust wrapper binary、IPC、生命週期 | 中：Go binary，要把 235K 份文件映射到 shard | 高：原生綁定 |
| Portability | 需要簽章的 Windows x64 binary；企業 AppLocker／AV 未知 | 同左 | 更差 |
| Risks | **兩個 store 沒有共同 transaction**：崩潰一致性要靠重播；read-only CLI／MCP 需要 sidecar 在跑；公司政策；exact NFKC 語意要由 Seekah 前處理 | 同左，另外 substring 以外的欄位與排序要自己補 | **非 CJK 的 substring 語意不符** |
| Survives | parser、documents、blocks、payload（snippet）、UI／CLI／MCP | 同左 | 同左 |
| Deleted | Bloom、FTS 表 | 同左 | 同左 |

**與 C 的差別**：E 用「成熟的實作」換來「新的部署與一致性風險」；C 用「已經在用的成熟實作的另一種模式」，幾乎沒有新的部署風險。依 PART 10 規則，C／D-lite 應先被證明不足，才考慮 E。

---

## 2. Performance ceiling（PART 8）

基準：同一個 235,463 份文件的 store、同一台機器；目前（metadata 修正後）的 p50 為 `SPEC.md` 12.2 s、`測試` 5.2 s、Snipaste 0.59 s、不存在詞 0.042 s。

### 2.1 Current＋SQL cleanup only

- 已實作的修正：`SPEC.md` 0.889×。
- 若 lookup SQL 完全歸零（只剩 blob 讀取）：下限＝blob 1.0＋Brotli 1.2＋JSON 1.3＋NFKC／includes 2.2 ≈ **5.5–6 s**，加上尚未歸因的重建／迴圈（0–2.8 s）。
- `測試`（154 MB）：約 3–4 s。Snipaste（29 MB）：約 0.5 s。
- **瓶頸**：候選文件 bytes × 每 byte 成本。**上限約為目前的 0.45–0.65×。** 常見詞無改善。

### 2.2 Current＋true payload-level postings（仍無 positions）

- 讀取量＝含有全部 query gram 的 payload。`SPEC.md` 的 47 份命中文件本來就需要讀到命中處；59 份 false-positive 文件中，只有同一 payload 內 5 個 trigram 都湊齊的部分會被讀。
- 估計：`SPEC.md` 約 1–6 s（取決於 `c.m`、`.md` 在大型文件中的分佈，未量測）；`測試` 約 2.5–4 s（64 KiB 窗口對常用 CJK 字幾乎沒有選擇性）；稀有詞約 0.05–0.3 s。
- **瓶頸**：仍然是 O(被選 payload bytes)，而且驗證、定位、排序都還要讀正文；常見詞與 1–2 字問題不變。

### 2.3 Position-aware block-level search（C2，或 C1 加上代表 block 驗證）

Query hot path 變成：
```text
FTS posting 讀取（content／heading／filename）
→ block → document 聚合（SQL）
→ 排序
→ ≤20 個代表 block 的 payload 讀取（snippet）
```
- `SPEC.md`：posting 讀取量取決於 `spe`／`pec`／`ec.`／`c.m`／`.md` 的出現次數（FTS5 phrase 會讀全部 5 條 position list；D-lite 只讀最稀有的 2 條）。估計數十到數百 ms；聚合幾 ms；snippet 讀 20 個 payload（約 0.3 MB 壓縮／1.2 MB 解壓）約 20–60 ms。**估計 0.05–0.5 s**。
- `測試`：bigram token（C1）或 unigram phrase（C2）；估計 0.02–0.3 s。
- 稀有詞：posting 很短，由 snippet 支配，約 10–50 ms。
- 常見 1 字（例如「的」）：posting 本身就很長（可能百萬級 block），命中文件數數萬以上。**瓶頸轉移到結果集大小**：SQL 聚合＋排序數萬份文件，估計 0.5–5 s。需要另外決定 total count 與 top-K 的產品語意（例如先算數量、排序只取前頁，或是採用近似）；這是產品決策，不是索引問題。
- **瓶頸來源**：posting 長度與命中文件數，而**不再是候選文件的大小**。這是 Zoekt／Lucene／Tantivy 的延遲形狀。

| 查詢 | 目前（p50） | SQL cleanup 上限 | payload postings | position-aware block |
|---|---:|---:|---:|---:|
| `SPEC.md` | 12.2 s | 5.5–8 s | 1–6 s | 0.05–0.5 s（估） |
| `測試` | 5.2 s | 3–4 s | 2.5–4 s | 0.02–0.3 s（估） |
| 稀有（Snipaste） | 0.59 s | ~0.5 s | 0.05–0.3 s | 0.01–0.05 s（估） |
| 常見 1 字 | 未量測（外推為數十秒以上） | 同左 | 同左 | 0.5–5 s（估，受結果數支配） |

（表中所有估計都必須由 §4 的 prototype 取代。）

---

## 3. 共同的正確性前提（任何方案都必須滿足）

1. exact substring：NFKC＋`toLowerCase()` 之後，在**單一 block 的 heading 或 content 內**連續出現；filename 另外判斷。跨 block 永遠不命中（沿用現況）。
2. 索引只能產生「超集合」，或者必須證明它與 (1) 等價。FTS5 trigram／unicode61 的 case folding 是逐 code point 對應，套在已經正規化的文字與查詢上只會多出候選，不會漏；但這仍需要以差分測試證明。
3. rank 語意不變：檔名完全相同 4 > 檔名包含 3 > heading 2 > content 1；同分依 mtime、path；all-terms 的覆蓋度規則；代表 block＝最小 ordinal 的 heading 命中，否則最小 ordinal 的 content 命中。
4. stable reference（`documents.id`）不變；增量 upsert／delete 在同一個 SQLite transaction 內；read-only 開啟不寫入；migration 可中斷、可接續。

---

## 4. Prototype／benchmark 計畫（PART 9；disposable、不動 production）

### 4.1 隔離方式

- 把真實 `index.db` 以唯讀方式**複製**成 snapshot；所有 prototype 表都建在複製檔（或 `ATTACH` 的另一個檔案），絕不寫入 production index。
- prototype 程式放在 `scripts/prototype-search/`（或 repo 外），**不 import 也不修改 `src/`**；以 A（目前 build）作為結果的 oracle。
- 每個 variant 各自用獨立的 Node process 執行；3 次暖機＋10 次量測；另做一次「新複製檔、首次開啟」的冷啟動量測（Windows 無法可靠清 OS cache，因此以新檔案近似，並註明）。

### 4.2 Variants

| 代號 | 內容 |
|---|---|
| **A** | 目前 local build（metadata 修正後），不改 |
| **B** | payload 級 FTS5 `detail=none`（trigram＋unigram），跨界以 i ∪ i+1 處理 |
| **C1** | block 級 FTS5 `detail=none`：content trigram＋unigram＋bigram token；heading、filename 分表 |
| **C2** | block 級 FTS5 `detail=full`：content trigram（phrase）；2 字用 unigram phrase；1 字用 unigram token；heading、filename 分表 |
| **D** | 短查詢策略比較：(d1) unigram AND（現況）、(d2) block 級 unigram token＋bigram token（`detail=none`）、(d3) unigram phrase（`detail=full`）、(d4) D-lite：fts5vocab 挑最稀有兩個 trigram＋JS 距離檢查 |

### 4.3 查詢集（從真實 store 以統計方式挑選，不靠手選）

以既有 `search_unigrams`／`search_trigrams` 的 `fts5vocab(…,'row')` 取得文件頻率，依百分位挑詞，並把挑選規則與 seed 寫進報告：

| 類別 | 挑選規則 |
|---|---|
| common 1-char CJK | 文件頻率最高的 CJK 字 |
| rare 1-char | 文件頻率 1–5 的字元 |
| common 2-char | 常見 CJK bigram（例如「測試」，另加一個統計挑出的） |
| rare 2-char | 文件頻率 ≤5 的 bigram |
| common 3-char | 文件頻率前 1% 的 trigram |
| rare 3-char | 文件頻率 ≤5 |
| long phrase | 從真實 block 取出的 20–60 字片段（確定命中） |
| `SPEC.md` | 固定 |
| filename-only | `field=filename`，用常見的檔名片段 |
| heading-only | 只出現在 heading 的詞（以 `blocks.heading` 驗證） |
| body-only | `field=content` |
| all-terms across blocks | 兩個詞在同一文件、但從未出現在同一 block |
| nonexistent | 隨機 token＋一個 trigram 全部存在但連續字串不存在的構造詞 |
| cross-64KiB boundary | 從 span≥2 的 block 取出跨越 payload 邊界的片段 |

另外加一組**差分測試**：從真實 block 隨機抽 1,000 個長度 1–12 的子字串（含 CJK、標點、料號、全形／半形、合字、`İ`、希臘 final sigma 等 NFKC／大小寫敏感字元），加上 1,000 個不存在的字串；要求每個 variant 的結果集合與 A 完全相同。

### 4.4 Metrics（每個 variant × 每個查詢）

```text
build time · migration time (含中斷後接續) · index bytes（dbstat，逐表）· RSS（max/sampled）
query p50 · p95 · cold
posting rows visited（FTS rowids 或 instance rows）· candidate docs · candidate blocks
payload reads · compressed bytes · decompressed bytes · exact verification count
result hash · ranking equivalence（依序比對 (reference, rank, ordinal, sourceKind)）
snippet equivalence（第 1 頁與最後一頁 snippet 文字 hash）
```

build／migration 另外測：逐文件 marker 在 `kill -9` 後接續、upsert／delete 1,000 份文件後結果仍與全量重建一致、read-only 開啟未完成的索引時會 fallback。

### 4.5 結束條件

prototype 只產出：一份 JSON 報告、一份比較表、一份「哪些假設被推翻」的清單。**不產生 production 程式碼。** 是否進入 ADR，由報告與 §5 的 gate 決定。

---

## 5. 正式開發規則（PART 10）

> **任何新的搜尋架構重大決策，先做 prior-art review；在沒有證明成熟方案不適用之前，不允許自己發明新的資料結構。**

「重大決策」的定義：新增或改變任何候選／索引資料結構（posting、Bloom、summary、mapping）、改變 exact match／ranking／snippet 的單位、改變正文儲存格式或壓縮單位、引入新的相依或程序。

### Gate（依序；每一項都要有指定的產出物，缺一項即不得進入下一項）

| # | Gate | 通過條件（證據） | 產出物 |
|---|---|---|---|
| 1 | [ ] Current architecture documented | 由程式碼還原（檔案／函式／表／粒度），區分 GitHub baseline 與 local | `*-CURRENT-*-ARCHITECTURE.md` |
| 2 | [ ] Root cause measured | 每個瓶頸都有 symptom／immediate／architectural 三層，並有 row、bytes、count 的量測（不接受只有 ms） | problem analysis＋raw JSON |
| 3 | [ ] At least 3 mature systems reviewed | 至少 3 個，其中至少 1 個與問題最接近（此案為 Zoekt／FTS5） | prior-art 文件 |
| 4 | [ ] Official sources cited | 每個關於外部系統的主張都附官方文件、原始碼或原作者文章的連結；不以 SEO 部落格作主要證據 | 同上 Sources |
| 5 | [ ] Direct reuse evaluated | 對每個系統逐一回答「實作能否重用／架構能否重用」；自建之前，必須寫出每個成熟方案被否決的**量測或約束**理由 | reuse 表 |
| 6 | [ ] Constraints documented | 逐條對照 Seekah 約束（local-only、Node、Windows 無 admin、無原生擴充、parser、stable reference、NFKC、CJK、增量、crash-safe、read-only） | constraint 表 |
| 7 | [ ] Representative prototype built | disposable、不 import／修改 `src/`；變體涵蓋現況＋至少 2 個成熟方案式設計 | prototype 腳本 |
| 8 | [ ] Real large-store benchmark run | 在真實大型 store（目前為 235K 份）的 snapshot 上；包含大型文件、1／2 字、常見／稀有、跨界；同時量 I/O 與 bytes，不能只看 hit-set | benchmark JSON |
| 9 | [ ] Correctness equivalence proven | 結果集合、排序、snippet 與 oracle 完全相同；差分測試 ≥1,000 個隨機子字串；migration 中斷／接續、增量 upsert／delete 等價 | equivalence 報告 |
| 10 | [ ] Architecture ADR approved | ADR 列出被否決的 options 與理由、預期上限、風險、rollback；使用者核准 | `DECISIONS.md` 新條目 |
| 11 | [ ] Implementation SPEC written | 在 ADR 核准之後才寫；沿用 SPEC 格式 | `SPEC.md` 新章節 |

### 附加規則（依本次 audit 的教訓）

- **參數一致性**：benchmark 用的參數（例如 Bloom 的 bits／element 與 k）必須與要上線的參數相同；不同就重跑。
- **量對的維度**：候選器的比較必須同時報告「文件內定位」的成本（payload reads、解壓 bytes、驗證的 block 數），不能只報告文件候選數。
- **規模外推禁止**：小資料的結論只能用於排除選項，不能用於選定選項。
- **warning 追蹤**：實驗文件中每條「限制／尚需驗證」都要進 `NEXT-TODO.md`，並在後續 ADR 中標明是否已處理。
- **Bloom／summary 類結構**必須附 false-positive 率的實測，以及它在最大文件上的飽和度。
