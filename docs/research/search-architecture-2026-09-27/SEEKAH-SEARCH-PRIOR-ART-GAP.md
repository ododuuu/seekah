# Seekah 搜尋：Prior-art review 與差距分析

日期：2026-09-27。前置文件：`SEEKAH-CURRENT-SEARCH-ARCHITECTURE.md`、`SEEKAH-SEARCH-PROBLEM-ANALYSIS.md`。
證據原則：以官方文件、官方原始碼、原作者技術文章為主；每個系統的出處列在該節末尾。另外在 Node 22.22.2（內建 SQLite 3.51.2）實際跑了一個 FTS5 行為驗證（§6），確認文件的描述。

---

## 1. 各系統逐一回答

### 1.1 Zoekt（Sourcegraph；原作者 Han-Wen Nienhuys）

| 問題 | 回答 |
|---|---|
| 解決什麼問題 | 在大量原始碼上做快速的 substring 與 regexp 搜尋 |
| 索引什麼 | 內容與檔名各自的 trigram（以 rune 計），**每次出現的 offset 都記錄下來**；posting list 以 varint 編碼；原始內容**不壓縮**地存在 shard 裡，以 mmap 讀取 |
| 粒度 | 定位到**字元位置**（rune offset，每 100 runes 存一個 rune→byte 對照）；文件邊界由 offset 推導 |
| 保留 positions？ | **是**，這是整個設計的核心 |
| 如何驗證 exact | substring：從 pattern 中挑出**頻率最低、且不重疊的兩個 trigram**（`findSelectiveNgrams`），檢查它們的出現位置「距離正確」，再在該位置比對原文；regexp：先萃取 literal 產生候選，再跑 regexp |
| 何時讀 stored content | 只讀候選位置附近（`readContentSlice`），以及為了顯示結果；因為是 mmap 且未壓縮，很便宜 |
| 短查詢 | 少於 3 個 rune 的 pattern 轉成 regexp match tree，實際上是 brute-force（`matchtree.go: newSubstringMatchTree`） |
| 更新 | 以 shard 為單位重建（「generate shards in the new format … delete old shards」）；不做逐檔 in-place 更新 |
| 可直接重用 | **架構**：positional trigram、挑最稀有的 n-gram、檔名與內容分開的 posting、只讀候選位置附近的內容 |
| 與 Seekah 不相容 | Go 實作（只能以 sidecar 方式使用）；以 shard 重建為主，不符合逐檔增量更新；索引約為語料的 3–3.5 倍（「about 3x the corpus size, composed of 2x (offsets), and 1x (original content)」）；沒有 NFKC；針對原始碼的排序訊號 |

出處：`github.com/sourcegraph/zoekt/blob/main/doc/design.md`；`index/indexdata.go`（`findSelectiveNgrams`）；`index/matchtree.go`（`newSubstringMatchTree`、`bruteForceMatchTree`）；`index/read.go`（`readContents`、`readContentSlice`）。

### 1.2 Google Code Search（Russ Cox，“Regular Expression Matching with a Trigram Index”）

| 問題 | 回答 |
|---|---|
| 解決什麼問題 | 在大量原始碼上跑 regexp |
| 索引什麼 | 每個 trigram 對應一份**只有 file ID** 的 posting list（沒有 positions） |
| 粒度 | 檔案 |
| 保留 positions？ | **否**。Cox 的解釋是 trigram 不對齊詞邊界，所以沒有 phrase 相鄰的需求；regexp 會被轉成 trigram 的 AND／OR 查詢 |
| 如何驗證 exact | 「run the full regular expression search against only those documents」：對每個候選檔案跑完整的 regexp |
| 何時讀 stored content | 每個候選檔案都讀全文（原始檔案，未壓縮） |
| 短查詢 | 抽不出 trigram 時，查詢退化成全部檔案 |
| 更新 | 批次重建 |
| 可直接重用 | regexp → trigram query 的轉換規則 |
| 與 Seekah 不相容 | **這就是 Seekah 目前的架構**（文件級 AND ＋ 全文驗證）。它能運作的前提是：候選檔案**小**（原始碼檔案）、未壓縮、讀起來便宜。Seekah 的候選文件是數十 MB、Brotli＋JSON，而且大型文件會系統性地成為候選，因此這個前提不成立 |

出處：`swtch.com/~rsc/regexp/regexp4.html`（索引約為原始檔案大小的 20%；Linux 3.1.3 的 420 MB 產生 77 MB 索引）。

