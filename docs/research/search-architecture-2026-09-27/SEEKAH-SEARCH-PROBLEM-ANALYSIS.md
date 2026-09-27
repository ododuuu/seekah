# Seekah 搜尋瓶頸與架構問題分析

日期：2026-09-27。前置文件：`SEEKAH-CURRENT-SEARCH-ARCHITECTURE.md`。本文只分析，不提方案（方案見 `SEEKAH-SEARCH-ARCHITECTURE-OPTIONS.md`）。

## 0. 證據來源與限制

| 來源 | 內容 |
|---|---|
| 使用者提供的兩筆 trace | `測試` 11,307 ms、`SPEC.md` 29,094 ms（schema 3 以前，沒有 SQL 子計時） |
| `docs/search-payload-profile-2026-09-27.json` | 同一 235,463 份文件的 store，4 個查詢的 ranking／第一頁 trace、每個 stream 的 payload 數、候選文件的 block span、EXPLAIN |
| `docs/metadata-mapping-optimization-2026-09-27-*.json` | 同一 snapshot，3 次暖機＋10 次量測，BEFORE／AFTER metadata 修正 |
| `docs/benchmark-ngram.json` | 2,400 份合成的單 block 文件，baseline Bloom 與 FTS postings 比較 |
| 本研究的 Bloom 模擬 | 完全照抄 `buildBloom()`／`bloomMayContain` 的 JS，對不同長度文字量測填充率與 false-positive 率 |

限制：兩次量測的絕對時間差很多（`SPEC.md` 29.1 s 對 14.5 s），而且都沒有清 OS cache、背景有 autoupdate。**下文以 row 數、bytes、payload 數等結構量為主，時間只看比例。**

## 1. 關鍵量測彙整

| 指標 | `測試` | `SPEC.md` | `Snipaste-2.11.3-x64`（稀有） | 不存在詞 |
|---|---:|---:|---:|---:|
| postings 候選文件 | 111 | 144 | 2 | 0 |
| postings lookup | 0.9–1.7 ms | 3.1–5.7 ms | 5.3 ms | 6.4 ms |
| 被 document Bloom 排除 | 2 | 0 | 0 | — |
| 只靠檔名命中（不讀正文） | 2 | 38 | 0 | — |
| 實際讀正文的文件 | 107 | 106 | 2 | — |
| 最後命中 | 96 | 85 | 1 | 0 |
| 讀正文但沒命中（false-positive 文件） | 13 | **59**（106 − 47） | 1 | — |
| payload summaries → Bloom 保留 | 2,601 → 2,601（短詞不做） | 4,954 → 4,640（93.7%） | 461 → 460（99.8%） | — |
| 實際讀取／解壓 payload | 2,619 | 4,638 | 462 | 0 |
| 佔全庫 27,468 個 payload | 9.5% | **16.9%** | 1.7% | 0 |
| 壓縮 bytes／解壓 JSON bytes | 31.9 MB／154.3 MB | 61.8 MB／285.1 MB | 5.7 MB／29.4 MB | 0 |
| block metadata rows（修正前） | 654,014 | 1,652,374（全庫 blocks 的 31.1%） | 59,948 | 0 |
| 總時間（09-27 profile） | 5,602 ms | 14,511 ms | 637 ms | 42 ms |

候選文件的大小極度偏斜（取自 `blockSpans`）：

| 查詢 | 最大 1 份文件 | 最大 5 份 | 最大 10 份 | 最大 15 份 |
|---|---:|---:|---:|---:|
| `測試`（共 2,601 payload） | 825（32%） | 62% | **92%** | 94% |
| `SPEC.md`（共 4,913 payload） | 825（17%） | 45% | 65% | **80%** |
| Snipaste（共 461 payload） | 450（98%） | 100% | — | — |

同一份 825-payload 文件（約 50 MB JSON）同時出現在 `測試` 與 `SPEC.md` 的候選中；另有 9 份各 194 payload、2 份各 291 payload 的文件在兩個查詢都出現。大小完全相同，**推測是重複副本，尚未驗證**。候選文件平均有 15,588 個 blocks（全庫平均 22.6 個）。

`SPEC.md` 的成本拆解（09-27 profile，inclusive 14,433 ms）：

