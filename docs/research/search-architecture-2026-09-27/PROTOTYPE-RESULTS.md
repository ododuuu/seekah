# Seekah 搜尋架構 Prototype 結果（A／B／C1／C2／D）

日期：2026-09-27。依 `PROTOTYPE-HANDOFF.md` 與 `SEEKAH-SEARCH-ARCHITECTURE-OPTIONS.md` §4 執行。性質：研究結果，**不是 ADR、不是 implementation SPEC**；沒有修改 `src/` 或產品行為。

原始資料：`prototype/prototype-summary.json`（結構化結果，不含正文、抽樣查詢文字或路徑）、`prototype/bench.csv`（延遲 benchmark）。程式：`scripts/prototype-search/`（說明見其 `README.md`）。

## 0. 結論

1. **正確性**：五個版本在 2,000 個查詢上的結果集合、排序、rank、代表 block、heading／location 以及第 1 頁與最後一頁 snippet，**全部與暴力 ground truth 完全相同**。唯一例外是 A（現行產品）遇到含 NUL 的查詢會丟出 `unterminated string` 錯誤（產品既有 bug，見 §7.1）。
2. **效能**：C2（block 級 `detail=full`）完全不需要在排序前讀正文。`SPEC.md` 從 12.8 s 降到 4 ms，`測試` 從 5.2 s 降到 2 ms，常見 trigram `ing`（20,296 筆結果）從 39.5 s 降到 0.86 s。
3. **大小**：C2 是最大的風險。搜尋結構 2.36 GiB，整個 store 估計 3.33 GiB（目前 1.37 GiB 的 2.4 倍）。若把 C2 的 `detail=full` unigram 表換成 C1 的 unigram／bigram token 表（兩者對 1／2 字都精確），搜尋結構是 1.91 GiB，store 約 2.88 GiB（2.1 倍），延遲不變。
4. **成本模型**：「延遲與候選 bytes 成正比」在 A 上成立（R² 0.98），但斜率是 **約 42 ms／MB**，不是研究文件估的 20 ms／MB。單一文件的驗證成本除了 bytes，還與 block 數有關（每 block 約 4.4 µs）。
5. **建議進 ADR**：**C2-hybrid**：content 用 block 級 FTS5 trigram `detail=full` phrase，1／2 字用 C1 的 `detail=none` unigram／bigram token，檔名與 heading 分表。C1 作為「大小預算不夠時」的備案。B 與 D（fts5vocab 挑最稀有 trigram）不建議。詳見 §8。

## 1. 範圍與方法

| 項目 | 內容 |
|---|---|
| 資料 | 使用者真實 store 以 SQLite backup API 取得一致 snapshot（1,466,884,096 bytes；235,463 documents、5,313,248 blocks、27,468 payloads）；snapshot 設為唯讀。其中 18,096 份有正文，216,702 份是 unsupported（只有檔名） |
| 隔離 | 每個版本各自一個 `.db`，放在儲存庫外的 `C:/Users/mains/seekah-prototype-data/`；查詢時以 read-only 開啟 snapshot 並 `ATTACH`。A 直接使用已編譯的產品 `dist/src`；其他版本只重用產品的 `makeSnippet()` |
| 搜尋範圍 | phrase mode、`field=all`、`sort=relevance`、無 type／root 篩選、每頁 20 筆。**沒有涵蓋** all-terms、`field=filename／content`、其他排序 |
| 平台 | 本機 win32（Windows 11 Home）、Node.js 22.23.2、SQLite 3.51.3、i9-13980HX／32 GB。**不是公司 Windows 驗收** |
| Ground truth | `truth.mjs`：每份文件只解壓一次，逐 block NFKC＋小寫後，用 `indexOf` 對 2,000 個查詢全部檢查，規則照抄 `rankDocument()`；12 個 process 平行，約 2 分鐘 |
| 查詢集（seed 20260927） | 1,000 個真實子字串：從隨機 block（一半依 block 均勻、一半依文件均勻；12% 取 heading）抽出，長度 1／2／3／4–6／7–12 分別為 80／140／140／260／280，每層一半以 CJK 字元開頭（444 ASCII、284 CJK、161 混合、11 其他）；另有 70 個 NFKC／大小寫變形（全形、全大寫）與 30 個特殊字元（`İ`、`ς`、`ß`、`ﬁ`、合字、組合字元、半形片假名、`㍿`…）。再加 1,000 個合成字串：400 個隨機、300 個兩段真實子字串拼接、300 個 `zq…` 標記字串 |
| 延遲協定 | 每個 engine 一個新 process，依序執行、機器沒有其他 prototype 工作；每個查詢先跑一次（記為 first run），暖機到共 3 次，再量 10 次（first run > 20 s 時改為 1 次暖機＋3 次量測）；取 p50／p95。差分測試是多 process 平行執行，其中的時間不採用 |

