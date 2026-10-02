# Seekah 後續待辦

更新：2026-10-02。程式基線 **0.48.0**。公司 Windows 已由使用者驗收到 0.44；0.45、0.46、0.47、0.48 待驗。

> 新工作階段請先讀 `AGENTS.md`（或 `CLAUDE.md`）→ `docs/handoff/CURRENT.md`。本檔只列「還沒做的事」；已完成的歷史在 `docs/STATUS.md` 與 `docs/handoff/<版本>.md`，文末只留簡短索引。

## 1. 下一版規劃（0.49.0）

目前沒有已核准的 0.49.0 規劃；新增行為須先寫入 SPEC／DECISIONS。

## 2. 待使用者操作或驗收

- [ ] 公司 Windows 驗收 0.45～0.48：結果複製與選取、Toggle 開關、主題、第二片段、檔名與內文共命中、多段落、開機提醒、搜尋取消、背景更新重啟與記憶體，以及 0.48 文件庫／Codex／跨頁上下文流程。
- [ ] 本機真實索引：背景更新目前是停止狀態，由使用者決定是否重啟（建議只重啟，不需重新索引）。完整重新索引只在懷疑 §70 修正前被誤移除文件時才需要。
- [ ] 部署後觀察監看計數與 `lastTiming`：`emptyFilenameEventCount`、`uncertainRescanCount`、`degradedSubdirectories`、event→schedule、stable wait、enumerate、lock、commit；仍有新檔搜不到再判斷是否需要下一案。
- [ ] xAI（Grok）額度用完（403 spending-limit），`grok` 手下不可用，需使用者儲值。

## 3. 已知問題（尚未修）

