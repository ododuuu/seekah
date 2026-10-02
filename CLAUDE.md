# Seekah — Claude Code 接手指引

@AGENTS.md

以上是專案的固定工作規則（先讀 SPEC／STATUS／DECISIONS／handoff）。下面是新工作階段接手時最常用的資訊。

## 開工順序

1. `git status`、`git log --oneline -5`，確認在預定工作分支且乾淨。
2. 讀 `docs/handoff/CURRENT.md`，再讀它指向的版本交接（目前 `docs/handoff/0.47.0.md`）。
3. 讀 `docs/NEXT-TODO.md` 第 1～3 節：下一版規劃、待驗收、已知問題。
4. 使用者的下一個指示優先；沒有指示時，從 NEXT-TODO 第 1 節（下一版規劃）開始，並先確認範圍。

## 常用指令

- 建置與全部測試：`npm test`（含 TypeScript build，合併後 498 項、495 通過、0 失敗、3 略過）。
- 單一測試：`npm run build` 後 `node --test dist/test/mNN.test.js`。
- 工作台前端改動**必跑**：`node scripts/ui-smoke.mjs`（需本機 Chrome，1180×800、1440×900 與 1920×1080；失敗清單必須為空；結束後確認沒有殘留 daemon／Chrome）。
- 搜尋程式改動**必做**差分測試：`scripts/search-diff.mjs`（小型 650、大型 30；新舊結果需 0 差異）。

## 安全紅線（使用者資料）

- **不得讀取、複製或開啟**使用者真實資料目錄 `%LOCALAPPDATA%\LocalDocSearch\` 及其備份 `%LOCALAPPDATA%\LocalDocSearch-backup-*`（內含文件文字）。測試一律用 `LOCALDOCSEARCH_DATA_DIR` 指向暫存目錄與合成資料。
- 不得對真實索引執行 index／reindex／autoupdate，也不得停止或啟動使用者的背景更新；這些交給使用者自己操作。對真實索引只能做唯讀探測（例如 `scripts` 裡 scratchpad 式的唯讀計時）。
- 不上傳文件內容、不連網、不寫入 Desktop／Documents。測試中啟動的 daemon、workbench、Chrome、`subst` 都要在結束前停止。
- 不得宣稱「公司 Windows 已通過」，除非使用者回報。目前驗收到 0.44。
- 不得 force-push。使用者自己在 PowerShell push（本環境沒有 GitHub 憑證）。

## 開發流程（已沿用的做法）

- 重大工作用 D093：每項工作一條分支＋一個 git worktree（`C:\Users\mains\seekah-wt\<名稱>`），完成後合併回 `main`。worktree 的 `node_modules` 是 junction：移除前先 `cmd /c rmdir <path>\node_modules`，再 `git worktree remove --force`。
- 若用 omp 手下（pi、pi2、pi3、pi4 = GPT-5.6-luna，經 herdr pane 派工；grok 額度用完不可用）：**我只信自己重跑的驗證，不信手下報告**；手下**沒有 commit 就不算完成**；明確禁止他們改 `docs/STATUS.md`、`docs/NEXT-TODO.md`、`docs/handoff/`、`package.json` 版本（由合併者統一更新）；每項行為變更要有反向驗證（拿掉修正測試必須失敗）；搜尋變更要有差分測試。
- 文件編號：SPEC 章節遞增（目前到 §92；§90 為空號）、DECISIONS 由新到舊（目前到 D124；D122 為空號）、測試檔 `test/mNN.test.ts`（目前到 m88）。
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

- 版本 0.47.0，GitHub `main` 由使用者自行 push；本機真實索引的背景更新為停止狀態。
- 0.47.0 已合併 §87～§89、§91～§92；§90／D122 未使用，保留為空號。合併後 main 的 `npm test` 為 498 項、495 通過、0 失敗、3 略過。
- 本版完成主題切換、第二命中片段、檔名與內文共命中、多段落最近詞選擇、監看分階段計時與穩定等待重疊，以及長文件多段落候選讀取縮減。
- 監看漏事件根因仍未證實；背景寫入期間搜尋慢化在本版合成負載約 1.07x，未重現 1.3～1.6 倍，因此未改 WAL／autocheckpoint／唯讀連線設定。
