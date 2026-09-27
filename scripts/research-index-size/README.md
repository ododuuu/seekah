# 索引大小研究（一次性，不是產品程式）

結果與結論見 `docs/research/index-size-2026-09-28/RESULTS.md`。

- 不 import、不修改 `src/`。資料放在 `RESEARCH_DATA_DIR`（預設 `C:/Users/mains/seekah-prototype-data/size-2026-09-28`，不在儲存庫內），其中含文件正文，只留在本機。
- `snapshot.db` 是在暫停背景自動更新時，複製的真實 index。

## 執行順序

```text
node export.mjs                 # snapshot.db → corpus.db（每段原文＋NFKC 小寫）
node stats.mjs                  # 語料大小、段落長度、壓縮率
node queries.mjs                # 225 個查詢＋暴力比對標準答案（truth.json）
node run.mjs --engine scan|trigram|trigram-scanshort|sparse --chunk 65536   # 建置、比對標準答案、量大小與延遲
node probe-scan.mjs             # 全掃拆解：讀出／解壓／比對
node probe-parallel.mjs 65536   # 1–16 worker 全部驗證
node probe-topk.mjs 65536       # 依修改時間走訪、找滿第一頁／計數到 10,000 即停
node probe-normalize.mjs        # NFKC＋小寫吞吐量
node locations.mjs              # 段落位置可推算比例
```

`tantivy-bench.mjs` 需要另外在暫存目錄 `npm i @oxdev03/node-tantivy-binding@0.3.3` 後執行：`node tantivy-bench.mjs T1|T1b|T2|T3`。