> 使用者題目中假設「Google Code Search 使用 positional postings」。依原文，它**不使用** positions。真正的教訓是反過來：Code Search 的 document-only 設計之所以夠用，是因為驗證成本很低；Zoekt 之所以加入 positions，正是為了讓驗證只發生在候選位置。

### 1.3 Apache Lucene

| 問題 | 回答 |
|---|---|
| 解決什麼問題 | 通用全文檢索函式庫 |
| 索引什麼 | term dictionary（`.tim`／`.tip`）；posting：doc id＋頻率（`.doc`）、**positions（`.pos`）**、offsets 與 payloads（`.pay`）；stored fields（`.fdt`／`.fdx`）；doc values；norms |
| 粒度 | Lucene document（應用自行決定：一個檔案、一頁、一段…）；posting 可細到 position＋字元 offset |
| 保留 positions？ | 可逐欄位設定；`PhraseQuery` 靠 positions 比對「consecutive positions」上的 term 序列 |
| 如何驗證 exact | 由索引本身證明（phrase＝posting 的位置交集）；不讀 stored fields |
| 何時讀 stored content | 只在取結果時讀。Stored fields 以壓縮 block 存放（BEST_SPEED：LZ4、8 KB 以上的 block，每 80 KB 左右一個 chunk；大文件會切成多個 8 KB LZ4 block，可以只解壓需要的部分） |
| 短查詢 | 看 analyzer。`NGramTokenizer` 可設定 min／max gram，每個 gram 帶 position 與 offset；1-gram 也可以是 term |
| 更新 | segment 不可變；刪除用 tombstone；merge policy |
| 可直接重用 | **架構**：positions 與 stored fields 分離、stored fields 只在 top-K 讀、依欄位建 posting（filename／heading／content） |
| 與 Seekah 不相容 | Java／JVM，Node 無法內嵌，而且不能假設可以裝 JVM |

出處：`lucene.apache.org/core/9_12_0/core/org/apache/lucene/codecs/lucene912/package-summary.html`（index file 表）；`…/lucene90/Lucene90StoredFieldsFormat.html`；`…/search/PhraseQuery.html`；`…/analysis/common/org/apache/lucene/analysis/ngram/NGramTokenizer.html`。

### 1.4 Tantivy（Quickwit）

| 問題 | 回答 |
|---|---|
| 解決什麼問題 | Rust 的 Lucene 式全文檢索函式庫 |
| 索引什麼 | inverted index；`IndexRecordOption::{Basic, WithFreqs, WithFreqsAndPositions}`：「Positions are required to run a PhraseQuery」；fast fields（columnar）；docstore |
| 粒度 | 應用自行決定 document；positions 在 token 層級 |
| 保留 positions？ | 可逐欄位選擇 |
| 如何驗證 exact | 由索引的 phrase query 證明 |
| 何時讀 stored content | docstore 是「Compressed/slow/row-oriented storage」，每超過 16 KB 壓成一個 LZ4／Zstd block；讀一份文件要解壓整個 block。官方明言典型用途是「once the search result page has been computed, returning the actual content of the 10 best document」 |
| 短查詢 | 用 ngram tokenizer（min 1 或 2）加 phrase |
| 更新 | segment＋merge；delete by term |
| 可直接重用 | **架構**：docstore 只給 top-K；「搜尋與取回分離」；fast field 放排序用的 mtime／rank 訊號 |
| 與 Seekah 不相容 | Rust 原生程式；需要 N-API addon（不能假設允許）或 sidecar binary（需要確認公司政策）。2026-09-19 試過的第三方 Node 綁定缺少 `Tokenizer.ngram()`，不可用 |

出處：`docs.rs/tantivy/latest/tantivy/store/index.html`；`docs.rs/tantivy/latest/tantivy/schema/enum.IndexRecordOption.html`。

### 1.5 Xapian／Recoll