## 2. Decision matrix

| | A 現況 | B payload 級 | C1 block `none` | C2 block `full` | D 最稀有 trigram |
|---|---|---|---|---|---|
| 搜尋結構大小 | 407 MiB | **117 MiB** | 828 MiB | 2,420 MiB | 1,959 MiB |
| 估計整個 store | 1.37 GiB | **1.08 GiB** | 1.78 GiB | 3.33 GiB | 2.88 GiB |
| 正確性（2,000 查詢） | 1,999 相同＋1 錯誤 | 2,000 相同 | 2,000 相同 | 2,000 相同 | 2,000 相同 |
| snippet（第 1／最後頁） | 相同 | 相同 | 相同 | 相同 | 相同 |
| `SPEC.md` p50 | 12,784 ms | 1,762 ms | 744 ms | **4 ms** | 70 ms |
| `測試` p50 | 5,167 ms | 959 ms | **2 ms** | **2 ms** | **2 ms** |
| 常見 trigram `ing` p50 | 39,530 ms | 22,071 ms | 5,899 ms | **855 ms** | 6,991 ms |
| 2,000 查詢合計解壓 | 353.9 GB | 85.5 GB | 60.3 GB | **0** | 5.5 GB |
| 延遲形狀 | O(候選文件 bytes) | O(含全部 gram 的 payload bytes) | ≤2 字 O(posting)；≥3 字 O(posting＋候選 block bytes) | O(posting 長度＋命中文件數) | ≤2 字同 C1；≥3 字 O(最稀有 gram 的 instance 數) |
| 建置（完整，平行下） | 既有 | 3.3 min | 9.1 min | 7.3 min | C1＋C2 |
| kill／resume、刪除／重建 | 既有 | 等價 ✔ | 等價 ✔ | 等價 ✔ | 等價 ✔（沿用 C1＋C2 表） |
| 刪除成本（每文件，平行下） | — | 12.8 ms | 26.8 ms | 41.8 ms | — |
| 主要風險 | 常見查詢數十秒 | 常見 ASCII 仍 O(bytes) | ≥3 字常見 trigram 仍需讀大量正文 | 索引大小 | 常見 trigram 的 instance 全部進 JS，比 C2 慢 8 倍 |

（大小與正確性見 §3、§4；延遲見 §5；migration 見 §6。）

## 3. 索引大小

以 `dbstat` 逐表加總（建置後已 WAL checkpoint，未做 FTS `optimize`）。

| 結構 | 大小 |
|---|---:|
| A：文件級 FTS5（unigram＋trigram，`detail=none`） | 66.3 MiB |
| A：document Bloom | 304.8 MiB |
| A：payload Bloom | 36.3 MiB |
| 共用：檔名 tri／uni／bi token（`detail=none`） | 25.4 MiB |
| 共用：heading tri／uni／bi token＋`heading_map`（121,293 筆去重 heading） | 18.6 MiB |
| B：payload 級 trigram＋unigram＋row 對照（30,749 rows，含 boundary row） | 91.5 MiB |
| C1：content trigram `detail=none` | 361.1 MiB |
| C1：content unigram token `detail=none` | 156.7 MiB |
| C1：content bigram token `detail=none` | 265.9 MiB |
| C2：content trigram `detail=full` | 1,492.9 MiB |
| C2：content unigram `detail=full` | 883.4 MiB |

