# 索引大小研究：候選架構實測與建議

日期：2026-09-28。研究，未改 `src/`、未改產品行為。實驗程式在 `scripts/research-index-size/`；資料只留在本機 `C:/Users/mains/seekah-prototype-data/size-2026-09-28/`（含文件正文，不進儲存庫）。

## 0. 結論

- 0.38.0 的索引約為文字量的 6 倍，主因是**一行一列**：每段只有中位數 31 個字元，卻要付 FTS row、`blocks` row、payload↔block 對照的固定開銷。trigram 位置本身不是必要成本。
- 建議的新架構：**以約 64K 字元的區段為單位的「不記位置 trigram 索引」＋zstd 壓縮原文＋依排序規則走訪、找滿第一頁即停止（Elasticsearch 的計數門檻做法）**。
  - 實測：內容部分 83.6 MiB（文字量的 0.48 倍），225 個查詢結果全部與暴力比對相同；所有查詢第一頁 2–18 ms，計數到 10,000 筆 23–319 ms。
  - 推估整庫（加檔名／標題索引、文件清單、少數需要存的段落位置）約 120–130 MiB；目前 0.38.0 同一份資料約 1,040 MiB。
- 需要使用者決定的產品行為：命中超過 10,000 筆時，總數是否改為「10,000 筆以上」（可選背景補精確數）。

## 1. 語料與方法

- 來源：使用者真實 index（排除 `AppData`、`seekah-prototype-data` 後）的快照。有內文的文件 9,433 份、段落 2,452,622 個、原文 172.7 MiB（UTF-8）。
  - 組成：`.js` 111.2 MiB（1,858,955 段）、`.md` 34.2 MiB、`.txt` 18.4 MiB、`.xml` 6.3 MiB，其餘各不到 2 MiB。
  - 段落長度：中位數 31 字元、p90 79、p99 506、平均 72.7。
  - 壓縮率（10% 抽樣）：zstd-3 0.266、zstd-19 0.212、brotli-11 0.208。
- 0.38.0 同一份資料的空間（dbstat，不含 2.86 GB free pages）：內文 trigram 469 MiB、1／2 字 token 189 MiB、payload↔block 對照 147 MiB、`blocks` 146 MiB、壓縮正文 54 MiB、文件清單 20 MiB、檔名／標題索引 15 MiB。
- 查詢：25 個指定查詢（`spec.md`、`測試`、`ing`、`e`、`的`、`function`、`{`、`console.log(`、`下列何者`、不存在的詞等）＋200 個從語料隨機抽取的 1–12 字子字串，seed 20260928。
- 標準答案：對每個查詢，以 NFKC＋小寫後的段落逐一 `includes()`，記錄全部命中的「文件：段落」集合。每個方案都必須回傳完全相同的集合（sha256 比對）。命中數例：`e` 1,721,509、`{` 423,523、`the` 244,885、`ing` 241,062、`function` 68,681、`spec.md` 203、`測試` 415。
- 機器：本機 Windows 11、i9-13980HX／32 GB、Node.js 22.23.2、SQLite 3.51.3。不是公司 Windows 驗收。

## 2. 實測結果

大小為文字 172.7 MiB 的倍數；「全部驗證」是找出全部命中段落的時間；「第一頁」是找到 20 筆命中、「計數 10k」是計數到 10,000 筆（或全部，若少於 10,000）的時間。

| 方案 | 內容部分大小 | 倍數 | 正確性 | 全部驗證 p50／p90 | 第一頁 | 計數 10k |
|---|---|---|---|---|---|---|
| 0.38.0（一行一列、trigram 位置） | 約 1,040 MiB | 6.0 | ✓ | 毫秒級（常見詞數秒） | — | — |
| 1. 直接掃描（64K 區段 zstd） | 52.2 MiB | 0.30 | 225/225 | 2.6 s／3.4 s | — | — |
| 2. 區段 trigram 不記位置（64K） | 83.6 MiB | 0.48 | 225/225 | 0.59 s／3.5 s | **2–18 ms** | **23–319 ms** |
| 2'. 同上，16K 區段 | 99.6 MiB | 0.58 | 225/225 | 0.46 s／4.3 s | — | — |
| 3. sparse grams（64K） | 321.1 MiB | 1.86 | 225/225 | 0.26 s／3.8 s | — | — |

方案 2 的第一頁與計數（依文件修改時間由新到舊走訪候選區段）：