| 問題 | 回答 |
|---|---|
| 解決什麼問題 | Xapian：C++ 檢索函式庫。Recoll：以 Xapian 為核心的**桌面文件搜尋**，是最接近 Seekah 產品形態的系統 |
| 索引什麼 | Xapian `TermGenerator` 預設記錄 term positions，支援 phrase；`increase_termpos()` 可在欄位之間插入間隔，避免 phrase 跨越 title／body。CJK：`FLAG_NGRAMS`（舊名 `FLAG_CJK_NGRAM`）把無空白文字「split into unigrams and bigrams, with the unigrams carrying positional information」，或用 `FLAG_WORD_BREAKS`（ICU 斷詞）。Recoll 的 `cjkngramlen` 預設為 2 |
| 粒度 | Recoll：一份文件（或容器內的子文件）一個 Xapian document |
| 保留 positions？ | 是 |
| 如何驗證 exact | 以索引的 phrase 為準，不重讀原文 |
| 何時讀 stored content | Recoll 1.24 起在索引中儲存文件文字，用來產生 snippet（「New snippets generation method, using document text stored in the index」）；只在顯示結果時讀 |
| 短查詢 | CJK 的 unigram／bigram 就是 term，可以直接查 |
| 更新 | 依修改時間增量更新；可選即時監看 |
| 可直接重用 | **架構**：parser（Recoll 的 input handler）與檢索後端完全分離；CJK 採「unigram＋bigram term，unigram 帶位置」；欄位間 position gap |
| 與 Seekah 不相容 | 非 CJK 文字以**詞**為 term，不是 substring 語意（`pec` 找不到 `spec`），違反 Seekah 的 exact substring 契約；C++ 函式庫，需要原生綁定；GPL |

出處：`xapian.org/docs/apidoc/html/classXapian_1_1TermGenerator.html`；`recoll.org/usermanual/webhelp/docs/RCL.INSTALL.CONFIG.RECOLLCONF.TERMS.html`；`recoll.org/pages/release-1.24.html`。

### 1.6 SQLite FTS5（Seekah 已經在用，而且不需要新的相依套件）

| 問題 | 回答 |
|---|---|
| 解決什麼問題 | SQLite 內建的全文檢索虛擬表 |
| 索引什麼 | 依 tokenizer 產生 token。`trigram` tokenizer 把每 3 個連續字元當一個 token，「allowing FTS5 to support more general substring matching」；`case_sensitive`、`remove_diacritics` 選項 |
| 粒度 | 一個 FTS row（由應用決定：文件、block…） |
| 保留 positions？ | 由 `detail` 決定：`full`（rowid＋column＋offset）、`column`（「Phrase queries are not available」）、`none`（只有 rowid，也不能 column filter）。官方大小範例：743 MiB／340 MiB／134 MiB |
| 如何驗證 exact | `detail=full` 時，trigram tokenizer 上的 phrase 查詢就是連續子字串（§6 實測確認）；`highlight()`／`snippet()` 需要 positions 與 content |
| 何時讀 stored content | contentless（`content=''`）時讀不到欄位值；external content 需要應用自己維持一致 |
| 短查詢 | 「Substrings consisting of fewer than 3 unicode characters do not match any rows」→ 必須另建 unigram／bigram 路徑 |
| 更新 | 逐 row insert／delete；contentless 必須用 `contentless_delete=1` 才能 DELETE |
| 可直接重用 | **實作可直接重用**：已隨 `node:sqlite` 提供、Windows 可攜、不需原生擴充；`detail=full`＋trigram 的 phrase；`fts5vocab` 的 `instance` 表可以用純 SQL 取得（term, doc, col, offset）（§6 實測） |
| 與 Seekah 不相容 | 無法在 FTS5 內自訂「挑最稀有的 trigram」：phrase 會讀取所有 token 的 position list，所以常見 trigram 的成本高；`node:sqlite` 不能註冊自訂 FTS5 auxiliary function（xInst 等 C API），只能用內建函式或 fts5vocab；contentless 表無法產生 snippet；tokenizer 的 case folding 與 JS `toLowerCase()` 不完全相同（每個 code point 各自對應，只會多出候選，不會漏） |

出處：`sqlite.org/fts5.html`。

### 1.7 ripgrep（只談掃描與 literal 加速）

| 問題 | 回答 |
|---|---|
| 解決什麼問題 | 無索引、逐檔掃描的 regexp 搜尋 |
| 索引什麼 | 不建持久索引 |
| 如何加速 | 從 pattern 萃取 prefix／suffix literal，以 SIMD（Teddy、memchr）找候選位置，只在候選行上跑完整 regexp（「staying out of the regex engine」） |
| 何時掃描勝過索引 | 資料量小到可以常駐 page cache、未壓縮、不需排序／分頁／總數時 |
| 對 Seekah 的教訓 | 目前 Seekah 的驗證既不是 ripgrep 式的「原始 bytes 上的 SIMD 掃描」，也不是索引式的「只看候選位置」。它是**最貴的混合**：Brotli → JSON → JS string → 逐 block NFKC → `includes` |

出處：`burntsushi.net/ripgrep/`。