正規化後的 content 文字共 632,760,647 個 UTF-16 code unit。C2 trigram `detail=full` 約為每字元 2.5 bytes，C1 trigram `detail=none` 約 0.6 bytes。

估計 store：snapshot 扣除 A 的三項候選結構（407.4 MiB）後剩 991.5 MiB，其中 documents、blocks、payload（仍作為 snippet 與驗證用的 docstore）與 mapping 在任何版本都保留，再加上各版本的結構。

- A 1,398.9 MiB（現況）、B 1,108.5 MiB、C1 1,819.2 MiB、C2 3,411.8 MiB、D 2,951.0 MiB。
- **C2-hybrid**（C2 trigram `full`＋C1 unigram／bigram＋檔名／heading）＝ D 的索引組成 ＝ 1,959.4 MiB 搜尋結構、store 約 2,951 MiB。

尚未實驗的縮減方式（列入 ADR 前待辦）：FTS5 `optimize` 合併 segment、`columnsize=0`、以 `detail=column` 取代 unigram `full`、只對 ≥3 字建 `full` 等。

## 4. 正確性等價

| engine | 結果與 truth 相同 | 不同 | 錯誤 | snippet 相同 |
|---|---:|---:|---:|---:|
| A | 1,999 | 0 | 1（NUL） | 1,999 |
| B | 2,000 | 0 | 0 | 2,000 |
| C1 | 2,000 | 0 | 0 | 2,000 |
| C2 | 2,000 | 0 | 0 | 2,000 |
| D | 2,000 | 0 | 0 | 2,000 |

- 比對內容是完整結果清單的 hash：document id、rank、sourceKind、代表 block ordinal、heading、location，依產品排序（rank → mtime → path）。snippet 是用 truth 清單重新以產品 `makeSnippet()` 產生第 1 頁與最後一頁，逐字比對。
- 覆蓋範圍：1 字（80，含 `e`、`的` 等命中 15 萬筆的查詢）、2 字（140）、3–6 字（400）、7–12 字（280）、NFKC／大小寫（100）與合成字串（1,000）；2,000 個查詢合計 4,959,269 筆結果。
- 研究文件擔心 A 的 payload Bloom 會漏掉「只在 heading 命中」的 block。在這 2,000 個查詢中**沒有觀察到** A 漏命中（Bloom 幾乎飽和，實際上什麼都沒剪掉）。A 的問題純粹是成本。
- C2 不做任何驗證，就證明了 FTS5 trigram／unigram phrase 在已正規化文字上的 case folding（含 `ǅ`、`İ`、`ß`、`ς`）與 `NFKC＋toLowerCase＋includes` 在這個查詢集上結果一致。這是抽樣證據，不是形式證明。
- **2026-09-27 實作後更正**：產品化時的差分測試找到反例。JS 對 `ΣΟΦΟΣ` 產生 final sigma `ς`，但在 `ΣΟΦΟΣreport` 中產生 `σ`；預設 trigram tokenizer 會把 `ς` 再折成 `σ`，因此多出命中。0.38.0 改用 `trigram case_sensitive 1`（D081）。

## 5. 效能

所有 engine 對同一查詢的結果 hash 都相同。p50／p95 為 10 次量測（`ing` 的 A、B 為 3 次）。

