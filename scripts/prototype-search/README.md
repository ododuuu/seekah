# 搜尋架構 prototype（一次性，不是產品程式）

依 `PROTOTYPE-HANDOFF.md` 與 `docs/research/search-architecture-2026-09-27/SEEKAH-SEARCH-ARCHITECTURE-OPTIONS.md` §4，在真實 235,463 份文件 store 的**複本**上建置並比較 A／B／C1／C2／D 五種索引。結果與結論見 `docs/research/search-architecture-2026-09-27/PROTOTYPE-RESULTS.md`。

## 隔離規則

- 不 import、不修改 `src/`。A 使用已編譯的 `dist/src`（目前 build）作為 oracle；其他變體只重用 `dist/src/search.js` 的 `makeSnippet()`。
- 真實索引只以 SQLite backup API 讀取一次，產生 `snapshot.db`（檔案設為唯讀）。所有變體各自一個 `.db`，放在 `PROTOTYPE_DATA_DIR`（預設 `C:/Users/mains/seekah-prototype-data`，不在儲存庫內）。
- 資料目錄內的 query、snippet 與差異明細含有文件文字，只留在本機；`report.mjs` 產生的儲存庫摘要不含正文、抽樣查詢文字或路徑。
- 範圍：phrase mode、`field=all`、`sort=relevance`、無 type／root 篩選。all-terms、`field=filename|content` 與排序選項沒有涵蓋。

## 執行順序

```text
node build.mjs --variant fields|B|C1|C2      # 可中斷接續（built_docs marker）
node gen-queries.mjs                          # seed 20260927：1,000 真實子字串＋1,000 合成字串
node truth.mjs --shard i/12 ; node truth.mjs --merge 12   # 暴力 ground truth
node run-diff.mjs --engine A|B|C1|C2|D --shard i/n [--sub k/m]
node compare.mjs                              # correctness.json
node sizes.mjs                                # sizes.json
node migration.mjs --limit 3000               # kill／resume、delete／reinsert 等價
node bench.mjs --select ; node bench.mjs --engine X        # 依序執行，機器不做其他工作
node costmodel.mjs --queries ; node costmodel.mjs --documents
node report.mjs --out <dir>                   # bench.csv＋prototype-summary.json
```

## 變體

| 代號 | 索引 | 查詢路徑 |
|---|---|---|
| A | 現有文件級 FTS5 `detail=none`＋文件／payload Bloom | 產品 `collectHits()`／`materializeHits()` |
| B | payload 級 FTS5 `detail=none`（trigram＋unigram；跨 payload 邊界另存 8＋8 字元 boundary row） | 每個 gram 取 payload rowid 集合，單一 payload 或「i、i+1、boundary」組合含全部 gram 才讀；讀 owning block closure 後照 A 規則驗證 |
| C1 | block 級 FTS5 `detail=none`：content trigram／unigram token／bigram token；檔名與 heading 另表 | 1／2 字 token 精確、不讀正文；≥3 字依 ordinal 驗證候選 block，第一個真命中即停 |
| C2 | block 級 FTS5 `detail=full`：content trigram phrase／unigram phrase；檔名與 heading 另表 | phrase 直接證明連續出現，不讀正文；只為當頁 snippet 讀 payload |
| D | C2 的 `detail=full` trigram＋C1 的 unigram／bigram token | ≥3 字以 fts5vocab 取兩個最稀有 trigram 的 instance offset 做距離檢查，未覆蓋整個查詢時驗證；1／2 字走 C1 |

檔名（`fname_*`）與 heading（`head_*`＋`heading_map`，每份文件的不同 heading 去重並記最小 ordinal）放在 `fields.db`，B／C1／C2／D 共用；檔名與 heading 本身是明文，候選一律在 JS 以 `normalize().includes()` 驗證。

含 NUL 的查詢：SQLite 會在 NUL 截斷 FTS5 查詢字串，因此含 NUL 的 trigram 改用 unigram token（C2 用 unigram phrase，仍然精確；其他變體驗證）。