### 1.8 Everything（voidtools）

| 問題 | 回答 |
|---|---|
| 索引什麼 | 「only indexes file and folder names」；透過 NTFS MFT 建立，並以 USN Journal 保持更新 |
| 權限 | 「NTFS indexing requires the Everything service or running 'Everything' as administrator」 |
| 內容搜尋 | 「File content is not indexed, searching content is slow」 |
| 為何不等價 | 它解決的是檔名與 metadata 問題；Seekah 的核心是全文內容，而且不能要求 admin 或 service（D056 已排除 USN） |
| 仍可借鏡的地方 | 檔名是獨立、極小、可全部常駐記憶體的索引；檔名查詢不該被正文索引拖慢（對應 P9） |

出處：`voidtools.com/faq/`。

---

## 2. 成熟系統的共同做法

1. **索引必須能證明命中，而不只是排除不可能。** Lucene／Tantivy／Xapian／FTS5 `detail=full` 用 positions 證明 phrase；Zoekt 用 positional trigram 的距離證明 substring，再只在該位置比對。唯一只存 document ID 的是 Code Search，而它依賴「驗證很便宜」這個前提。
2. **stored content 不在候選驗證的熱路徑上。** Tantivy docstore 與 Lucene stored fields 都明說是 slow／compressed，只在 top-K 讀取；Recoll 儲存文字是為了 snippet。
3. **posting 的粒度要對齊 match 單位**：Lucene document 或欄位＋position；Xapian 用 position gap 防止跨欄位；Zoekt 用 offset。
4. **欄位分開索引**：檔名與內容分開（Zoekt 分成兩組 posting；Lucene／Tantivy 以 field 區分）。
5. **短查詢要有專門的路徑**：CJK 的 unigram＋bigram term（Xapian、Recoll），或對 <3 字元的查詢使用 brute force（Zoekt，以未壓縮的 mmap 內容為前提）。
6. **選擇性**：Zoekt 挑最稀有的 n-gram；Lucene 的 conjunction 由最短的 posting 帶頭。
7. **沒有任何一個成熟系統用固定大小的 Bloom 做文件內定位。**

---

## 3. Gap matrix

| Dimension | Seekah current (local) | Zoekt | Lucene／Tantivy | Xapian／Recoll | SQLite FTS5 | Gap |
|---|---|---|---|---|---|---|
| candidate granularity | 文件 | 字元位置 | document＋position | document＋position | row（應用決定）＋position（`full`） | 候選止於文件，而且大型文件被系統性選中 |
| block granularity | parser block 存在，但**不在索引裡** | 無 block 概念（位置已足夠） | 由應用選擇 document＝段落／頁 | 子文件 | row 可以是 block | block 只能經由 payload mapping 推回來 |
| positional information | 無（`detail=none`） | 有（rune offset） | 有（`.pos`／`WithFreqsAndPositions`） | 有 | `detail=full` 時有 | 缺 |
| short query support | unigram AND（文件級，無相鄰）→ 全文驗證 | brute force（便宜，因為未壓縮） | ngram tokenizer／unigram term | CJK unigram＋bigram term | trigram 對 <3 字元無效 | 1–2 字只有文件級、無相鄰資訊 |
| CJK | code point unigram＋trigram，無斷詞需求 ✔ | rune trigram ✔ | 需要 CJK analyzer／ngram | ngram 或 ICU | trigram ✔（<3 字元除外） | 語意 OK，缺的是位置與 2-gram |
| substring | 驗證時以 `includes` 保證 ✔ | ✔ | 需要 ngram＋phrase | ✘（非 CJK 以詞為單位） | trigram＋phrase ✔ | 語意 OK；成本在驗證 |
| phrase | 以 trigram AND 近似 → 全文驗證 | 距離檢查 | positional phrase | positional phrase | `detail=full` phrase | 缺 |
| stored content reads | 所有候選文件、所有被選 payload，發生在 ranking 之前 | 只讀候選位置的 slice | 只讀 top-K | 只讀 snippet | contentless 無 content | **最大差距** |
| decompression path | Brotli＋JSON＋fragment 重建，每次查詢 285 MB | 無壓縮（mmap） | LZ4 8 KB block，可部分解壓 | Xapian 內部 | — | 壓縮單位 64 KiB＋JSON 包裝，且在熱路徑上 |
| ranking | 需要正文（filename／heading／content 命中）；沒有 top-K | 程式碼訊號＋命中 | 由 posting 與 norms 評分，top-K collector | BM25＋top-K | bm25（需要 `detail≥column`） | rank 訊號不在索引中 |
| snippet | 本頁結果回讀 block ✔ | 讀 slice | 高亮需要 offset＋stored | 儲存的文字 | 需要 content＋positions | 大致相同（這一點已經正確） |
| update／delete | 逐文件 transaction ✔ | shard 重建 | segment／tombstone | 增量 | 逐 row（`contentless_delete`） | Seekah 這方面最強；新方案必須保留 |
| index size | 1.37 GiB（其中 Bloom 約 257 MiB） | 3–3.5× 語料 | 視 positions 與 stored 而定 | 中 | full 約為 none 的 5.5 倍（官方範例） | positions 會增加大小，必須實測 |
| implementation complexity | 已存在；但 Bloom、mapping、fallback 路徑多 | 外部 | 外部 | 外部 | 已在用，SQL 層級 | — |
| Windows portability | ✔ | Go binary（sidecar） | JVM／Rust binary | C++ | ✔（`node:sqlite` 內建） | — |
| Node compatibility | ✔ | 僅 sidecar | 僅 sidecar（或 N-API） | 需原生綁定 | ✔ | — |
| native dependency | 無 | 有 | 有 | 有 | 無 | FTS5 是唯一不增加相依的成熟實作 |
| rebuild／migration cost | 逐文件 marker 可接續 ✔ | 全部重建 shard | 全部重建 | 全部重建 | 可沿用逐文件 marker 模式 | 任何新索引都必須解壓 27,468 個 payload 一次 |