| 查詢（結果數） | 挑選方式 | A | B | C1 | C2 | D |
|---|---|---:|---:|---:|---:|---:|
| `SPEC.md`（85） | 研究參考 | 12,784 | 1,762 | 744 | **4** | 70 |
| `測試`（96） | 研究參考（handoff 的「誤試」視為 `測試`） | 5,167 | 959 | **2** | **2** | **2** |
| `的`（586） | 最常見 CJK 字，11,548 blocks | 9,239 | 1,347 | 22 | 23 | 23 |
| `仙`（1） | 稀有 CJK 字，2 blocks | 41 | 5 | 1 | 2 | 1 |
| `ing`（20,296） | 最常見 `[a-z]{3}` trigram，719,077 blocks | 39,530 | 22,071 | 5,899 | **855** | 6,991 |
| `下列何`（10） | 最常見 CJK trigram，1,909 blocks | 521 | 244 | 107 | 70 | 73 |
| `qev`（14） | 最稀有 `[a-z]{3}`，19 blocks | 1,846 | 666 | 571 | 378 | 377 |
| `Snipaste-2.11.3-x64`（1） | 研究參考 | 583 | 75 | 7 | 7 | 33 |
| 不存在詞（0） | 研究參考 | 42 | 69 | 4 | 7 | 32 |
| `e`（156,218） | 壓力：最常見 ASCII 1 字 | 10,828 | 5,522 | 3,350 | 3,394 | 3,257 |

單位 ms，p50；p95、min／max 與 first run 見 `bench.csv`。p50 超過 50 ms 的查詢，p95／p50 都在 1.11 倍以內，唯一例外是 D 的 `ing`（p95 14.7 s，2.1 倍）。

結構量（每查詢一次）：

| 查詢 | A 讀 payload／解壓 | B | C1 | C2 | D |
|---|---|---|---|---|---|
| `SPEC.md` | 4,638／285.1 MB，59 份 FP 文件 | 366／23.5 MB | 673／46.8 MB（驗證 58 block） | 0 | 47／0.8 MB |
| `測試` | 2,601／154.1 MB | 175／8.1 MB | 0 | 0 | 0 |
| `ing` | 22,721／697.7 MB | 14,192／182.2 MB | 10,389 payload（驗證 9,897 block） | 0 | 0（但讀 199 萬 instance rows） |

觀察：

- **C2 的延遲只取決於 posting 長度與結果數**，與候選文件大小無關，符合研究文件預測的 Zoekt／Lucene 延遲形狀。`SPEC.md` 的 posting 只有 124 rows。
- **1／2 字**：C1 的 unigram／bigram token 與 C2 的 unigram phrase 同樣精確、同樣快（`測試` 2 ms、`的` 22 ms），但大小只有後者的一半（422 MiB 對 883 MiB）。這就是 §0 建議 C2-hybrid 的原因。
- **命中非常多的查詢**（`e`，156,218 筆）在所有 block 級版本都約 3.3 s。posting rows 共 4,045,731：content 3,799,754 個 block、檔名 151,147、heading 94,830。其中 content block join 回 blocks 並依文件聚合約 2.2 s，檔名與 heading 候選的明文驗證約 0.75 s。瓶頸已轉移到**結果集大小**，要改善必須做 total count／top-K 的產品決策，不是索引問題（與研究文件 §2.3 的預測一致）。
- **巨大 block 的 snippet**：`qev` 的 14 筆結果中有些位於跨上百個 payload 的 block，產生當頁 snippet 就讀了 166 個 payload（約 375 ms）。這是 docstore 的讀取粒度問題；C2 的 offset 可以只讀命中所在的 payload，尚未實作。
- **D 不如 C2**：fts5vocab `instance` 會把最稀有 gram 的每個 offset 都送進 JS。常見短 trigram（`ing`，n=3 時兩個 gram 是同一個）要讀 199 萬列，因此比 FTS5 原生 phrase 慢約 8 倍，p95 抖動到 14.7 s。對稀有查詢兩者相同。
- **B** 對 CJK 與稀有詞約有 3–8 倍改善，但 64 KiB 的 payload 窗口幾乎一定含有常見 ASCII gram，`ing` 仍要解壓 182 MB、22 s，延遲形狀沒有改變。
- 記憶體（max RSS）：A 1.7 GiB、B 0.9 GiB、C1 1.5 GiB、C2 1.0 GiB、D 3.0 GiB（D 在 JS 中保存 instance offset set）。

