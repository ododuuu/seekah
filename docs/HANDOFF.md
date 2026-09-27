

# 跨對話交接方式

> **交接入口已固定搬至 [docs/handoff/README.md](handoff/README.md)。請先讀 [CURRENT.md](handoff/CURRENT.md) 與 [0.36.2.md](handoff/0.36.2.md)。**
>
> 品牌已更名 Seekah；以下內容只保留歷史根因／舊連結，不再作為目前開工 prompt。目前程式為 0.36.2；公司 Windows 待驗項以固定交接中心及 STATUS 為準。

## 已實作：0.36.1；目前只做驗收（2026-09-23）

0.36.1 已依 [SPEC §45](SPEC.md#45-0361windows-掃描正確性與-tui-可操作性修正)／D054 完成本機實作、缺陷回歸與版本更新。公司 Windows 人工驗收尚未回報；不得將 macOS 測試寫成 Windows 通過。驗證證據見 `0.36.1-VALIDATION.md`。

完成項目：

1. scanner 回傳最小 `protectedScopes`；store 刪除只跳過失敗 scope，正常 sibling 可移除，root failure 與 rebuild 保留既有資料。同步報告另列保護數。
2. `src/builtin-paths.ts` 是 Windows volume-root 系統目錄的唯一判定；完整 scan、watch、local/live update 共用。只匹配 drive／UNC share root 直接子目錄 `$RECYCLE.BIN`、`System Volume Information` 及其後代。
3. profile 保留 exclusive create、不建父目錄、不展開字面變數；錯誤顯示安全 resolved parent、code、CMD 與 PowerShell 範例，且在索引寫入前失敗。
4. TUI 改用 raw key event queue與 focus／cursor／view state。↑↓、Space、Enter、PgUp／PgDn、Esc／←、Tab、結果區 q、Ctrl+C／Ctrl+D 與 resize 已接到真實 CLI；slash command fallback、穩定文件代碼與 context `yes` 重驗契約保留。
5. package／lockfile 已升 0.36.1。公司後續只用無機密 sibling 權限測試樹及 80×24／120×40 Windows Terminal 驗收；不可拿整個公司索引作破壞性 deletion 實驗。

目前不得直接實作 0.37.0。先完成固定交接中心列出的公司 Windows 0.36.1 人工驗收；只有 `docs/handoff/CURRENT.md` 明確前進後，才可依 SPEC §46、D055／D056 開始後續版本。下列 0.37.0 內容僅保留歷史規劃。

### 歷史規劃：0.37.0 接續工作

1. 用正確 profile 路徑量 full reconciliation 各階段；CMD 用 `"%USERPROFILE%\Desktop\lds-profile.json"`，PowerShell 用 `"$env:USERPROFILE\Desktop\lds-profile.json"`。現有公司數字只有總耗時，不可先寫死根因比例。
2. 先驗證現有 `autoupdate`：`src/live-update.ts` 的檔案事件會走 `applyPathChange()`，目錄事件才掃最小子樹；unknown filename、ignore change、queue >10,000 等才 full reconciliation。`src/autoupdate.ts` 預設 6 小時，啟動時掛 watcher 後 full sync，沒有 service／自啟，pending queue 在記憶體。
3. 將它整理成日常主流程與 status 觀測。小型穩定測試檔的事件至搜尋可見應在 15 秒內，非週期校正時不得 root scan。程序關閉期間由下次 start 的分批背景校正補回，未完成時顯示未確認；手動 `index` 語意不變，也不新增 `--full`。
4. all-terms 先做 0.36.0 benchmark，再讓所有 Bloom 可表示的必要長詞以 `every` 安全淘汰 document candidate。只要含短詞，通過候選的文件仍需全文精確驗證；跨 payload 的長短詞必須命中，結果集合與基線逐筆相同。
5. 公司電腦不能有管理員權限：USN 不再是實作或 RFC 待辦。依下方順序完成 SPEC §46.6～§46.10 的普通使用者背景更新。

### 歷史規劃：0.37.0 分階段交付

> 請先確認最新 main 已完成 SPEC §45 的 0.36.1；若尚未完成，先交付 0.36.1。接著實作 SPEC §46／D056：watcher 在 0.31.0 已存在，先用既有 autoupdate 量測事件局部更新，再擴充同一 LiveUpdateEngine。公司只能普通使用者，不研究 USN、不提權、不安裝 Service。依序實作持久事件 queue／世代與冪等 ack、watcher scopes、可接續背景分批校正、status 及可選使用者登入啟動；保留既有 parser selection 與來源／context 安全契約。all-terms 先 benchmark 再修，禁止 false negative。每階段提交有意義的故障回歸，最後交付 README、0.37.0-VALIDATION.md、STATUS／DECISIONS／HANDOFF 與公司 Windows 待驗清單；完成前不要升版或宣稱 Windows 驗收。

| 階段 | 模組與工作 | 必須證明 |
| --- | --- | --- |
| A：既有功能基線 | `src/live-update.ts`、`src/local-update.ts`、`src/watch.ts`、`test/autoupdate.test.ts`、`test/m11.test.ts` | start 校正完成後直接新增／修改／rename／刪除再 search，不呼叫 index；記錄 root scan 次數與延遲 |
| B：持久工作 | 新增獨立 queue 模組與版本化工作 SQLite；沿用 `src/store.ts` 的索引交易邊界 | 落盤後接受、commit 後 ack、crash 重播；舊 ack 不會清新世代；queue 超限先保存 dirty scope |
| C：watcher scopes | 擴充 `live-update.ts`／`watch-path.ts`，共用 0.36.1 exclusions | root 直屬／新子目錄無覆蓋空洞；128 handles 上限；A 失效只補掃 A，無法定位則保守擴大 |
| D：分批校正 | `scanner.ts`／`sync.ts` 抽出可接續枚舉與 scope 提交，共用 local update；保存 frontier／generation | 500 entries／約 250 ms 發現批次安全讓出、批次間釋放 writer；掃描中 rename／新事件不誤刪；stop／restart 可恢復 |
| E：使用入口 | `autoupdate.ts`／`autoupdate-control.ts`／`cli.ts` 與新 startup 模組 | status 分清 watcher 健康與校正未完成；使用者 Startup enable／disable 冪等，政策拒絕仍可手動 start |
| F：搜尋與交付 | `store.ts` 與搜尋 tests／benchmark、README／驗證文件 | mixed long＋short 候選 pruning 結果等價；全套回歸與普通 Windows 使用者人工結果分開記錄 |

- 預設時間／數量與重播契約以 SPEC §46.7～§46.10 為準；大目錄不能保存 iterator offset 當可靠 cursor。工作 queue 和索引不同庫，不能宣稱跨庫原子性。
- Node fs.watch 不提供完整 old/new rename pair 保證，也未必暴露每個 OS overflow；勿新增無證據的「所有事件零漏失」承諾。scope 分割需控制 handle 數與建立／回收競態。
- 背景掃描與搜尋可共存，但沿用活動 SearchSession 的 `SEARCH_INDEX_CHANGED`，必要時提示重搜。完成部分 scope 不等於整根完整同步，失敗 scope 必須保留索引。
- 本輪借用 Paperless 的事件／穩定等待想法，不搬移原檔；ripgrep 式文字優化不是變更發現，不重做已正常 parser。公司實測仍須由使用者回報。

### 不要誤修的項目

- 不改已證明正常的未變更 parser selection：公司已確認一次性 `文字解析升級=60014` 後下一次為 0，約 299,530 份未變更會略過。
- 暫不處理 `MSG_FORMAT_ERROR`、`OFFICE_MISSING_PART`、`PDF_CORRUPT`、`PDF_PARSE_ERROR`、`RTF_INVALID`、`TEXT_DECODE_ERROR`、`XLS_FORMAT_ERROR`、`XML_DECODE_ERROR`、`FILE_READ_FAILED`，也不把固定 202 個 error retry 併入本輪。
- 不上傳公司文件、索引或含敏感路徑的 profile；不刪 SQLite journal／WAL，不以 rebuild、全域 ignore、關閉外鍵或 durability 換效能。

## 歷史紀錄：0.36.0 本機實作與原始驗收交接（2026-09-23）

權威規格仍是 [SPEC §44](SPEC.md#44-0360-索引增量效能與-tui-可用性修正)，決策 D053。本機程式、測試、`scripts/benchmark-0.36.0.mjs` 與 `docs/0.36.0-VALIDATION.md` 已完成，package 為 **0.36.0**。下列是公司回報前的原始交接，已由本文件最上方 0.36.1／0.37.0 規劃取代；不得再照此節把工作限縮為單純複驗。

原規劃是下一任只在公司電腦做普通 `index <原根目錄> --profile <新檔>`、中斷接續、完成後無變更重跑，以及 TUI `/help`、`./help`、`/quit`、Ctrl+C；這些人工結果現已收到並形成 SPEC §45／§46。資料安全要求仍有效：不要上傳公司內容、完整索引或含路徑的 verbose 日誌，不要刪 journal／WAL，不要要求 rebuild。

### 當日實作提示（已執行，保留原文）

> 請實作 LocalDocSearch 0.36.0。先讀 AGENTS.md，再依序讀 docs/SPEC.md、docs/STATUS.md、docs/DECISIONS.md、docs/HANDOFF.md；只處理 SPEC §44。程式基線是 0.35.0 的 29f4776d0f16eb2b7e03a2a86c0bf008bf1c554e，從包含本次規格的最新 main 建立工作分支。先補能重現 TUI Ctrl+C／EOF 的真實 PTY 測試、索引位置／逐文件升級接續測試，再以大型既有庫量測替換成本，依證據修正熱點。保留 TEXT_PARSE_VERSION=1、既有索引與 payload、writer lock、外鍵及資料耐久性；不能靠 rebuild／刪庫／排除文件／縮短 parser timeout 解決。依規格完成原因計數、慢階段進度、本機匿名 profile、TUI 命令補全／help／尺寸適配／可靠退出。所有行為變更補自動測試，交付前後效能數字、PTY 證據、0.36.0-VALIDATION.md、README 與更新的 STATUS／DECISIONS／HANDOFF；最後才升 package／lockfile 並打包。公司文件與索引留在公司電腦，沒有使用者回報不得宣稱 Windows 或公司慢速已修復。

### 已掌握的證據

- 使用者原話的量測只有「10 分鐘才處理到 135 份」；未取得其升級前最後完成版本、當次命令、目前格式／大小／階段／重試數。先判斷檢查進度或實際解析，不以此計算全庫 ETA。
- 0.29.1 公司歷史參考為 358,102 份一般檔、12,161 次 parser、約 2 小時 21 分；新增正文與一次性文字升級會改變工作量，不能直接當 0.36.0 的固定工時門檻。
- 0.35.0 真實 PTY（macOS／Node 22.13.1）：`./help` 進搜尋，`/help` 列清單；`/quit` 退出 0 並有 `ESC[?1049l`；Ctrl+C／EOF 退出 13、unsettled top-level await、無還原碼。沒有取得公司 Windows 同樣的程序診斷。
- 基線完整 233 項：232 通過、0 失敗、0 取消、1 Windows cmd 略過（47.23 秒）；聚焦 25 項也全綠。這些是既有測試漏測的證據，不是修正已驗證。正式目標仍是 Node 22.17.0。

### 實作定位與順序

1. `src/cli.ts` 的 TUI readline 介接、`src/tui.ts` 的 ask／finally：close 必須 settle pending question。既有互動 search 已使用 AbortController，可作參考；注意 context 確認與 prompt 建立競態、搜尋忙碌時取消。以編譯 CLI 的 PTY 重現，不只注入 `ask: async () => null`。
2. `src/model.ts`／`src/sync.ts`／`src/local-update.ts`／`src/live-update.ts`：共用重新處理原因；七種文字 parse_version 保持 1，更新與標記在同一文件交易。`src/store.ts`／CLI 顯示實際資料位置、儲存／文字兩種升級狀態；唯讀舊 schema 缺欄位也需可讀。
3. `src/store.ts` 的 `upsert()`、`writeDocumentPayloads()`、外鍵及 mapping schema：分離量測解析／壓縮／Bloom／刪除／寫入／提交。`document_payload_blocks` 有 block_id 外鍵，但現有複合索引以 document_id 起頭；查詢計畫與規模測試要證明是否造成跨庫掃描。只把這點當待驗證線索，勿直接抄成已證根因。
4. `src/progress.ts` 與同步回報：呈現檢查／略過／更新／parser／失敗計數、原因、慢階段；新增有界匿名 profile，注意 profile 自己不能被索引，以及舊摘要欄位相容。
5. TUI 使用命令登錄共用 help／解析／補全、固定輸入與狀態列、可完整翻閱 help／context，依 terminal 大小及中文顯示寬度排版；版本由單一來源取得。以 80×24、120×40、小視窗、resize、中文貼上及 Ctrl+C 實測。
6. 完成 SPEC §44.7 的大型庫、無變更、取消／故障／重跑與完整回歸。比較需相同資料／Node／硬體，profile 與預設模式分開量測。若公司慢速未在本機重現，交付匿名收證能力並清楚保留該未解項。

### Grok 交付清單

- 程式與有意義的缺陷回歸，包含 PTY 退出碼／還原序列與大型舊庫替換案例；測試環境與略過原因明列。
- `scripts/benchmark-0.36.0.mjs` 或等效入口、合成資料規模／種子、0.35.0 與修正後三次量測及匿名原始結果；未達 SPEC 門檻不可標記本機效能完成。
- `docs/0.36.0-VALIDATION.md` 記錄根因、改動、測試、效能及未解項；README 提供普通 index 升級、profile、取消接續、TUI 指令與退出說明。package／lockfile 同步至 0.36.0，核對交付包與 SHA-256。
- 公司後續只執行普通 index 與本機 profile／TUI 複驗；不要求上傳公司內容、完整索引或含路徑的 verbose 日誌，不要求刪 journal／WAL／rebuild。

## 已交付：0.35.0 本機拖曳工作台與可選 AI API（2026-09-23）

權威規格為 SPEC §43，決策為 D052。`docsearch ui [--no-open]` 啟動只綁 `127.0.0.1` 的本機工作台；每次使用亂數 fragment token、Host／Origin 驗證與嚴格 CSP。介面可搜尋既有索引、人工勾選、拖曳支援格式、移除臨時檔、預覽／複製合併 context，並選配 OpenAI／xAI Responses API。

拖曳檔沿用正式 parser，暫存原檔解析後立即刪除；文字、回答與 UI Key 不持久化。索引與拖曳合計最多 20 份、context 最高 256 KiB。外部呼叫前 preview id 以 HMAC 綁定 provider、model、問題與實際內容；改任何欄位都需重新預覽與同意。endpoint 固定，不做任意 proxy、cookie／密碼代登或消費訂閱假登入。

本機 Node.js 22.13.1 完整 233 項為 232 通過、0 失敗、1 項 Windows cmd 專屬略過；Provider 測試使用假 fetch，沒有真實 API 呼叫。交付包 258 個檔案，SHA-256 `a7be696053bcdd1473decacb061099a94d93fe9ea8b1722b624a394b96aaff53`。公司 Windows、真實 Provider、MCP Apps Host 仍未驗收。驗證見 `0.35.0-VALIDATION.md`；下一步與刻意不做項目見 `NEXT-TODO.md`。真實 PDF／PPTX／XLS 問題仍只在公司電腦依 `COMPANY-WINDOWS-DIAGNOSTICS.md` 處理。

## 已交付：0.34.0 MCP App 搜尋工作台與本機接入（2026-09-23）

權威規格為 SPEC §42，決策為 D051。`open_search_app` 透過 `ui://localdocsearch/search-context-v1.html` 與 `text/html;profile=mcp-app` 發布自足介面；UI 使用標準 `tools/call`、`ui/update-model-context`、`ui/message`，可搜尋、分頁、人工勾選最多 20 份、更新模型上下文，並只在使用者另填問題及按鍵後送出。沒有外部 URL、fetch、WebSocket、CDN 或 localhost port。

既有 `search_documents`、`prepare_context`、`index_status` 保持 headless 可用，TUI 仍是完整備援。`docsearch setup codex [--dry-run]` 先查同名設定：相同即冪等、不同拒絕覆寫；`docsearch doctor` 只讀檢查 Node 22.17.0、build、索引及 MCP App 註冊。本機 Node.js 22.13.1 完整 228 項為 227 通過、0 失敗、1 項 Windows cmd 專屬略過；交付包 246 個檔案，SHA-256 `779cf31e00ce3c1513131c3d72fa2c7326e2fd3d83e6d2a2c6a760f5e1df8c6e`。測試環境低於正式最低版本，公司 Windows 與真實 MCP Apps Host 尚未驗收。

下一步不是再造搜尋核心或自動 RAG。先在公司 Windows 依 `docs/0.34.0-VALIDATION.md` 驗證 doctor、setup、Host UI 與公司政策；真實 PDF／PPTX／XLS 修正仍只在公司電腦依 `docs/COMPANY-WINDOWS-DIAGNOSTICS.md` 處理。若 Host 不顯示 UI，不得用 headless 成功冒充按鈕已驗收。

## 已交付：0.33.0 本機 MCP 與人選上下文閉環（2026-09-23）

權威規格為 SPEC §41，決策為 D050。`docsearch mcp` 以 stdio 提供 `search_documents`、`prepare_context`、`index_status` 三個唯讀工具；沒有索引寫入、根目錄變更、open／reveal、任意讀檔或整庫匯入。`prepare_context` 只接受使用者選定的 1～20 個文件代碼，重用既有來源核對、passage 與 256 KiB 上限。

TUI 新增 `/select`、`/unselect`、`/selected`、`/clear`、`/context`；以 `[x]` 顯示選取，完整預覽後只有逐字 `yes` 才複製。MCP 與 TUI 共用 `prepareSelectedContext`，不得分叉搜尋語意。Node.js 22.13.1 本機 222 項為 221 通過、0 失敗、1 項 Windows cmd 專屬略過；低於正式 22.17.0，公司 Windows 及真實 Codex Host 尚未驗收。

0.34.0 已依使用者要求完成，見上節。不得把 ChatGPT 網頁描述成本機 stdio 已連接。

## 已交付：0.32.0 格式解析與終端互動介面（2026-09-22）

權威規格為 SPEC §40，決策為 D048／D049。`.xlsm` 共用安全 OOXML 試算表解析、`.odt` 解析本機 `content.xml`、獨立 `.rtf` 抽出 MSG 已用安全核心、`.csv` 採 RFC 4180 相容逗號解析；全部禁止執行巨集、公式、物件或外部資源。`docsearch tui` 以純 Node ANSI／readline 實作，重用 `SearchSession`，不開網路連接埠。context／autoupdate 管理仍使用既有 CLI。

本機完整 218 項為 217 通過、0 失敗、1 項 Windows cmd 專屬略過。交付包 `LocalDocSearch-0.32.0.zip` 逐檔核對 232 個檔案，SHA-256 `6e2665d0a624ff33f6dd567a4e3a76f5ecca84bdd8898f66e7ed4e52f3ca77f3`。測試 Node.js 22.13.1 低於正式最低 22.17.0，公司 Windows 尚未驗收。

需要真實公司檔案的 PDF／PPTX／XLS 診斷入口是 `docs/COMPANY-WINDOWS-DIAGNOSTICS.md`。只能由公司 Windows 電腦上的 Codex 讀取指定檔案；不得把公司文件或內容推上 Git。操作介面後續方向見 `docs/UI-DIRECTION.md`；只有實際需要滑鼠／預覽時才規格化 localhost Web UI。

## 已交付：0.31.0 背景自動更新（2026-09-22）

依 SPEC §39／D047 實作。局部更新服務處理精確檔案新增／修改／刪除與子樹校正；前景 `watch` 與 `autoupdate start|status|stop` 共用 `LiveUpdateEngine`。不得把每個事件全根 `sync()` 當成完成。detached 啟動後必須控制通道握手；status 詢問活體實例；stop 不 PID 殺 Node。待機不持 writer lock。完整校正預設 6 小時且背景不得為 0。編碼政策維持 0.30.0。

本機測試見 `docs/0.31.0-VALIDATION.md`。公司 Windows 人工驗收尚未回報，步驟已併入公司診斷清單；不把本機測試寫成 Windows 通過。

建議 commit：`Implement 0.31.0 background autoupdate with local file updates.`

以下保留歷史交接；驗收現況以本節及 STATUS 為準。

## 歷史規劃：交接給 Grok 實作 0.31.0（2026-09-22）

0.31.0 的權威規格是 SPEC §39，設計理由見 D047，目前僅完成文件、尚未實作。本版起不再新增 M 編號；package、tag、驗證文件與交付包統一使用 0.31.0。

給 Grok 的實作提示：

> 請實作 LocalDocSearch 0.31.0。先讀 AGENTS.md，docs/SPEC.md，docs/STATUS.md，docs/DECISIONS.md 與 docs/HANDOFF.md；只實作 SPEC §39，不開新 M 編號。先把精確檔案／子樹局部更新抽成共用服務，再讓前景 watch 與 `autoupdate start|status|stop` 共用它；不得以每個事件全根 sync 冒充完成。實作可驗證的本機單例控制、啟動握手、健康 status、安全 stop、事件佇列、6 小時完整校正、動態 roots、降級復原與有界日誌。不安裝 Windows Service，不做開機／登入自啟，不更改 0.30.0 嚴格 UTF-8 失敗才 Big5 的編碼政策，不要加統計偵測或目錄編碼設定。每個行為變更補自動測試，最後更新 STATUS／DECISIONS／HANDOFF 與 0.31.0 驗證文件；不得把本機測試寫成公司 Windows 已驗收。

實作順序與收斂條件：

1. 局部更新 API 與安全刪除／離線保留，共用既有 parser、ignore、歸屬、transaction、payload／Bloom 與 writer lock。
2. 持續更新管理器：單一寫入佇列、防抖去重、溢位改完整校正、動態 roots、watcher 降級與復原。
3. 本機控制與 CLI：detached spawn 後必須握手才回報成功；status 必須詢問活體實例；stop 不以 PID 批次殺 Node。
4. 執行 SPEC §39.7 的事件、多程序、特殊路徑、故障復原、效能與舊版回歸測試。只有程序、測試、版本與交付物一致時才可標記 0.31.0 本機實作完成。

## 已交付：M27／0.30.0 原始碼、Big5 與索引觀測（2026-09-22）

依 SPEC §38／D046 實作。共用嚴格文字解碼套用 java／sql／js／txt／md／adoc／xml；BOM 與 XML 宣告失敗不回退；無訊號時嚴格 UTF-8 成功即停，失敗才 Big5。`.class` 僅檔名。逐文件 `parse_version` 讓舊 indexed／no_text 文字與舊 unsupported 原始碼一次普通 index 升級，中斷後接續；too_large 未變更不讀取；error 仍每次重試。修正未變更 `continue` 未增加 processed 的進度停滯，TTY／非 TTY 節流，結尾按階段／錯誤碼彙總。`status` 預設容量與問題彙總，`--issues`／`--types` 可併用。

Linux 沙盒 197 項：194 通過、1 失敗（既有 M7 平台）、2 略過。效能見 `docs/benchmark-m27.json` 與 `docs/M27-VALIDATION.md`。交付包 `LocalDocSearch-M27-0.30.0.zip`，SHA-256 `4390a048913f76dec7a3b0ebc8bb199e85b8e6b595961af863c7b5bd48df822e`。公司 Windows 請對現有索引執行普通 `index`（不必 rebuild、不可清空），再核對中文命中、行號、XML 錯誤碼、無變更重跑、搜尋延遲與新容量。

### 已轉為 0.31.0 規格

先前保留的自動更新管理已完成規格化，不再是尚未規劃的待辦；實作狀態以本文件首節及 STATUS 為準。

以下保留歷史交接；驗收現況以本節及 STATUS 為準。

## 已交付：0.29.1 Windows 磁碟根目錄輸入（2026-09-22）

使用者回報 `D:\` 與全形 `＼` 都被當成路徑不完整。原因是 Windows 引號 `"D:\"` 吃掉尾端反斜線，且全形分隔符未正規化。0.29.1 將 `D:`／`D:/`／全形 `＼／` 在輸入層視為 `D:\`；涵蓋判斷仍用路徑元件。公司驗收請寫 `index D:/`。

## 已交付：0.29.0 M26 根目錄範圍合併（2026-09-22）

依 SPEC §37／D045 實作父根範圍合併。`index` 上層路徑會把涵蓋的既有子根做短交易歸屬轉移，保留文件 ID／payload／排除作用域，不得呼叫刪文件的 removeRoot。已登錄上層時 index 子樹只同步該範圍且不更新上層最後完整同步時間。`--root` 接受已合併原子根與子樹篩選；roots remove／rebuild／watch 對已合併子根顯示所屬上層。程式版本 0.29.0。使用者已回報 0.28.0 驗測成功；0.29.0 公司 Windows 請以既有 `D:\備份` 擴大至 `D:\` 驗收。

## 已交付：0.28.0 M25 結果內搜尋（2026-09-22）

依 SPEC §36／D044 實作互動結果內搜尋。`search` 工作階段以 `/ 關鍵字` 對目前完整命中集合追加文件級 AND，核對檔名、標題與全部已索引正文（含未顯示頁與片段外內容）；back／reset 可逆，單頁與零結果仍可操作。縮小後保留最初相對排序，片段展示最新一層條件。非互動／`--page`／`--limit` 行為不變。索引變更回報 `SEARCH_INDEX_CHANGED`。使用者已回報 0.28.0 驗測成功。

## 前一規劃：M26 根目錄範圍合併（2026-09-22）

規劃內容已實作，見上節。以下為規劃當日紀錄：以短交易把既有子根歸屬轉到上層，保留文件 ID／payload／排除作用域，再增量掃描；已登錄上層時 index 子樹不另建根，刪除校正限子樹。

## 前一規劃：M25 結果內搜尋（2026-09-22）

0.28.0 已實作，見上節。以下為規劃當日紀錄：使用者已回報 0.27.0 公司 Windows 人工驗收成功，並確認將結果內搜尋加入規劃。SPEC §36／D044 定義 `/ 關鍵字` 追加文件級 AND、back／reset、完整條件鏈及總數。

## 已交付：0.27.0（2026-09-22）

M24 依 SPEC §35／D043 實作搜尋分頁與 XML 原文索引。搜尋先固定完整命中排序及總數，互動 TTY 以 n／p／q 翻頁，非互動使用 --page／--page-size；舊 --limit 為互斥的單次輸出。每頁才回讀片段，索引在翻頁期間變更會停止。XML 逐行保留標籤、屬性和值，支援 BOM／UTF-16 起始位元組／declaration 編碼，不解析 entity；舊 unsupported XML 普通 index 即重試。本機完整測試結果與交付包資訊以 STATUS 最新段落為準；公司 Windows 人工驗收已由使用者回報成功。

## 前一版交接：0.26.3（2026-09-22）

公司索引與 status 已成功，但真實搜尋兩次證實 too many SQL variables；40,000 區塊合成案例在舊程式重現，固定參數 json_each 修正後通過。另測 33,001 payload，無需 rebuild。npm test 改逐檔、watch 延後載入 sync。Mac Node 26.7.0 全套 149 通過、0 失敗、0 取消、1 Windows CMD 略過。0.26.2 timeout 根因說法已撤回，不能再沿用。公司 10 份 PPTX 缺部件錯誤仍待診斷；0.26.3 實際搜尋及完整 Windows 測試尚待回報。

## 最新交接：M23 修正版規格（2026-09-21）

0.26.1 公司 Windows 全套結果為 142 通過、4 失敗、2 略過：三項 SQLite CLI 案例耗盡五秒，cmd launcher 在含空白與括號的下載路徑失敗。0.26.2 已把 Node.js 22.17.0 支援的 `DatabaseSync timeout: 0` 提前至主索引與 writer 協調資料庫開庫階段，保留後續 PRAGMA；M9 改以暫存 wrapper 測真正的 launcher；`npm ci` 透過 prepare 自動產生 `dist`。Mac 聚焦回歸通過，完整套件只有既有 M11 native watcher 取消及 Windows cmd 略過；交付包雜湊見同名 `.sha256`。必須等公司 Windows 重跑才能宣稱修正通過；不得刪除原索引或 journal。

聊天紀錄不是專案的唯一依據；專案儲存庫內的文件與 Git 紀錄才是。

## 開始新對話

使用以下提示：

> 請接手 LocalDocSearch。先讀取根目錄 AGENTS.md，再依序讀 docs/SPEC.md、docs/STATUS.md、docs/DECISIONS.md、docs/HANDOFF.md；檢查 Git 狀態與測試結果後，只處理 STATUS 中的 active milestone。不要重新探索 RAG 或教材網站。

## 每次工作結束

1. 執行相關自動測試。
2. 在 `docs/STATUS.md` 記錄已完成、未完成、阻礙、測試結果與明確下一步。
3. 將產品或架構決策加入 `docs/DECISIONS.md`。
4. 每個 commit 僅處理一個明確範圍，並參考 `docs/STATUS.md` 的建議訊息。
5. 列出仍需使用者在 Windows 公司電腦完成的驗收項目。

## 資訊衝突時的優先順序

文件內容發生衝突時，依下列順序判斷：

1. 使用者最新且明確的決定。
2. `docs/SPEC.md` 已確認的產品行為。
3. `docs/DECISIONS.md` 已記錄的決策。
4. `docs/STATUS.md` 的實作狀態。
5. 現有程式碼與測試。

應修正發生衝突的文件，不可只依賴聊天記憶。

## M5 驗收交接

M4 已由使用者於 2026-09-16 回報驗收完成。M5 本機實作與驗證見 `docs/M5-VALIDATION.md`；下一步依 `docs/M5-WINDOWS-ACCEPTANCE.md` 收集公司 Windows 結果。未收到回報前不得將 M5 標示為全部完成。


## M6-A 交接

使用者收到盤點分析後明確要求規劃並執行，當時 active milestone 轉為 M6-A；不必再詢問是否允許舊版 DOC／XLS。0.6.0 新增格式與後續 MSG／VSD 計畫見 SPEC 第 16 節。42 項本機測試通過，Windows 步驟見 `docs/M6A-VALIDATION.md`。不要把 M5 歷史基準當作本版新格式效能，也不要宣稱 M5 或 M6-A 已完成公司 Windows 驗收。原有工作目錄有未提交檔案，勿重置。


## M6-B 交接

使用者已於 2026-09-16 要求接續下一版，當時進入 M6-B（0.7.0）。MSG 規格見 SPEC 16.4；53 項測試已於 macOS 的 Node.js 26.7.0 及 22.17.0 通過，驗收文件為 `docs/M6B-VALIDATION.md`。新格式重新 index 即可納入，不要求清除索引。S/MIME 以 MSG_SMIME_UNSUPPORTED 保留檔名，不冒稱成功擷取或單憑類別判定加密。附件／PST／OST 未納入，當時 VSD 尚未實作；最新狀態見下節。保留 M5／M6-A 尚待回報的 Windows 驗收紀錄。

## M6-C 交接

目前為 M6-C 0.9.0：已實作 VSD v11 的直接 UTF-16 圖形文字，含指標表、LZSS 壓縮及頁面／圖形 ID。SPEC 16.6 取代 16.5 的檔名限定，D018 記錄 MPL-2.0 來源與範圍。unsupported VSD 每次 index 都重試，因此 0.8.0 索引可直接升級；indexed／no_text 未變更則略過。

63 項本機測試在 macOS Node.js 26.7.0／22.17.0 通過；公司 Windows 驗收仍待回報，見 M6C-VALIDATION.md。尚未支援 v1～6、master 繼承、動態欄位、頁名、超連結與 OCR；不要把直接文字擷取描述為全部可見文字。後續優先依公司實際檔案的版本與失敗代碼修正。發佈包必須保留 vsd-binary.ts 原始碼、vendor/libvisio-MPL-2.0.txt 與 vendor/README.md 來源說明。

使用者於本回合補充完整產品方向，見 ROADMAP.md。VSD 本批完成後不無限追格式；下一階段先規格化搜尋結果開啟／顯示資料夾，接著多根目錄。目標仍需 Windows 日常驗收，不因本批通過而標記整體完成。

## M7 交接

目前為 M7 0.10.0，本機已完成搜尋結果固定文件代碼、open／reveal、dry-run 與來源核對。SPEC 17、D020 與 M7-VALIDATION.md 定義行為及 Windows 驗收。71 項測試在 macOS Node.js 26.7.0／22.17.0 通過；不代表公司 Windows 的 PowerShell／Explorer／預設程式已驗證。下一階段規格化 M8 多根目錄，保持人選上下文與 AI 為後續選配。

## M8 交接

最新為 0.11.0；使用者已明確要求不要逐版停下請他確認，持續開發並保留集中驗收。SPEC 18、D021 定義多根目錄；index 新路徑保留其他根，index 不帶路徑更新全部，rebuild [root] 與 roots remove 只處理明確歸屬，search --root 可篩選。父子重疊拒絕，別名沿用既有位置。資料庫升級保留原 ID 與文字，不應再用舊版程式操作此索引。

78 項測試在 macOS Node.js 26.7.0／22.17.0 通過，Windows 實際開啟、權限與格式驗收仍保留。整合清單在 INTEGRATED-ACCEPTANCE.md。不要把等待公司驗收當成持續開發的阻礙；下一步規格化降低 CLI 摩擦／可選人選上下文，不能預設整庫或公司內容外傳。


## M9 交接（0.12.0，2026-09-17 Grok Bot 收尾）

### 給下一任 GPT 的冷啟動

> 請接手 LocalDocSearch。路徑：`/Users/hermes/Documents/Codex/2026-09-01/ai-localdocsearch-rag-rag-mcp-windows/work/localdocsearch`（使用者 Mac，machineId 若可用請指定）。先讀 AGENTS.md，再 SPEC／STATUS／DECISIONS／HANDOFF／ROADMAP。**目前 active：M9 本機已完成 0.12.0**；無新 milestone 時不要開新功能。公司 Windows 用 INTEGRATED-ACCEPTANCE.md 集中驗收。不要探索上層教材網站；不要 OCR／GUI／自動 RAG。工作目錄有大量未提交檔，勿 reset。

### 本版做了什麼

- `src/context.ts` + CLI `context`：關鍵字搜尋 → 分頁勾選 → 預覽 → `yes` → 新檔 JSON（片段非全文）。
- `docsearch.cmd`；SPEC §19；D022；`docs/M9-VALIDATION.md`；package 版本 0.12.0。
- 測試：`test/m9.test.ts`；整包 `npm test` 在 Node 26.7.0：**88 pass / 1 skip**。

### 刻意不做

- 不接模型、不改寫查詢、不自動同意、不覆寫輸出、不外傳。
- 不宣稱 Windows／cmd 互動已驗收。

### 已知缺口

- 集中 Windows 驗收未做（僅 M4 曾回報）。
- Git 無 remote、歷史停在早期 commit；打包 zip 請確認 `npm run package` 是否已產 `LocalDocSearch-M9-0.12.0.zip`。
- 背景 executor 若無 machineId 路由，會跑在錯誤機器上——父代理須自行用 machineId 操作使用者 Mac。

### 使用者產品方向（摘要）

自己用得順；無管理員；內文搜尋；可選人選上下文（模式 A 搜完拉入／模式 B 按鈕搜完再選——本版 CLI 先落地「搜＋選＋匯出」）；在職碩作品集加值；不追星數。

## M10 交接（0.13.0）

使用者要求持續**開發**，不要用驗收流程打發。M10 完成：`matchingPassages`、`context --format md|json --passages`、schemaVersion 2。測試 `test/m10.test.ts`。下一任先讀 STATUS；無新 milestone 時先問使用者下一功能，或依 ROADMAP 討論後再寫 SPEC。

## M11 交接（0.14.0）

使用者選擇監看自動增量 index。本機完成：`src/watch.ts`、`docsearch watch`、D024、SPEC §21、`test/m11.test.ts`、zip `LocalDocSearch-M11-0.14.0.zip`。下一任先讀 STATUS；無新 milestone 時先問使用者下一功能。持續開發優先於驗收儀式；勿 reset 大量未提交工作樹。

## M11 可靠性修正交接（0.14.1）

目前狀態以 STATUS 為準，取代上方「無新里程碑先問」的舊指示；使用者已授權持續開發。修正 watch 初次同步空窗、停止與 SQLite 寫入競態、失效監看器及 CLI 訊號清理；D025／SPEC 21。Node.js 22.17.0 本機 101 通過、1 Windows cmd 略過。下一批先規格化事件遺漏校正／離線恢復，不自行擴充 AI／格式。Windows 仍待集中驗收。

## M12 交接（0.15.0）

SPEC 22／D026 定義定期增量校正與監看恢復。預設 --rescan 300000，0 保留 M11 全部失效退出行為；啟用時失效改為定期掃描並重試。定期 timer 於同步完成後重排，事件仍可防抖觸發；停止等待進行中任務。M11 舊模式測試明確設 rescanMs: 0。M12 測試涵蓋失效／離線／修改刪除／排程合併。

Node.js 22.17.0 全套 109 通過、1 Windows cmd 略過；全新解壓 npm ci 與測試相同通過。Windows 仍待集中驗收。下一批先規格化跨程序寫入協調，避免 watch 與另一終端 index／roots remove 交錯；不要拿單根不並行的測試宣稱跨程序已安全。

## M13 交接（0.16.0）

SPEC 23／D027／M13-VALIDATION 定義跨程序寫入協調。src/write-lock.ts 對主索引 realpath 旁的 .writer.sqlite 持有 BEGIN IMMEDIATE；檔案保留，釋放／程序結束解除交易。sync 封裝整次操作，removeRoot 同樣持鎖。根目錄失敗報告移至 sync 的鎖內；CLI／watch 不在忙碌時覆寫報告。watch 防抖重試，requireRegistered 在鎖內防止移除後復活。

Node.js 22.17.0 macOS 全套 116 通過、1 Windows cmd 略過；乾淨安裝／測試相同通過，打包 138 檔。不要把子程序被終止的 macOS 測試當作 Windows 已驗收。下一步依產品目標查驗使用證據／缺陷，不為持續開發而無限新增功能；公司 Windows 集中驗收尚缺，不得標記整體目標完成。

### M13 後續盤點

GOAL-AUDIT.md 列目標與證據缺口；M13-PERFORMANCE.md 及 benchmark-m13-node22.json 是 0.16.0 新量測，六格式 1000 小文件搜尋 p95 216.63 ms、結果及增量斷言均通過。這批僅補驗證文件與報告，未變更程式或覆寫交付包。整體目標尚缺新版公司 Windows 日常回報，不能以本機功能清單宣布完成。

### 外部驗證等待狀態

本機主線與交付已完成，現等待 0.16.0 在公司 Windows 的集中驗收或可重現錯誤，目標未標記完成。不要重跑既有綠燈測試或新增無需求功能來替代外部證據；使用者回報後，依 STATUS 與 GOAL-AUDIT 恢復處理。

## M14 交接（0.17.0，本機完成）

使用者最新決定取代上方等待狀態：先不做公司 Windows 驗收，以目前 macOS 電腦持續逐版做到完整目標。M14 已完成跨查詢 context：ContextSessionSelection 以文件代碼去重，保留首次選取的查詢；`s` 換查詢、`b` 列清單、`r` 移除。bundle 依每份文件的查詢重搜，JSON schema 3 與 Markdown 標記 query。真實 Mac TTY 已跑完規格＋BU 聊天匯出；Node 22.17.0 全套 122 通過、1 Windows cmd 略過，乾淨安裝相同。Windows 未驗證仍需如實標示，但不得再停止開發等待使用者逐版確認。

### M14 Windows 相容修正（0.17.1）

2026-09-18 使用者在公司 Windows 回報 0.17.0 兩項失敗：M13 寫入鎖競爭測試逾時，M9 cmd launcher 的完整路徑遭 cmd 引號解析失敗並出現 code page 亂碼。0.17.1 依 D029 拆開 SQLite 零等待設定與 BEGIN IMMEDIATE，加入耗時／子程序期限；cmd 測試改以環境變數加 `call`。Mac Node 22.17.0／26.7.0 全套仍為 122 通過、1 Windows 專屬略過。Windows 0.17.1 尚待重跑，必須記錄為待複驗，不能把本次 0.17.0 執行寫成通過。

使用者其後於 2026-09-18 回報 0.17.1 驗證通過。M15 依 SPEC §25／D030 開始實作 `context --clipboard`；保持人選、完整預覽、yes 與純本機邊界，不自動連接任何討論服務。

下一版可沿最終目標降低上下文帶入討論的摩擦，例如在本機明確確認後交付到可控的本地目的地；不能自動上傳、整庫灌入或假定任何聊天平台已獲授權。

## M15／M16 交接（0.18.0／0.19.0）

M15 已完成 `context --clipboard`，以 stdin 傳給 macOS pbcopy 或 Windows 固定 PowerShell Set-Clipboard；仍需完整預覽與 yes。使用者明確表示無空測試並要求繼續，因此 M16 新增 `search`／`context --all-terms`。全部詞可跨同一文件的欄位／區塊，預設片語搜尋不變。context schemaVersion 4 新增 matchMode。測試在目前 Mac 不碰真實剪貼簿；Windows M15／M16 功能未實機驗證，不阻擋後續主線。

## M17 交接（0.20.0，本機完成）

使用者要求先修正檔案清冊缺口，再繼續索引瘦身實驗。SPEC §27／D032 已完成：掃描所有未排除的一般檔案；解析器未支援的副檔名與無副檔名檔案只保存 metadata，狀態 unsupported、不讀正文，仍可依檔名／類型搜尋並 open／reveal。排除與連結政策不變。135 項測試為 134 通過、0 失敗、1 Windows 專屬略過；`測試用資料` 實測登錄 471 份，其中 320 份 metadata-only，首次 5.11 秒，無變更增量 21.6 ms／0 次解析。下一步回到索引瘦身方案比較；不要把 metadata-only 說成已搜尋內容，也不要用這批 5.4 GB 原始檔大小直接推估文字索引比例。

### M17 後端方案比較

`STORAGE-BACKEND-COMPARISON-2026-09-19.md`／`storage-backend-comparison.json` 已用同一資料比較五條路徑。12 組完整結果相同。現況 17.70 MiB；64 KiB Brotli 4.46 MiB；Brotli＋Bloom 6.02 MiB；Brotli＋FTS5 12.16 MiB。現有資料表只改逐列搜尋，原型 RSS 由 477.6 MiB 降至 104.7 MiB。D033 建議 M18 先正式串流化、M19 再做版本化 Brotli 分塊，Bloom 最後評估；FTS 暫不採。原型沒有片段／排序與遷移生命週期，不能直接併入產品或把數字外推 300 GB。

## M18 交接（0.21.0，本機完成）

SPEC §28／D034 已將 `search` 改為 `streamCandidates()`，逐份文件讀 SQLite blocks；命中排序後才回讀前 N 筆的片段來源。`matchingPassages()` 改用 `candidateByPath()`，不再為指定文件載入全部 blocks。136 項測試為 135 通過、0 失敗、1 Windows 專屬略過；12 組真實資料完整命中集合不變。連續正式搜尋 RSS 仍約 433.5 MiB，主因已定位為 `makeSnippet()` 對超大命中區塊建立完整 Unicode 範圍陣列。下一版先修這個片段熱點；尚未開始 Brotli schema 遷移。

## M19 交接（0.22.0，本機完成）

SPEC §29／D035 已完成片段記憶體修正：大文字以 code point 區段核對完整正規化，常見文字逐點定位，組合字／語境大小寫才在小區段使用 grapheme 對照；前後文採有限收集，避免 `Array.from()` 或整段 `Intl.Segmenter` 展開。138 項測試為 137 通過、0 失敗、1 Windows 專屬略過；真實 12 查詢完整命中集合不變，RSS 405.8 MiB（M18 為 433.5 MiB）。交付包 `LocalDocSearch-M19-0.22.0.zip` 的 SHA-256 為 `e6523104bd193ef65104be33ff67304dd7f7a72ea8a51e101e3e09a4d29defa5`。下降有限，因搜尋仍逐一正規化全文；下一版開始版本化 Brotli 分塊遷移，不得把 M19 當成最終 RAM 解法。

## M20 交接（0.23.0，本機完成）

SPEC §30／D036 將正文改存每文件、約 64 KiB 的 Brotli JSON payload；block 保留標題、位置與 payload 內的內容 ID。舊庫在單一 transaction 寫入新 payload 後才清除正文。最初每 block 一 blob 在真實資料膨脹至 19.31 MiB，已改為 285 個批次 payload，最終為 11.69 MiB，較 M17 17.70 MiB 小 34.0%。140 項測試為 139 通過、0 失敗、1 Windows 專屬略過；實測命中與片段正確。下一步讓搜尋對 payload 逐段解壓核對，避免每次先重組全部 block，並重新量 RSS；不可宣稱 M20 已解決搜尋 RAM。

## M21 交接（0.24.0，本機完成）

SPEC §31／D037 讓 `streamCandidates()` 從 Brotli document payload 逐 block yield；跨 payload 的同一 block 暫存到完成，不串接不同 block。`blockSource()` 也改只走到目標 block。payload 依 ordinal 寫入，避免代表片段排序回歸。141 項測試為 140 通過、0 失敗、1 Windows 專屬略過；真實 12 查詢結果不變，連續搜尋峰值約 385 MiB。仍需解壓／正規化全部 payload；下一版應先做保守候選索引，不得犧牲一、二字中文或精確命中。

## M22 交接（0.25.0，本機完成）

SPEC §32／D038 建立 1 KiB 文件級 trigram Bloom，僅排除不可能長查詢文件；Bloom 命中仍全文核對，短詞與缺摘要安全回退。142 項測試為 141 通過、0 失敗、1 Windows 專屬略過；真實 12 查詢結果一致，RSS 約 380 MiB。候選粒度仍是文件，常見詞效益有限；下一版評估 payload 級摘要，但必須處理同 block 跨 payload 邊界以避免漏搜。

## M23 交接（0.26.0，本機完成）

SPEC §33／D039 在文件級 Bloom 後加入 payload／block mapping 與 1 KiB payload 級 Bloom。三字以上詞以任一可能 trigram 選出 payload，再讀完整所屬 block 作原有精確核對；不把跨 block 文字串接。payload 邊界、短詞、舊或不完整摘要一律回退，避免漏搜。片段回讀只解壓目標 block。M20～M23 共 6 項相關測試通過。全套測試在此受限 sandbox 出現 M11 native watcher 15 秒逾時；M15 CLI 的 4/3 不符已定位為預設索引位置唯讀，需在可寫入的標準環境重跑。Windows 0.26.0 尚未實機驗證。