---

## 4. Seekah 的約束（PART 6）與可重用程度

| 約束 | Zoekt | Lucene | Tantivy | Xapian／Recoll | FTS5 | 說明 |
|---|---|---|---|---|---|---|
| local-only | ✔ | ✔ | ✔ | ✔ | ✔ | |
| Node／TS 現有堆疊 | ✘ | ✘ | ✘ | ✘ | ✔ | |
| Windows 企業環境、無 admin | sidecar 需要政策允許 | 需要 JVM | sidecar／addon | 原生 | ✔ | 不能假設允許原生擴充或 service |
| 不假設原生擴充 | ✘ | ✘ | ✘ | ✘ | ✔ | |
| 保留多格式 parser | ✔（parser 在前） | ✔ | ✔ | Recoll 有自己的 handler | ✔ | 所有方案都只取代 parser 之後的部分 |
| stable reference（`documents.id`） | 需要外部 ID 對照 | 同左 | 同左 | 同左 | ✔（rowid 可以是 `blocks.id`，並保存 document_id） | |
| exact substring | ✔ | ngram＋phrase | ngram＋phrase | ✘（非 CJK） | trigram＋phrase ✔ | |
| NFKC＋lowercase | 自行前處理 | 自訂 filter | 自訂 filter | 自訂 | 寫入前先正規化（目前已這樣做） | |
| CJK 不依賴空白斷詞 | ✔ | ngram | ngram | ngram | ✔ | |
| phrase／all-terms | ✔ | ✔ | ✔ | ✔ | ✔ | all-terms 是文件級 AND，可在 SQL 做 |
| 檔名／heading／body 排序 | 分開的檔名 posting | 欄位 | 欄位 | 欄位＋position gap | 多個 column 或多張表 | |
| 增量更新 | ✘（shard） | ✔ | ✔ | ✔ | ✔ | |
| crash-safe migration | 外部 | 外部 | 外部 | 外部 | 與主庫同一 transaction ✔ | sidecar 無法與 SQLite 共用 transaction |
| read-only CLI／MCP | 可 | 可 | 可 | 可 | ✔（現況） | |
| 不依賴外部 AI | ✔ | ✔ | ✔ | ✔ | ✔ | |

**cannot reuse implementation vs can reuse architecture**

| 系統 | 實作能否重用 | 架構能否重用 |
|---|---|---|
| Zoekt | 不能（Go，shard 模型） | **能**：positional trigram、挑最稀有的 n-gram、內容／檔名分開、只驗證候選位置 |
| Code Search | — | 只能作為反例（說明為什麼 document-only 在這裡不夠） |
| Lucene | 不能（JVM） | **能**：posting／positions／stored fields 分離、top-K 才讀 stored |
| Tantivy | 有條件（sidecar binary，需要政策確認） | **能**：同 Lucene；docstore 只給 top-K |
| Xapian／Recoll | 不能（原生＋語意不符） | **能**：parser 與後端分離、CJK unigram＋bigram term、欄位 position gap、只為 snippet 儲存文字 |
| SQLite FTS5 | **能**（已經在用） | **能**：block 級 row、`detail=full` 或 bigram token |
| ripgrep | 不能（非索引） | 部分：literal／SIMD 掃描的思路，只適用於原始 bytes |
| Everything | 不能（需要 admin） | 部分：檔名索引獨立、極小 |

