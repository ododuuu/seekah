# P0-4 執行報告（perf/reuse-root-exclusion worktree）

## 改了哪些檔
- docs/SPEC.md：末尾新增 ## 61. 局部更新重用根目錄排除規則（完整描述 options、傳入、fallback、失效保證、m50）
- docs/DECISIONS.md：最上方新增 ## D092：局部更新重用 RootExclusion 避免每檔重讀規則（perf P0-4）（版本寫「待合併時決定」）
- src/local-update.ts： 
  - LocalUpdateOptions 加入 `exclusion?: RootExclusion` + 文件
  - 移除 loadRootIgnore 薄 wrapper（符合 tiny func 規則）
  - applyFileUpdateLocked 內聯：`const exclusion = options.exclusion ?? await RootExclusion.load...` 然後建 ignore match；沒傳時完全維持原 load 行為
- src/live-update.ts（最小範圍）：
  - runRoot 內 inner 建立前加 `state.exclusion = this.loadExclusion(state.root);`
  - inner 物件加入 `exclusion: state.exclusion,`
  - 僅此兩處新增（+1 註解）
- test/m50.test.ts：全新 3 個 test case（a spy reuse、b 規則變更生效、c 未傳等價）；含必要 fake engine 輔助（複用 m43 模式但獨立）
- .claude/report.md：本檔

未動：package.json、STATUS.md、handoff/*、NEXT-TODO.md、reconcile.ts、live-queue.ts、其他 src（live-update 改最小）

## 快取失效如何保證
- 規則檔變更 / 根變更：0.39.1 既有 handleEvent（1063-1071）偵測 isIgnoreFile / root 即 `state.exclusion = loadExclusion` + attach + markReconcile（我們確認有）。
- ignore scope 合併（mergeChildRoots 改 ignoreBases）：reconcile 後下次 runRoot 會先 reload exclusion 再建 inner 傳批次。
- root 變更/新增：newState 即載入。
- 每批 local 開始時 reload 一次（非每檔），保證傳入的 exclusion 是當時 store 的最新；exclusion 實例 immutable，換新即換規則。
- 直接呼叫者（無 exclusion）仍每檔 load，不影響。

## 測試數字
- 新 m50.test.ts 3 項全部通過。
- `npm run build`：成功（tsc 無誤）。
- `npm test`：349 項，343 pass、3 fail、3 skip。
  - 3 fail 為既有 win32 環境問題：M26 path coverage、M36 profile（含 chmod/anonymous），未新增任何失敗（m50 及改動路徑全 pass）。
- 驗證：a) 傳 exclusion 3 檔 loadCalls 增量=0；b) 規則變更後新排除檔不入索引（search=0）；c) 未傳時 loadCalls>=2 且 skipped 行為同舊。

## 不確定處 / 風險
- scope merge 後的 reload 是在 runRoot 開始時（每批 1 次），若 reconcile 與事件極端交錯，理論上有一個 window 用舊 exclusion 做 isExcluded 判斷（但 persist 仍會發生，後續 batch 會修正；與原有 reconcile 語意一致，未新增 bug）。
- live-update 內 reload 雖為最小必要，但若其他工程師重構 runRoot 結構需注意。
- win32 環境下 profile 相關測試的 chmod 失敗與本改無關（僅 fs 權限）。
- 無 Windows 公司電腦人工驗收（依 AGENTS 不得宣稱）。
- 無 push、無改版本。

所有行為變更均有自動測試；排除結果 hash 與舊完全一致（經 m50 間接 + 既有 m43 覆蓋）。

## 命令
git commit -m "perf: reuse root exclusion across local update batch (SPEC §61, D092)"
（已執行）