| 問題 | 說明 |
|---|---|
| **監看漏事件** | 根因仍未證實。§86 的有界補掃、§89 的分階段計時與穩定等待重疊是防護／觀測，不是已證明的根治；本版合成實驗未重現遺失。 |
| 煙霧測試時序敏感 | 本版 `ui-smoke` 失敗清單為空；高負載下既有 API parity 案例的時序敏感性未因此宣稱已解決。 |
| 背景更新時搜尋變慢 | §91 隔離合成約 1.07x／1.05x，未重現 1.3～1.6 倍；未改 WAL、autocheckpoint 或唯讀連線設定，使用者環境仍待觀察。 |
| 新檔可搜尋時間 | §89 合成安靜案例由約 3.0 秒降至約 1.5 秒，但這不是所有拓撲與負載的固定承諾；漏事件根因仍未證實。 |
| 多段落長文件較慢 | §92 合成長文件當頁 p50 約 93 ms 降至 58 ms；詞分散於幾乎所有 chunks、legacy store 或不同負載時收益可能接近零。 |
| 逐檔穩定等待 | §89 已重疊後續檔案等待與前一檔處理；合成案例改善，實際大量搬入、格式解析與負載仍待使用者環境觀察。 |
| 公平輪替未在磁碟根規模實測 | §68、§73 與校正交錯、待辦上千筆時只有單元測試。 |
| 開機補捉未實測 | 真實登入流程、登入啟動捷徑、整顆 `C:\` 上「補上遺漏」耗時與資源只有本機模擬；TUI／CLI 沒有開啟提醒（僅 `--startup-catchup`）。 |
| **Codex rollout 格式未公開** | parser 依賴目前 Codex rollout 的欄位與事件形狀；Codex 更新可能改變格式，需重新比對真實統計與 synthetic fixture，不能視為永久相容。 |
| §70 修正前的誤刪 | 若曾在舊版背景校正跑過，可能有被誤移除的文件；重新 `index` 可補回（來源檔未被刪）。 |

小項：

- [ ] 8.3 短檔名（`PROGRA~1`）不會被預設排除；`subst` 磁碟會被當成磁碟根。
- [ ] MCP `explain_path` 沒有工作台 token，本機任何 MCP 客戶可查已登錄根內路徑的索引狀態。
- [ ] `status` 輸出新增多行（逐規則略過、既有索引排除清理、排除摘要）；依行號解析 `status` 的外部腳本可能位移。
- [ ] `compact` 在 `cli.ts` `main` 的 try／catch 外，SQLITE_BUSY 可能未轉成 INDEX_BUSY；`rememberError`（`live-update.ts`）未分類 recovery 類，可能記成 `LIVE_UPDATE_FAILED` 加 SQLite 原文。
- [ ] `LiveUpdateEngine` 建構時 `cleanupOrphanRoots` 無 try/catch；工作庫損壞或鎖住時 engine 可能起不來（推測實害低，雙程序已有 lease）。
- [ ] 工作台 `/api/index-status` 沒有儲存容量欄位，不列出 `-wal`／`-shm`（只有命令列 `status` 會）。
- [ ] 寬查詢 soak HandleCount 675→724 來源未查明；正常關閉後 `-wal` 仍可能殘留（寬查詢 10 分鐘約 28 MiB），推測為最後關閉者是唯讀連線。
- [ ] `.writer.sqlite`、`.live.sqlite`、`.work.sqlite` 是否也該 WAL 未定。
- [ ] 設定頁其餘非開關型控制（下拉選單等）是否統一風格，待使用者回饋。
- [ ] 所有使用中索引都遷移後，移除遷移期舊搜尋路徑（Bloom／文件級 postings）程式碼。
- [ ] 原 ADR 前補證清單：all-terms／`field`／`sort`／type／root／subtree 等價；top-K／total count 語意（`e` 156,218 筆約 3.3 s）；C2 大小縮減。

## 4. 暫不做／長期選項

- **Obsidian 整合**：使用者於 2026-10-02 提出；監工建議先用 Obsidian 內建 Tasks／Bases 整理 763 個散落待辦，只有確認需要跨 vault 連動後再排入。
- **硬性「N 行內」鄰近搜尋與正規表示式**：使用者 2026-10-02 表示全部詞模式已夠用，使用一陣子再評估。正規表示式在五十萬筆規模太慢且不易用，預設不做。
- **MCP 改傳檔案路徑讓 Codex 自己讀檔**：使用者 2026-09-29 表示之後再處理，需另寫 SPEC。
- **架構方案 B／C**：單一擁有者程序、不可變區段＋原子切換。0.43.0 的 WAL＋有界等待已消主路徑讀擋寫，不採用；再出現鎖定問題才重評。
- 拖曳文件的段落／頁面／工作表細選與單檔文字預覽；UI 副檔名／根目錄篩選、已選籃排序、鍵盤快速鍵、螢幕閱讀器驗證；token／context 預估。
- 聊天助手、本機模型 provider（Ollama／llama.cpp）、OpenAI／xAI OAuth：都需先另定 Provider、帳務、Key、外傳資料與 SSRF 邊界；目前不提供。
- Windows 全套安裝器與一般應用捷徑；OCR、圖片、資料夾拖曳、舊版 Office 新格式（需有真實需求與安全 parser 方案才排入）。
- **TUI 易用性**：使用者回報互動不直覺；GUI 索引、搜尋與複製工作流穩定後最後再重做，不在目前批次變更。
- PDF／PPTX／XLS 真實錯誤只在公司電腦依 `COMPANY-WINDOWS-DIAGNOSTICS.md` 診斷，建立無機密最小重現後再修 parser。

## 5. 明確不是缺陷

- ChatGPT Plus／Pro 與 OpenAI API 分開計費；SuperGrok／X Premium 與 xAI API 也分開。不以抓 cookie 或模擬登入規避。
- 工作台不保存對話、API Key 或拖曳內容是刻意的隱私設計；日後若要保存，須先定義加密、刪除與公司資料治理。
- 本機 server 不暴露至 LAN／Internet，也不代理任意 endpoint；遠端 ChatGPT 網頁不會直接讀本機索引。

## 6. 已完成（封存索引，不必逐條讀）

| 版本 | 內容 | 詳見 |
|---|---|---|
| 0.48.0 | 文件庫最近／釘選／分類／已存搜尋、Codex session／Reference Set、跨頁上下文、結果操作列與表格更多選單（§94～§100／D127～D136）；build 通過、`npm test` 524 項（521 通過、0 失敗、3 略過）、ui-smoke 失敗清單為空、search-diff 基準 0.47.0（`e4f06bb`）小型 650／大型 30，錯誤 0、差異 0 | `handoff/0.48.0.md` |
| 0.47.0 | 主題切換、第二片段、檔名與內文共命中、all-terms 最近詞、監看分階段計時與穩定等待重疊、背景寫入搜尋慢化調查、長文件多段落候選讀取（§87～§89、§91～§92；§90／D122 空號） | `handoff/0.47.0.md` |
| 0.46.0 | 搜尋 worker 與取消、無結果搜尋、狀態快取、監看補掃（§83～§86） | `handoff/0.46.0.md` |
| 0.45.0 | 結果可複製、Toggle 開關、多段落結果、開機補捉與開啟提醒（§78～§82） | `handoff/0.45.0.md` |
| 0.44.x | 背景更新公平輪替與誤刪修正、預設排除與可見性、手動重新檢查、搜尋加速、中文路徑修正、煙霧測試（§68～§77） | `handoff/0.44.0.md`～`0.44.2.md` |
| 0.43.0 | 主索引 WAL、有界 busy 等待、固定 INDEX_BUSY 訊息（§65～§67） | `handoff/0.43.0.md` |
| 0.38～0.42 | 區段儲存與 C2-hybrid 搜尋、局部更新分批與輪替、搜尋引擎式列表、失敗 scope 拆分、遷移重試（§50～§64） | `STATUS.md` |
| 0.37.0 | 增量更新、持久事件 queue、directory frontier、登入啟動、GUI 加入根目錄與垃圾桶、FTS5 postings、Diagnostics（§46～§49） | `handoff/` |
| 0.36.x | 三區 GUI、correctness／UX、TUI 焦點與鍵盤層 | `handoff/0.36.1.md`、`0.36.2.md` |
| 更名 | Seekah；保留 LocalDocSearch 資料目錄、環境變數與 MCP 識別 | `AGENTS.md` |

公司 Windows 驗收：0.36～0.44 使用者已回報沒問題（2026-10-02）；0.45～0.48 尚待使用者驗收。