---

## 5. 差距總結

Seekah 目前是 **Code Search 式架構**（文件級 posting＋全文驗證），但**缺少讓 Code Search 成立的前提**：候選文件小、未壓縮、驗證便宜。所有同時需要「substring＋大型文件＋快速」的系統（Zoekt、Lucene／Tantivy 的 ngram＋phrase、FTS5 `detail=full`）都把**位置**（或至少對齊 match 單位的粒度）放進索引，並把 stored content 移出候選路徑。Seekah 已經擁有其中一個成熟實作（FTS5），只是只用了它最弱的模式（文件級 row＋`detail=none`）。

---

## 6. 附錄：FTS5 行為實測（Node 22.22.2／SQLite 3.51.2，`:memory:`，非 production 程式）

```text
row1 = "see spec.md for details"            （含子字串）
row3 = "spec. c.md xspe pec ec. .md"         （5 個 trigram 都有，但不連續）

trigram detail=full  MATCH '"spec.md"'                      → [1]      phrase = 連續子字串
trigram              MATCH '"spe" AND "pec" AND … AND ".md"' → [1, 3]   = 目前 detail=none 的語意（row3 是 false positive）
trigram              MATCH '"測試"'（2 字）                   → []       與官方文件一致：<3 字元不命中
unigram detail=full  MATCH '"u6e2c u8a66"'（phrase）         → 只有「測試報告」
unigram              MATCH '"u6e2c" AND "u8a66"'            → 「測試報告」與「測量考試」都命中（目前語意）
fts5vocab(t,'instance') WHERE term='c.m'                    → (doc 1, offset 7), (doc 3, offset 6)；plan: VIRTUAL TABLE INDEX 267
DatabaseSync.prototype.function                             → 存在（可註冊 JS scalar UDF）
```

結論：只用 `node:sqlite` 內建的 FTS5，就可以做到「trigram phrase＝連續子字串」與「unigram phrase＝相鄰」，也可以用純 SQL 取得 offset。**不需要新的原生相依。** 規模上的成本（索引大小、常見 trigram 的 position list 長度）尚未量測，列入 prototype。

## Sources

- [Zoekt design doc](https://github.com/sourcegraph/zoekt/blob/main/doc/design.md) · [Zoekt source (index/)](https://github.com/sourcegraph/zoekt/tree/main/index) · [Zoekt README](https://github.com/sourcegraph/zoekt/blob/main/README.md)
- [Russ Cox — Regular Expression Matching with a Trigram Index](https://swtch.com/~rsc/regexp/regexp4.html)
- [Lucene 9.12 codec / index files](https://lucene.apache.org/core/9_12_0/core/org/apache/lucene/codecs/lucene912/package-summary.html) · [Lucene90StoredFieldsFormat](https://lucene.apache.org/core/9_12_0/core/org/apache/lucene/codecs/lucene90/Lucene90StoredFieldsFormat.html) · [PhraseQuery](https://lucene.apache.org/core/9_12_0/core/org/apache/lucene/search/PhraseQuery.html) · [NGramTokenizer](https://lucene.apache.org/core/9_12_0/analysis/common/org/apache/lucene/analysis/ngram/NGramTokenizer.html)
- [Tantivy store](https://docs.rs/tantivy/latest/tantivy/store/index.html) · [Tantivy IndexRecordOption](https://docs.rs/tantivy/latest/tantivy/schema/enum.IndexRecordOption.html)
- [Xapian TermGenerator](https://xapian.org/docs/apidoc/html/classXapian_1_1TermGenerator.html) · [Recoll term parameters](https://www.recoll.org/usermanual/webhelp/docs/RCL.INSTALL.CONFIG.RECOLLCONF.TERMS.html) · [Recoll 1.24 release notes](https://www.recoll.org/pages/release-1.24.html)
- [SQLite FTS5](https://sqlite.org/fts5.html)
- [ripgrep is faster than {grep, ag, git grep, ucg, pt, sift}](https://burntsushi.net/ripgrep/)
- [Everything FAQ](https://www.voidtools.com/faq/)