```text
payloadLookup        6,894 ms   metadata 3,931 + mapping 1,501 + blob 1,012 + JS/Set 435
payloadDecompression 2,580 ms   Brotli 1,289 + UTF-8 decode/JSON.parse 1,290
exact self           4,960 ms   NFKC+lowercase+includes 2,174 + Map/重建/迴圈/instrumentation 2,786
```

metadata 修正（已實作）後的同 snapshot p50：payloadLookup 6,471 → 5,203 ms（0.804×），整體 13,766 → 12,236 ms（**0.889×**）；payload blob rows 仍是 4,638，解壓 bytes 不變。

---

## 2. 瓶頸拆解：symptom → immediate cause → architectural cause

### P1　一個有 85 筆命中的查詢，解壓了全庫 1/6 的正文

- **Symptom**：`SPEC.md` 讀 4,638 個 payload、285 MB JSON。`測試` 讀 154 MB。
- **Immediate cause**：候選集中在最大的十幾份文件（上表）；對這些文件，payload Bloom 幾乎不能剪枝（825→575、450→447、363→330、291→290），短詞則完全不剪枝。
- **Architectural cause**：postings 只回答「哪些**文件**同時含有這些 n-gram」（`detail=none`、rowid = document）。一旦文件被選中，整個系統就沒有任何資料結構能指出**命中在文件的哪裡**，只能靠 Bloom 猜。大型文件幾乎含有所有常見 trigram，所以 document-level postings 會系統性地選中最大的文件。成本因此正比於「候選文件的總 bytes」，而不是命中數。

### P2　payload Bloom 保留 93.7%–99.8% 的 payload

- **Symptom**：`payloadsAfterPruning / payloadsConsidered` = 4,640/4,954、460/461。
- **Immediate cause**：
  1. **飽和**：每個 payload 固定 8,192 bits、k=2；每個約 64 KiB 的 payload 產生數萬個不重複的 bigram＋trigram。模擬（照抄 `buildBloom`）：CJK 文字 5,000 字元時填充率 0.92、單一 trigram false-positive 0.85；20,000 字元以上填充率 1.000、FP 1.000。一個 64 KiB CJK payload 約 2 萬字元，**完全飽和**。
  2. **ANY 語意**：`bloomMayContainAny()` 只要含「任一個」query trigram 就保留（為了避免漏掉跨 payload 的片語）。`SPEC.md` 有 5 個 trigram，即使單一 FP 只有 0.5，任一命中的機率也有 1−0.5⁵ ≈ 0.97。而且 `spe`、`pec` 在英文內容中本來就是真陽性。
- **Architectural cause**：Bloom 被拿來做**定位**（「哪個 64 KiB 窗口含有這個片語」），這是 positional index 的工作。Membership filter 的 FP 由「每元素 bits 數」決定：1% FP 約需 9.6 bits／元素；目前約 0.1–0.4 bits／元素。

### P3　1–2 字查詢一律讀完整份文件

- **Symptom**：`測試` 的 107 次正文讀取全部是 full-document fallback（`fullDocumentFallbacks=107`），`bloomSelectedPayloads=0`。
- **Immediate cause**：`candidateFromBlooms()` 在 `terms.some(term => term.length < 3)` 時跳過 payload Bloom。
- **Architectural cause**：payload Bloom 的 ANY 語意只定義在 trigram 上。unigram postings 只是「兩個字都出現在文件某處」（`"u6e2c" AND "u8a66"`），沒有相鄰資訊。二字的相鄰證據只存在於 document Bloom 的 bigram，而它同樣會飽和：111 份只排除 2 份。

### P4　文件層級 false positive 必須讀完整份文件才能證明「沒有」

- **Symptom**：`SPEC.md` 的 106 份正文候選中有 59 份沒有命中（56%）；`測試` 有 13/107。
- **Immediate cause**：trigram AND ≠ 連續子字串；unigram AND ≠ 相鄰。另外 FTS 列是 `filename + headings + contents` 串成一個字串，跨欄位邊界的 n-gram 也會算進去。
- **Architectural cause**：沒有 positions，就無法在索引內證明不命中；證明不命中的唯一方法是讀完全文。大型文件剛好最容易成為這種「全 trigram 都有，但沒有連續出現」的 false positive。

### P5　已命中的文件也不會提早停止