## 6. Migration 可行性

完整建置（4 個版本同時平行，另外有 12 個 truth process 部分重疊，因此時間偏保守）：

| 版本 | 時間 | rows | peak RSS | 主要時間 |
|---|---:|---:|---:|---|
| 檔名／heading | 31 s | 356,756 | 210 MiB | — |
| B | 3.3 min | 30,749 | 694 MiB | FTS insert 160 s |
| C1 | 9.1 min | 5,313,248 | 2.2 GiB | FTS insert 460 s |
| C2 | 7.3 min | 5,313,248 | 1.8 GiB | FTS insert 320 s |

解壓全部 27,468 個 payload 只佔 33 s。peak RSS 來自最大的 block（約 1,100 萬字元）的 token 陣列，產品化時需要改為串流 tokenizer 或分段寫入。

`migration.mjs`（前 3,000 份有正文的文件，每 50 份一個 transaction，marker 與資料同一個 transaction）：

| 版本 | 硬中斷時已完成 | resume 後與 clean build 相同 | 刪除並重建 285 份（10%）後相同 | FTS integrity-check | 每文件刪除 |
|---|---:|---|---|---|---:|
| 檔名／heading | 550 | ✔ | ✔ | ok | 9.0 ms |
| B | 650 | ✔ | ✔ | ok | 12.8 ms |
| C1 | 650 | ✔ | ✔ | ok | 26.8 ms |
| C2 | 650 | ✔ | ✔ | ok | 41.8 ms |

「相同」的判定：每張 FTS 表的 `fts5vocab(row)`（term、doc、cnt）完整 hash，加上 plain table 內容 hash。刪除沿用 `contentless_delete=1` 逐 rowid 刪除；C 系列的 rowid 就是 `blocks.id`，因此成本與文件的 block 數成正比。

## 7. 其他發現

### 7.1 產品 bug：含 NUL 的查詢

A 對長度 ≥3、含 U+0000 的查詢丟出 `unterminated string`：SQLite 在 NUL 處截斷 FTS5 查詢字串，而 `ftsMatch()` 直接把原始 trigram 放進 MATCH。只含 `\u0000` 單一字元的查詢沒問題（走 `u0` unigram token）。真實文件中確實有 NUL 字元，差分測試抽到了一個例子。本次**沒有修改產品**。prototype 的處理方式是：含 NUL 的 trigram 改用 unigram token（C2 改用 unigram phrase，仍然精確）。

### 7.2 成本模型驗證（A）

| 模型 | 係數 | R² | n |
|---|---|---:|---:|
| 查詢總時間 ≈ a + b·解壓 MB | a = 347 ms，**b = 43.4 ms／MB** | 0.980 | 83 |
| 驗證時間 ≈ a + b·MB | b = 42.0 ms／MB | 0.982 | 83 |
| ＋候選文件數 | b = 41.3 ms／MB、0.028 ms／文件 | 0.982 | 83 |
| 只看 ≥10 MB 的查詢 | b = 42.2 ms／MB | 0.970 | 22 |
| 單一文件完整驗證 ≈ a + b·MB | b = 39.7 ms／MB | 0.636 | 192 |
| 單一文件 ≈ a + b·MB + c·blocks | **b = 13.2 ms／MB，c = 4.4 µs／block** | **0.995** | 192 |

- 查詢依 A 在差分測試中的解壓 bytes，以 log₂ 分箱，每箱最多 4 個（`costmodel.mjs --queries`），依序執行，1 次暖機＋3 次量測取中位數。
- 文件依 payload 數分 6 層，每層最多 40 份（`--documents`）。使用產品的 `candidateByPath()` 完整讀取，加上 `rankDocument()` 的逐 block 正規化＋`includes`。

