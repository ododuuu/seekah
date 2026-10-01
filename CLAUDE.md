# Seekah — Claude Code 接手指引

@AGENTS.md

以上是專案的固定工作規則（先讀 SPEC／STATUS／DECISIONS／handoff）。下面是新工作階段接手時最常用的資訊。

## 開工順序

1. `git status`、`git log --oneline -5`，確認在 `main` 且乾淨。
2. 讀 `docs/handoff/CURRENT.md`，再讀它指向的版本交接（目前 `docs/handoff/0.46.0.md`）。
3. 讀 `docs/NEXT-TODO.md` 第 1～3 節：下一版規劃、待驗收、已知問題。
4. 使用者的下一個指示優先；沒有指示時，從 NEXT-TODO 第 1 節（下一版規劃）開始，並先確認範圍。

## 常用指令

- 建置與全部測試：`npm test`（含 TypeScript build，約 6 分鐘，目前 485 項通過、3 略過）。
- 單一測試：`npm run build` 後 `node --test dist/test/m79.test.js`。
- 工作台前端改動**必跑**：`node scripts/ui-smoke.mjs`（需本機 Chrome，1440×900 與 1180×800；失敗清單必須為空；結束後確認沒有殘留 daemon／Chrome）。
- 搜尋程式改動**必做**差分測試：`scripts/search-diff.mjs`，說明見 `docs/SEARCH-DIFF.md`，新舊結果需 0 差異。

## 安全紅線（使用者資料）

- **不得讀取、複製或開啟**使用者真實資料目錄 `%LOCALAPPDATA%\LocalDocSearch\` 及其備份 `%LOCALAPPDATA%\LocalDocSearch-backup-*`（內含文件文字）。測試一律用 `LOCALDOCSEARCH_DATA_DIR` 指向暫存目錄與合成資料。
- 不得對真實索引執行 index／reindex／autoupdate，也不得停止或啟動使用者的背景更新；這些交給使用者自己操作。對真實索引只能做唯讀探測（例如 `scripts` 裡 scratchpad 式的唯讀計時）。
- 不上傳文件內容、不連網、不寫入 Desktop／Documents。測試中啟動的 daemon、workbench、Chrome、`subst` 都要在結束前停止。
- 不得宣稱「公司 Windows 已通過」，除非使用者回報。目前驗收到 0.44。
- 不得 force-push。使用者自己在 PowerShell push（本環境沒有 GitHub 憑證）。

## 開發流程（已沿用的做法）

- 重大工作用 D093：每項工作一條分支＋一個 git worktree（`C:\Users\mains\seekah-wt\<名稱>`），完成後合併回 `main`。worktree 的 `node_modules` 是 junction：移除前先 `cmd /c rmdir <path>\node_modules`，再 `git worktree remove --force`。
- 若用 omp 手下（pi、pi2、pi3、pi4 = GPT-5.6-luna，經 herdr pane 派工；grok 額度用完不可用）：**我只信自己重跑的驗證，不信手下報告**；手下**沒有 commit 就不算完成**；明確禁止他們改 `docs/STATUS.md`、`docs/NEXT-TODO.md`、`docs/handoff/`、`package.json` 版本（由合併者統一更新）；每項行為變更要有反向驗證（拿掉修正測試必須失敗）；搜尋變更要有差分測試。
- 文件編號：SPEC 章節遞增（目前到 §86）、DECISIONS 由新到舊（目前到 D118）、測試檔 `test/mNN.test.ts`（目前到 m82）。
- 發版：改 `package.json`／lock 版本、寫 `docs/<版本>-VALIDATION.md` 與 `docs/handoff/<版本>.md`、更新 `handoff/CURRENT.md`、`handoff/README.md`、`STATUS.md`、`NEXT-TODO.md`、`README.md`；跑 `npm test` 與 `ui-smoke`；commit。報告要誠實：量測受負載影響時註明，沒重現的問題不說已解決。

## 已踩過的坑（不要重犯）

- 已否決的實驗，勿重試：reconcile 依 mtime 排序目錄；reconcile 把近期檔案延後給局部佇列。
- 前端 `state` 初始物件被誤刪欄位會讓工作台卡在「讀取中…」；`test/m69.test.ts` 與 ui-smoke 會抓。
- PowerShell 選擇器輸出是 CP950，必須 Base64 傳回（`src/folder-picker.ts`）。
- PowerShell 5.1 的 `Invoke-WebRequest` 進度條會讓計時變大，量時間用 `curl.exe`。
- 合併時文件衝突用 scratchpad 的「保留雙方再依編號排序」做法；commit 前必須確認無衝突標記，串接指令用 `&&`／`set -e`，不要用 `;`。
- 用命令列比對找殘留程序時，比對命令本身會自我命中，要排除。
- 工作台搜尋在 worker thread 跑，`decompressedChunkCacheBytes` 預設為 0（有意關閉）。

## 目前狀態摘要

- 版本 0.46.0，GitHub `main` 由使用者自行 push；本機真實索引的背景更新為停止狀態。
- 下一版規劃：主題切換鈕（自動／淺色／深色）、單詞與片語模式第二處命中片段、檔名命中時顯示內文片段、多段落小修。
- 監看漏事件根因未證實，部署後看 status 計數再決定。