- **Symptom**：命中文件仍讀完所有被選的 payload（例如某 825-payload 文件讀了 593 個）。
- **Immediate cause**：`rankDocument()` 在 phrase mode 找到第一個 content 命中後，仍繼續掃描，因為 heading 命中（rank 2）優先於 content 命中（rank 1），必須掃完才知道有沒有 heading 命中。
- **Architectural cause**：排序需要的欄位資訊（這個詞是出現在 filename、heading 還是 content？）不在索引裡，只能從正文推導。其實 heading 以明文存在 `blocks.heading`（未壓縮），但搜尋路徑沒有利用它，而是把 heading 綁在 block generator 裡一起讀。

### P6　block metadata／mapping 的 row materialization

- **Symptom**：修正前 `SPEC.md` 每次查詢讀 165 萬 metadata rows＋144 萬 mapping rows（約 5.4 s）。
- **Immediate cause**：每個 stream 取整份文件的 block metadata，以及 per-document CTE。
- **Upstream cause**：(a) 候選是整份超大文件（P1）；(b) parser 粒度很細（xlsx 一格一 block、文字檔一行一 block），一份候選文件平均 15,588 blocks，每個 block 都要一列 metadata、一列 mapping、一個 JSON tuple；(c) 從 payload 回推 block 必須經過 mapping 表，因為索引不知道 block。
- **判定**：這是 **downstream symptom**，不是 root cause。已修正的版本證明：metadata rows 從 1,652,374 降到 1,442,468 之後，blob rows 仍是 4,638，解壓 bytes 仍是 285 MB，整體只快了 11%。

### P7　每 byte 的 CPU 成本：Brotli、JSON、NFKC 都在查詢時付

- **Symptom**：`SPEC.md` 的 Brotli 1.29 s、JSON decode 1.29 s、正規化＋比對 2.17 s、重建／Map 約 2.8 s。
- **Immediate cause**：正文只以原文壓縮存放；每次查詢都要重新解壓、parse 成 JS 陣列、串接 fragment，再對每個 block 做 `normalize("NFKC").toLowerCase()`。
- **Architectural cause**：stored content（docstore）位在**候選驗證的熱路徑**上。成熟系統的 docstore 只供顯示用的 top-K 讀取；Seekah 則把它當成比對時的主要資料來源。

### P8　每份候選文件有固定開銷：常見詞會失控

- **Symptom**：`benchmark-ngram.json`：2,400 份單 block 小文件，查詢常見詞 `共同詞` 要 3.66 s（baseline）／3.88 s（ngram），約 **1.5 ms／文件**；長片語同樣是 3.6–3.7 s。**FTS postings 對常見詞沒有任何改善。**
- **Immediate cause**：每份候選文件至少要 document Bloom get、payload Bloom all、metadata query、blob query、一次 Brotli、一次 JSON.parse；而且結果集必須完整排序（總數＋排序需要每份文件的 rank）。
- **Architectural cause**：沒有 top-K。rank 所需的欄位（filename／heading／content 命中）只能從正文得到，所以每份命中文件都要讀正文。依這個斜率外推，若 `的`、`資料`、`the` 命中數萬份文件，查詢時間會是數十秒到數分鐘（**外推，尚未量測**）。

### P9　`field=filename` 仍然對所有內容候選付 Bloom I/O

`streamCandidates()` 不接收 `field` 參數，postings 查的是整份文件的串接文字。因此「只搜尋檔名」時，所有**內容**含有該詞的文件仍會逐一讀取 document Bloom 與全部 payload Bloom 列，只是 generator 最後沒有被消耗。欄位資訊沒有下推到索引。

### P10　document Bloom 佔 230 MiB，但在 postings 之後幾乎無作用

235,463 × 1 KiB ≈ 230 MiB（約為 1.37 GiB DB 的 16%）。local 版已由 postings 先取候選：`測試` 只多排除 2 份，`SPEC.md` 排除 0 份。對 ≥3 字查詢，postings 已保證所有 trigram 都存在，document Bloom 只可能在 bigram 相鄰資訊上多出一點作用。在 GitHub baseline，它是唯一的候選器，每次查詢都要讀完 230 MiB。

---

## 3. 逐題回答

**1. postings 現在實際保存什麼？**
每份文件一列 FTS5 contentless row，`rowid = documents.id`。內容是 `filename + "\n" + 每個 block 的 heading + "\n" + content` 經 NFKC＋小寫後的字串。trigram 表由 FTS5 `trigram` tokenizer 切詞；unigram 表把每個 code point 編成 `u<hex>` token。`detail=none`：doclist 只有 rowid。GitHub baseline 沒有 postings。