結論：「成本與候選 bytes 成正比」成立，但研究文件的 20 ms／MB 只是 Brotli＋JSON＋NFKC＋blob 讀取的下限，沒有計入 block metadata／mapping 與重建。實際查詢層斜率約 42 ms／MB。單一文件層級則是 bytes 與 block 數兩項：試算表類文件（1 MB、約 1.2 萬個 block）約 34 ms／MB，大型 PDF／文字（21 MB、約 1,500 個 block）約 14 ms／MB。

## 8. 建議進 ADR 的方案

**建議：C2-hybrid。**

- **content 索引**：block 級 FTS5，rowid = `blocks.id`。
  - ≥3 字：trigram `detail=full`，查詢用 phrase，直接證明連續出現，不讀正文。
  - 1 字：`detail=none` 的 code point token；2 字：`detail=none` 的 bigram token。兩者本身就是精確判斷。
  - 含 NUL 的 ≥3 字查詢：unigram token AND 後驗證，或另外保留 unigram `full`（需在 ADR 選擇）。
- **檔名、heading**：獨立的小表（約 44 MiB），以明文驗證，rank 訊號完全來自索引＋metadata。
- **payload**：降為 snippet 用的 docstore，只為當頁結果讀取。
- **移除**：document Bloom、payload Bloom、文件級 unigram／trigram 表，以及「對整份候選文件逐 block 驗證」的熱路徑。

理由：

- 唯一讓所有測試查詢的延遲都不再依賴候選文件大小的方案。
- 正確性 2,000／2,000，含 snippet。
- 只使用 `node:sqlite` 內建的 FTS5，沒有新的相依或程序。
- 逐文件 transaction、marker 接續與 delete／reinsert 等價都已驗證。

代價：store 約增加 1.5 GiB（1.37 → 約 2.9 GiB）；每文件刪除成本隨 block 數增加。

**備案：C1。** store 約 1.78 GiB（+0.4 GiB）。1／2 字與 C2 一樣快；≥3 字仍需讀正文驗證（`SPEC.md` 0.74 s、`ing` 5.9 s），延遲仍受大型 block 影響。

**不建議：**

- **B**：延遲形狀不變，常見 ASCII 仍然 O(bytes)。
- **D 的最稀有 trigram 路徑**：在 FTS5 上，instance 路徑比原生 phrase 慢；只保留其短查詢部分，已併入 C2-hybrid。
- **外部 sidecar（Option E）**：FTS5 已經證明足夠，沒有理由引入部署與跨庫一致性風險。

**寫 ADR／SPEC 前仍需處理：**

1. 公司 Windows 實機：大小、建置時間、查詢延遲（本報告只有本機證據）。
2. all-terms、`field=filename|content`、`sort=filename|modified`、type／root／subtree 篩選的等價測試（本次未涵蓋）。
3. 命中數非常大的查詢（`e` 3.3 s）：total count 與 top-K 的產品語意。
4. C2 大小縮減實驗：`optimize`、`columnsize=0`、token 設計。
5. 巨大 block 的 snippet 只讀命中 offset 所在 payload。
6. 建置時的串流 tokenizer（峰值 RSS 2 GiB），以及單機依序建置的時間。
7. 日常 upsert 延遲（每文件 delete＋insert）在大型 xlsx 文件上的實測。
8. §7.1 NUL bug 是否要先在現行產品修正。

## 9. 重現

```text
cd scripts/prototype-search
node build.mjs --variant fields|B|C1|C2
node gen-queries.mjs
node truth.mjs --shard i/12 (0..11) ; node truth.mjs --merge 12
node run-diff.mjs --engine A|B|C1|C2|D --shard i/n
node compare.mjs ; node sizes.mjs ; node migration.mjs --limit 3000
node bench.mjs --select ; node bench.mjs --engine C2|D|C1|B|A
node costmodel.mjs --queries ; node costmodel.mjs --documents
node report.mjs --out ../../docs/research/search-architecture-2026-09-27/prototype
```

資料目錄內的 `correctness.json`、`diff-*.jsonl`、`truth.jsonl`、`queries.json` 含有抽樣自真實文件的文字，只留在本機、沒有放進儲存庫。
