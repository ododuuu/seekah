# Seekah 搜尋架構研究：Executive Summary

日期：2026-09-27。詳細內容見同目錄的 4 份文件。所有數字來自真實 235,463 份文件的 store（1.37 GiB）。

**1. Seekah 現在到底怎麼搜尋？**
FTS5 postings（local 才有；`detail=none`，每份文件一列）只回傳「同時含有這些 n-gram 的**文件 ID**」。之後系統對每份候選文件：讀 1 KiB 文件 Bloom、讀所有 payload Bloom（任一 trigram 命中就保留；1–2 字不剪枝）、把被選的 64 KiB Brotli＋JSON payload 全部解壓、重建 blocks、逐 block 做 NFKC＋小寫＋`includes`，由此決定是否命中、rank（檔名 > heading > content）與代表 block。最後只為當頁結果回讀 snippet。GitHub baseline 沒有 postings，會逐一讀完全部 235K 份文件的 Bloom。

**2. 最大問題是什麼？**
索引只能指出「哪份文件」，不能指出「文件的哪裡」。而 document-level n-gram 候選會系統性地選中最大的文件：10–15 份文件就佔 80–92% 的讀取量。所以成本正比於**候選文件的大小**，而不是命中數。`SPEC.md` 的 postings 只花 5.7 ms，但只有 85 筆命中的查詢解壓了全庫 1/6 的正文（4,638 個 payload，285 MB）。唯一能在文件內定位的 payload Bloom 是固定 1 KiB、k=2，在 64 KiB 文字上已經飽和（實測保留 93.7–99.8%）。metadata／mapping overfetch 只是下游症狀：修掉之後 payload 數不變，只快了 11%。

**3. 過去選 Bloom／FTS 的比較哪裡不完整？**
- 比的是 151 份小文件上「文件候選的精準度」與 DB 大小，沒有量 payload reads、解壓 bytes、ranking／snippet、大型文件或 20 萬份規模。
- FTS5 只測過 `detail=none` 的文件級 row，從未測 positions 或 block 級 row。
- 實驗中的 Bloom 是依文件大小配置、k=7（約 1% FP）；上線的卻是固定 1 KiB、k=2，所以實驗結論根本不適用於上線版本。payload Bloom 從未被 benchmark。
- 文件中已經寫了「151 份不足以代表數萬份」「需要評估逐一讀 Bloom 的成本」「應做 Tantivy 官方 sidecar 原型」等 warning，後續都沒有執行。

**4. 成熟系統共同做法是什麼？**
讓索引**證明**命中，而不只是排除不可能：positions，或讓 posting 粒度對齊 match 單位（Zoekt 的 positional trigram＋最稀有 n-gram；Lucene／Tantivy／Xapian／FTS5 `detail=full` 的 phrase）。stored content 只在 top-K 顯示時讀取（Tantivy docstore、Lucene stored fields、Recoll 的 snippet 文字）。檔名與內容分開索引。短查詢有專門路徑（CJK unigram＋bigram term）。沒有成熟系統用固定大小的 Bloom 做文件內定位。Seekah 目前等於 Google Code Search 的架構（文件級 postings＋全文驗證），但缺少讓它成立的前提：候選檔案小、未壓縮、驗證便宜。

**5. 哪些現有元件應保留？**
多格式 parser 與 `TextBlock` 模型、`documents.id` stable reference、`blocks` 表、64 KiB Brotli payload（改為只給 snippet／context 使用的 docstore）、payload↔block mapping（給 snippet 用）、逐文件 transaction 與可接續 migration 框架、root 管理、read-only 契約、`makeSnippet`、rank 語意、SearchSession／分頁、trace schema 3。FTS5（`node:sqlite` 內建，Windows 可攜）本身也應保留，只是要換用法。

**6. 哪些層可能需要重做？**
候選／定位層：文件級 `detail=none` postings、文件 Bloom（約 230 MiB）、payload Bloom，以及「對整份候選文件逐 block 驗證與排序」的熱路徑。排序所需的欄位訊號（filename／heading／content 命中）應該來自索引＋metadata，而不是正文。

**7. 現架構優化上限在哪？**
- 只做 SQL cleanup：`SPEC.md` 最好約 5.5–8 s（目前 12.2 s），`測試` 約 3–4 s。瓶頸是「候選 bytes × 每 byte 成本」，約 20 ms／MB；常見詞完全不改善。
- 加上 payload 級 postings（無 positions）：`SPEC.md` 約 1–6 s；1–2 字 CJK 幾乎不改善。
- position-aware 的 block 級搜尋：延遲形狀改為取決於 posting 長度與命中數。估計 `SPEC.md`／`測試` 為 0.05–0.5 s；常見 1 字受結果集大小支配，約 0.5–5 s。以上都是估計，必須由 prototype 驗證。

**8. 下一個 prototype 應驗證什麼？**
在真實 store 的**複製檔**上，以 disposable 腳本比較 A（現況）、B（payload 級 postings）、C1（block 級 FTS5 `detail=none`＋unigram／bigram token）、C2（block 級 `detail=full` phrase）、D（短查詢策略，含「以 fts5vocab 挑最稀有 trigram」）。要回答的問題：
- 索引大小是否可接受（C2 是最大風險）。
- block 級 posting 能否在不讀正文的情況下產生**完全相同**的結果集、排序與 snippet（1,000 個隨機子字串的差分測試）。
- 常見 1 字與常見 trigram 的 posting 成本。
- migration 時間與中斷後接續。

在 prototype 結果與 ADR 核准之前，不寫 implementation SPEC。