**2. 是否保留 payload ordinal？** 否。trace 的 `postingPayloadHits` 永遠是 0；payload ordinal 只來自 `document_payload_blooms`。

**3. 是否保留 block ID？** 否。block 只能經由 `document_payload_blocks` 從 payload 回推。

**4. 是否保留 field？** 否。只有一個 `text` 欄；filename、heading、content 串在一起，連欄位邊界都會產生 n-gram。`detail=none` 也不允許 column filter。

**5. 是否保留 position／offset？** 否（`detail=none`）。phrase 查詢因此被改寫成 trigram 的 AND。

**6. 為什麼 exact verification 仍是 correctness authority？**
因為索引證明不了任何「是」，只能證明一部分「否」：
- 沒有 positions：AND ≠ 連續出現；unigram AND ≠ 相鄰。
- 沒有 block：無法證明兩個 trigram 在同一個 block（exact match unit 是單一 block）。
- 沒有 field：無法區分 filename、heading、content，也無法產生 rank 與代表 block。
- 串接文字與 tokenizer 本身的 case folding 會產生跨欄位或 folding 差異的額外候選（只會多、不會少）。
- migration 未完成時，索引可能缺漏，只能 fallback。

所以驗證不只是「確認」，它同時還負責**定位、排序、選 snippet 的來源**，而且對整份候選文件執行。

**7. 64 KiB payload 是 storage unit 還是 search unit？**
設計上是 storage unit：壓縮 frame，也是可隨機讀取的單位（D033／D036 的理由是「大型文件不必整份解壓」）。實際上它成了 search unit：它是剪枝單位（payload Bloom）與 I/O 單位，而 exact match 單位是 block。一個 payload 在 CJK 約 2 萬字元、ASCII 約 6 萬字元，對定位來說太粗，對 Bloom 來說又太大。

**8. Bloom 在目前架構中的真正角色？**
- GitHub baseline：唯一的候選產生器（文件級），以及唯一的文件內定位器（payload 級）。
- Local：文件級 Bloom 在 postings 之後幾乎是 no-op（只有二字查詢的 bigram 還有一點相鄰資訊）；payload 級 Bloom 仍是**唯一的文件內定位器**。

**9. Bloom 是否被要求做超出 membership filter 能力的事？**
是，而且有三重超出：(a) 容量：固定 1 KiB 裝 64 KiB 文字，每元素 bits 數比 1% FP 所需低 1–2 個數量級；(b) 語意：membership 只能說「某 gram 可能在集合裡」，無法表達「這些 gram 連續出現」，於是只能退到 ANY，讓剪枝力進一步崩潰；(c) 用途：被當成定位索引（positional index 的職責），而且沒有任何 FP 監控。

**10. 哪些 query class 最差？**

| 類別 | 目前行為 | 最差原因 | 嚴重度 |
|---|---|---|---|
| 1 字（常見 CJK，例如「的」） | unigram 單 token → 命中大部分文件 → 每份都讀全文 | P3＋P8，結果集巨大且沒有 top-K | **最差**（外推為數十秒以上） |
| 2 字（例如「測試」） | unigram AND；document Bloom bigram 幾乎飽和 → 全文 | P3＋P4＋P1 | 很差（5.6–11.3 s） |
| 常見 trigram／片語（例如 `SPEC.md`） | trigram AND 選中大型文件；payload Bloom 飽和＋ANY | P1＋P2＋P4＋P5 | 很差（12–29 s） |
| 稀有 trigram | 候選很少，但只要其中有一份大型文件，就會讀近乎全文（Snipaste 461 payload） | P1＋P2 | 取決於候選中是否剛好有大型文件 |
| 長片語 | trigram 多 → AND 較精準；但 ANY Bloom 更弱（trigram 愈多，愈容易保留） | P2 | 中；合成 benchmark 常見長片語 3.7 s |
| 檔名 | 檔名命中略過正文；`field=filename` 仍付 Bloom I/O | P9 | 輕 |
| all-terms | 每個詞做文件級 AND，語意本來就是文件級 → postings 是正確的候選器；但含短詞時就走全文 | P3＋P8 | 含短詞時很差 |
| 不存在詞 | postings 回 0 → 42 ms（其中約 35 ms 是為了 trace 的 `documentsInScope` 對 scope 做的 `count(*)`。`collectHits()` 一定會建立 recorder，所以這個成本每次查詢都會付） | — | 好 |