| 查詢 | 候選區段 | 第一頁 | 計數 10k | 精確數 |
|---|---|---|---|---|
| `spec.md` | 103 | 5 ms | 31 ms | 203 |
| `測試` | 107 | 2 ms | 28 ms | 415 |
| `console.log(` | 764 | 4 ms | 195 ms | 1,691 |
| `function` | 4,148 | 11 ms | 319 ms | ≥10,000 |
| `return` | 5,522 | 12 ms | 256 ms | ≥10,000 |
| `{` | 7,188 | 13 ms | 75 ms | ≥10,000 |
| `the` | 8,782 | 14 ms | 100 ms | ≥10,000 |
| `ing` | 10,015 | 16 ms | 114 ms | ≥10,000 |
| `e` | 10,839 | 18 ms | 23 ms | ≥10,000 |

Tantivy（`@oxdev03/node-tantivy-binding` 0.3.3，win32-x64 預編譯），同一批 64K 區段：

| 版本 | 索引大小 | 建置 | 候選查詢 | 與 FTS5 候選一致 |
|---|---|---|---|---|
| T1 trigram 不記位置 | 23.9 MiB | 14.5 s | 0.2–4 ms | ✓（9/9） |
| T1b 1–3 字 n-gram 不記位置 | 29.1 MiB | 28 s | 0.2–4 ms | ✓ |
| T2 trigram 記位置 | 51.5 MiB | 31 s | — | ✗（n-gram tokenizer 的位置不連續，片語查詢不可用；大小有效） |
| T3 T1＋LZ4 原文 | 87.8 MiB（原文 63.9） | 15 s | — | ✓ |

對照：SQLite FTS5 同類索引 trigram 23.4 MiB＋1／2 字 token 7.9 MiB；方案 2 建置（含區段庫）約 225 s。

其他量測：

- 全掃拆解（64K 區段、單執行緒）：讀出 128 ms、zstd 解壓 879 ms、比對 84 ms（無命中）～702 ms（`e`）。
- 多執行緒全部驗證：`e` 1 worker 3.0 s、4 worker 1.3 s、8 worker 0.94 s、16 worker 1.0 s；瓶頸在解壓的記憶體配置／頻寬，不隨核心數線性下降。
- 正規化：NFKC＋小寫 437 MB/s、只小寫 1.5 GB/s；80% 的區段是純 ASCII。0.37 當時實測每 MB 42 ms（約 24 MB/s）的瓶頸是 Brotli＋JSON＋逐段處理，不是正規化。
- 段落位置：2,377,439 段（97%）是 `line` 類型、沒有標題，位置文字恆為「第 N 行」、N＝ordinal＋1，可以推算；只有約 75,000 段（章節、儲存格、頁、投影片）需要存 heading／location。

## 3. 各類方案與判斷

| 類別 | 代表 | 已知大小 | 對 Seekah 的判斷 |
|---|---|---|---|
| 不建索引、直接掃描 | grep、ripgrep | 只存壓縮原文 | 最小（0.30 倍），但單執行緒 2–4 s、8 執行緒仍約 1 s；只適合作為後備。 |
| 以詞為單位的倒排索引 | Lucene、Xapian、Windows Search | 小 | 不能搜詞中間的片段；程式碼識別字、中文任意片段搜不到。不符合 SPEC 的 exact substring 語意。 |
| 不記位置的 trigram | Google Code Search（Russ Cox） | 約原文 20%（Linux 420 MB → 77 MB） | **採用**。以區段為單位＋提前停止後，大小與速度都達標。 |
| 記位置的 trigram | Zoekt | 約原文 3 倍（位置 2 倍＋原文 1 倍） | 位置的大小取決於儲存格式：Tantivy 區段級位置只要 0.3 倍。但加了提前停止後，位置幾乎沒有速度效益。 |
| sparse grams | GitHub code search | 25 TB（含壓縮原文）對 28 TB 去重內容 | 實測索引是 trigram 的 8.6 倍，候選幾乎沒減少；它適合「多數檔案不含查詢詞」的海量小檔案，Seekah 相反。 |
| n-gram 選擇（FREE／BEST／LPMS） | Cho & Rajagopalan 2002；2025 評估論文 | 依工作量 | 需要查詢日誌或長時間建置；在 Seekah 規模下，索引已經只占 31 MiB，沒有必要。 |
| 壓縮自索引 | FM-index、CSA、Succinct | 原文 0.4–0.8 倍（可定位＋取文） | 大小沒有明顯優勢；定位約每秒 10 萬個命中，`e` 約 17 s；建置記憶體 5–9 倍；靜態結構需要分層合併；JS 無可用實作。排除。 |
| 後綴陣列／後綴樹 | — | 4–5 倍／10–20 倍 | 太大。排除。 |
| 簽章檔／Bloom | BitFunnel、Seekah 0.26–0.37 | 可調 | 過去的 1 KiB 固定大小已證實飽和；不如 trigram 精確。排除。 |

