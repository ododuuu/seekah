# 搜尋核心差分驗證

`scripts/search-diff.mjs` 只使用本機合成資料，比較 baseline 與 new 工作樹的 `dist/src/search.js`／`dist/src/store.js`。不讀取 `%LOCALAPPDATA%\LocalDocSearch\`，不啟動 daemon，也不呼叫外部服務。

## 執行

先在兩個工作樹各自建置，再於本工作樹執行：

```powershell
node scripts/search-diff.mjs `
  --base C:/path/to/baseline-worktree `
  --new C:/path/to/new-worktree `
  --phase all `
  --corpus C:/Users/mains/AppData/Local/Temp/seekah-search-diff-corpus `
  --data C:/Users/mains/AppData/Local/Temp/seekah-search-diff-data `
  --large C:/Users/mains/AppData/Local/Temp/seekah-search-perf-repro-data `
  --out-dir C:/Users/mains/AppData/Local/Temp/seekah-search-diff
```

必要參數：

- `--base`：baseline 工作樹根目錄；工具執行其 `dist/src/cli.js` 建立合成 index，並載入其 `dist/src/search.js` 與 `dist/src/store.js`。
- `--new`：待驗證工作樹根目錄。

選用參數：

- `--phase generate|small|large|all`，預設 `all`。`generate` 只建立 corpus／index；`small` 只跑 650 組；`large` 只跑 30 組。
- `--corpus`：合成文件輸出目錄。
- `--data`：CLI 暫時資料目錄；index 完成後使用其 `LocalDocSearch/index.db`。
- `--large`：既有大型合成資料根目錄，預期含 `LocalDocSearch/index.db`。
- `--out-dir`：差分 JSON 與 roots manifest 輸出目錄。

`--phase small` 或 `--phase all` 會重用 `--out-dir/search-diff-roots.json`；若分開執行，先跑 `generate`。所有目錄都應指向暫存位置，不可指向正式使用者資料。

## 比較範圍

小索引固定涵蓋 phrase／all-terms、filename／content／all、三種排序、分頁、total mode、extension／status／root／subtree scope、ASCII／Unicode／NFKC／補充平面字元、跨段落邊界、filename-only 與長數字查詢；隨機查詢補足至 **650 組**。

大型合成索引執行 **30 組**，包含欄位、排序、分頁、短詞、長詞與無結果查詢。每組查詢以交錯順序分別執行 baseline／new，避免單一工作樹固定先熱身。

比較項目：

- total、total relation、page、page size、page count、start、end。
- ranked 結果的 document ID、source kind、block ordinal 與結果欄位。
- materialized page 的完整穩定欄位；只移除 `passages` 與 `omittedTerms`，避免段落展示數量使核心差分混入 UI 表現差異。
- 同一錯誤訊息視為 common error；錯誤與成功、錯誤內容不一致都算 mismatch。

輸出 `search-diff-small.json` 與 `search-diff-large.json` 的 `mismatchCount` 必須為 `0`，`compared` 必須分別為 `650` 與 `30`。`timingSummary` 只作觀察，不改變差分判定。