**11. 為什麼 `SPEC.md` postings lookup 只要 5.7 ms，總時間卻 29 秒？**
因為 postings 只做了最便宜的那一半工作：把 235,463 份縮到 144 份。剩下的工作量不是由「144」決定，而是由這 144 份文件的**大小**決定（15,588 blocks／份、285 MB 解壓 JSON）。所有後續階段都是 O(候選文件 bytes)：B-tree row materialization → Brotli → JSON → 重建 → NFKC → includes。每一 byte 都要付錢，而 postings 對「這些 bytes 中哪裡有命中」沒有提供任何資訊。

**12. 為什麼 100–150 份候選文件仍然造成數千次 payload read？**
三個因素相乘：(a) 候選偏向最大的文件，10–15 份文件就佔 80–92% 的 payload；(b) payload Bloom 飽和＋ANY，對大型文件的保留率約 70–100%；(c) 2 字查詢完全不剪枝。block expansion 不是主因：擴展比例只有 1.0067×（31 個）。

**13. metadata／mapping overfetch 是 root cause 還是 downstream symptom？**
Downstream symptom。它把「讀了太多 payload」的成本再放大一次（per-block row materialization），但即使完全消除，payload 數、bytes 與驗證量都不變。已實作的修正正好是對照實驗：rows −13%／mapping −100%，wall 只到 0.889×。

**14. 如果只修 metadata overfetch，性能上限大概在哪？**
已經修了一部分：`SPEC.md` p50 從 13.77 s 到 12.24 s。假設剩下的 lookup SQL 也全部歸零（只剩約 1.0 s 的 61.8 MB blob 讀取），下限就是「與 bytes 成正比」的工作：blob 約 1.0 s＋Brotli 約 1.2 s＋JSON 約 1.3 s＋正規化／比對約 2.2 s ≈ **5.5–6 s**，再加上尚未歸因的重建與迴圈 0–2.8 s。**上限約為目前的 0.45–0.65×**，而且仍然隨候選文件大小線性成長。對常見詞（P8）沒有任何幫助。

---

## 4. 歷史決策 audit（PART 3）

### 4.1 當時到底比較了什麼

| 問題 | 2026-09-19「開發手冊」實驗 | 2026-09-19 `compare-storage-backends.mjs`（「測試用資料」） | 2026-09-26 `benchmark-ngram.mjs`（D076） |
|---|---|---|---|
| 規模 | 20 份文件、239 blocks、152,742 bytes 文字 | 151 份可解析文件、約 11.5 萬 blocks、9.6 MB 文字 | 2,400 份**合成**文件，每份 1 個短 block |
| FTS5 row 粒度 | 文件級候選（「trigram 候選皆包含全部正確文件」） | **文件**（`fts_docs` rowid = doc id，body = filename＋headings＋contents） | 文件（即 production D076） |
| positions | 未使用 | **`detail=none`、`columnsize=0`** | `detail=none` |
| FTS 的角色 | 只做文件候選過濾 | 只做文件候選過濾；之後仍解壓並做完整比對 | 只做文件候選過濾 |
| Bloom 的角色 | — | 文件候選過濾 | baseline（production Bloom） |
| **Bloom 參數** | — | **每份文件 bits = grams × 10、k = 7**（FP 約 1%），只用 trigram | production：**固定 1 KiB、k = 2**、bigram＋trigram |
| 量了什麼 | DB 大小、索引時間、5 個查詢時間、RSS | DB 大小、build 時間、12 個查詢的 hit-set p50／p95、峰值 RSS、**hit-set 相等** | index 時間、DB 大小、RSS、5 個查詢 p50／p95、result hash |
| ranking／snippet | 無 | **無**（文件明言「只計算完整命中集合」） | 有（使用產品 `search()`） |
| payload reads／解壓 bytes | 無 | 無 | 無 |
| posting list 長度 | 無 | 無 | 無 |
| 1／2 字 | 未涵蓋 | 有；FTS 與 Bloom 都回退全掃，**因此結果相同是必然的** | 有（`測試`） |
| 大型文件 | 無 | 無 | 無（每份一個 block） |
| 20 萬份以上 | 無 | 無 | 無 |
| 真實大型 store | 無 | 無 | 無（第一次真實大型量測是 D080，已在 D076 之後） |

### 4.2 當時合理、但後來被錯誤外推的結論