## 4. 建議架構（待使用者確認後寫入 SPEC）

1. **原文儲存**：每份文件的段落依序串成約 64K 字元的區段，存原文（不另存正規化文字），zstd 壓縮；每個區段附段落起點偏移表（varint）。只有非 `line` 段落另存 heading／location。
2. **內容索引**：每個區段一列，不記位置的 trigram＋單字／雙字 token（SQLite FTS5 `detail=none`，或 Tantivy）。
3. **檔名、標題**：沿用小型獨立索引，完整算出命中。
4. **查詢**：候選區段依排序規則走訪（檔名命中 → 標題命中 → 內文；同級依修改時間或使用者指定的排序），解壓後即時正規化、比對，並確認不跨段落；找滿當頁即停止，計數到 10,000 筆。
5. **更新**：單一文件只刪除、重寫它自己的區段與索引列；刪除沒有全表掃描（外鍵子表一律有索引，0.38.1）。

## 5. 需要決定的事

1. **總筆數**：命中超過 10,000 筆時顯示「10,000 筆以上」（Elasticsearch `track_total_hits` 預設即為 10,000，超過回報 `gte`），或另在背景以約 1–3 s 算出精確數後更新畫面。
2. **索引引擎**：
   - SQLite FTS5：沿用現有依賴、沒有原生模組；建置較慢（約 3 分鐘）。
   - Tantivy：建置快約 15 倍、查詢更快，但要帶入一個由個人維護的原生模組（napi，Windows 有預編譯），公司電腦的相容性要另外驗證。
   - 建議先用 SQLite FTS5，架構保留換成 Tantivy 的介面。
3. **all-terms 模式**：「全部詞都要出現」需要跨區段合併同一文件的詞，提前停止的規則要另外設計。

## 6. 未做／限制

- 沒有實作「提前停止」下的 all-terms、`field`／type／root／status 篩選、restricted ids；上述只驗證 phrase、全欄位、依修改時間排序的走訪。
- 沒有在公司 Windows 或大型格式（PDF、Office）為主的語料上量測。
- Tantivy 位置索引的片語查詢未完成（繫結不支援預先切好的 token）。
- sparse grams 的雙字權重用雜湊，不是 GitHub 的頻率權重；因瓶頸是真命中而非誤判，預期不影響結論。

## 7. 來源

- Russ Cox，Regular Expression Matching with a Trigram Index：https://swtch.com/~rsc/regexp/regexp4.html
- Zoekt design：https://github.com/sourcegraph/zoekt/blob/main/doc/design.md
- GitHub，The technology behind GitHub's new code search：https://github.blog/engineering/architecture-optimization/the-technology-behind-githubs-new-code-search/
- sparse-ngrams（Rust 實作說明）：https://docs.rs/sparse-ngrams/latest/sparse_ngrams/index.html；danlark1/sparse_ngrams：https://github.com/danlark1/sparse_ngrams
- Agarwal, Khandelwal, Stoica，Succinct: Enabling Queries on Compressed Data（NSDI 2015，全文已讀）：https://www.usenix.org/conference/nsdi15/technical-sessions/presentation/agarwal
- Ferragina, González, Navarro, Venturini，Compressed Text Indexes: From Theory to Practice（全文已讀）：https://arxiv.org/abs/0712.3360
- Navarro & Mäkinen，Compressed full-text indexes（ACM Computing Surveys 2007）：https://dl.acm.org/doi/10.1145/1216370.1216372
- An Evaluation of N-Gram Selection Strategies for Regular Expression Indexing（2025；只讀摘要與結論整理，未讀全文）：https://arxiv.org/html/2504.12251
- Cho & Rajagopalan，A fast regular expression indexing engine（ICDE 2002；未讀全文，只引用其方法定位）：http://oak.cs.ucla.edu/~cho/papers/cho-regex.pdf
- Elasticsearch search API（`track_total_hits`）：https://www.elastic.co/docs/solutions/search/the-search-api
- Tantivy NgramTokenizer／docstore：https://docs.rs/tantivy/latest/tantivy/tokenizer/struct.NgramTokenizer.html、https://fulmicoton.gitbooks.io/tantivy-doc/content/store.html
- node-tantivy-binding：https://github.com/oxdev03/node-tantivy-binding