1. **「Bloom 候選效果接近 FTS，而空間只有一半」（D033）→ 被外推到固定 1 KiB 的 production Bloom（D038、D039）。** 實驗中的 Bloom 是依文件大小配置、k=7、約 1% FP；上線的是**固定 8,192 bits、k=2**。這兩者的 false-positive 行為差了數個數量級。實驗結論對上線的 Bloom **根本不成立**，而且 payload 級 Bloom（D039）從未被 benchmark 過。
2. **「FTS5 只多了 7.7 MiB，候選效果沒有明顯優於 Bloom」**：這只在「151 份小文件、文件級候選」的條件下成立。當時的指標是**文件候選精準度**，而在 235K 份的 store 上，文件候選其實已經相當精準（`測試` 86%、`SPEC.md` 59%）。真正的成本來自**文件內定位**，而兩個原型都沒有量到這一點。
3. **FTS5 一直只被當成「文件候選過濾器」**：09-19 的原型用 `detail=none`，D076 延續這個框架。FTS5 真正能做 substring／phrase 的能力（`detail=full` 的 positions、trigram phrase = 連續子字串）**從未被評估**，block 級 row 也沒有。
4. **64 KiB 分塊的理由是「大型文件不必整份解壓」（D033）**：這需要一個能指出「該讀哪一塊」的索引才能兌現。上線後唯一的指標是飽和的 Bloom，所以大型文件實際上仍接近整份解壓。
5. **規模**：從 151 份外推到 235,463 份。每份文件的固定開銷（P8）、GitHub baseline 每次查詢讀 230 MiB document Bloom，這些在小資料上都看不到。
6. **D076 的 benchmark 用 2,400 份單 block 的小文件**，驗證了「稀有詞變快」（87.7 → 4.2 ms）；但同一份 benchmark 顯示常見詞與長片語**沒有變快**（3.68 → 3.88 s、3.71 → 3.74 s），而且完全沒有大型文件。這個警訊沒有被處理。

### 4.3 文件裡早就寫了、但後續決策沒有守住的 warning

| 當時寫下的 warning（原文） | 出處 | 後來怎麼了 |
|---|---|---|
| 「151 份可解析文件不足以代表數萬份文件；尤其 Bloom 掃描數量與 SQLite 查詢成本仍需合成放大測試。」 | STORAGE-BACKEND-COMPARISON §限制 | D038／D039 直接上線，沒有放大測試 |
| 「正式採用前也要評估文件數增加時逐一讀 Bloom 的成本。」 | 同上 §本輪結論 4 | GitHub baseline 每次查詢逐一讀 235K 個 Bloom |
| 「原型搜尋目前只計算完整命中集合，尚未產生產品片段與最終排序；因此不能把原型時間直接當成正式 CLI 延遲承諾。」 | 同上 §比較方式 | 後續沒有任何含 ranking／snippet／I/O 的後端比較 |
| 「這批資料…不足以決定大量資料的索引體積、RAM 或後端選型。」 | SEARCH-BACKEND-EXPERIMENT §結論 | FTS5 被「暫不採用」，理由正是這批小資料的體積 |
| 「後續比較必須涵蓋一字／二字中文、長片語、標點與料號、跨區塊 all-terms、增量修改刪除及更大文字量。」 | 同上 | D076 benchmark 沒有大型文件與真實資料 |
| 「若繼續評估 Tantivy，應建立…使用官方 Rust crate 的獨立 sidecar 原型…不能把本次未完成的 Node 綁定試驗解讀為 Tantivy 核心失敗。」 | 同上 | 從未執行 |
| 「Bloom…可能誤判為候選；只有缺少某個必要 trigram 才能跳過文件。」 | D038 | 從未量測 Bloom 的 false-positive 率；payload 級飽和一直未被發現，直到本研究 |
| 「FTS 或 Bloom 不能取代可控記憶體的串流核對路徑。」 | STORAGE-BACKEND-COMPARISON | 被理解為「驗證永遠要讀全文」，而不是「候選索引要能縮小驗證範圍」 |

### 4.4 結論

過去的比較回答的是「**哪個文件級候選器比較小**」，而 235K 份文件的實際問題是「**候選文件確定後，命中在文件的哪裡**」。這個問題從未被列為比較維度，所以每個後續決策（固定 Bloom、payload Bloom、`detail=none` 的文件級 FTS、metadata SQL 修正）都在同一個框架內做局部優化。
