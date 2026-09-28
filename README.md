# Seekah

原名 LocalDocSearch／quiet-index，現在正式更名 **Seekah**。新增 `seekah`／`seekah.cmd`；既有 `docsearch`／`docsearch.cmd` 完全保留，以下舊命令可直接換成新入口。索引仍使用原 LocalDocSearch 資料目錄，不搬移、不清空，不必 rebuild。

```powershell
.\seekah.cmd tui
.\seekah.cmd search "安裝手冊"
```


新手請先讀 [使用手冊](docs/USER-GUIDE.md)；AI 接手固定入口：[docs/handoff/CURRENT.md](docs/handoff/CURRENT.md)；完整 [SPEC](docs/SPEC.md)、[狀態](docs/STATUS.md)。GitHub 倉庫為 [ododuuu/seekah](https://github.com/ododuuu/seekah)；新的封裝名稱為 Seekah-VERSION.zip，包含新舊入口。

目前版本為 **0.39.2**。0.39.2 讓背景自動更新整批確認檔案穩定（每批只等一次），數千個檔案同時湧入時新檔約數十秒可搜尋（原本可能要一小時）。0.39.1 讓背景自動更新不監看、不處理 `.localdocsearchignore` 排除的資料夾（例如 `AppData`），持續變動時最長約 15 秒一定處理一次。0.39.0 把文字改存為壓縮區段、搜尋索引改為區段級且不記位置，查詢依排序驗證、找滿當頁即停止：索引約為文字量的 0.5–1 倍（0.38 約 6 倍），常見詞的第一頁也在數十毫秒內。總筆數預設「快速」（超過 500 份顯示「500 筆以上」），可在設定改為精確。舊索引不必 rebuild，第一次以寫入程序（工作台搜尋或 `index`）開啟時會自動、可中斷地升級並壓縮；另有 `compact` 命令回收刪除後的空白頁。0.38.1 起大量刪除分批提交並顯示進度。Windows 雙擊 `seekah-ui.cmd`，macOS 執行一次 `chmod +x seekah-ui.command` 後雙擊 `seekah-ui.command`，即可開啟 desktop-only 工作台；最小桌面寬度為 1180 CSS px。第一次會自動建立相依，不必先開終端執行 `npm ci`。工作台不再於每次開啟時自動完整掃描；「完整校正」會列舉已登錄根目錄、比較 metadata，並只重新解析新增或變更的文件，可隨時按「停止同步」。日常變更可在「設定」明確開啟／關閉背景自動更新。文件搜尋提供可見的搜尋按鈕、檔名與內容欄位、根目錄／格式／解析狀態篩選，以及相關性、檔名、最近修改三種明確排序。相關性固定為檔名完全符合、檔名包含、標題、內容；同級較新者優先。不支援或解析失敗的拖曳文件仍保留於本次工作階段、可用檔名搜尋與移除，但不能加入正文上下文。已索引根目錄可移入垃圾桶；只移除索引、不刪來源。工作台仍只綁 127.0.0.1，不開放 LAN；TUI、parser selection 與 LocalDocSearch 資料目錄不變。

若索引很慢，用 `index <根目錄> --profile <新檔案>` 寫一份只留在本機的診斷。檔案必須是新的，拒絕覆寫，不含路徑、檔名或正文；父目錄不存在或無法存取時，錯誤會顯示 resolved parent、錯誤碼與 CMD／PowerShell 各自的安全範例，但不自動建目錄或展開字面環境變數。取消不會顯示 100% 或「同步完整」，已提交的文件保留。
- 工作台索引的列舉／解析／SQLite 寫入在獨立 worker 執行；狀態頁會持續輪詢並顯示目前檔名，重新整理不會清掉進度。索引資料目錄的 `indexing.json` 只保存狀態與路徑 metadata；程序中斷後重開會標示已中斷，已提交文件保留，重新「完整校正」會接續未提交部分。
搜尋追查可在工作台頂列按「Trace」開啟獨立診斷頁；search／answer 會追加至索引資料目錄的 `trace.log`（JSONL，單檔 2 MiB、保留 5 個輪替檔）。search trace schema version 3 會同時顯示 `phasesMs`（inclusive）與 `phaseSelfMs`（self），並區分 postings 僅文件 ID、payload ordinal block expansion、full-document／filename-only fallback；CLI 也可用 `search --verbose` 同時查看 stderr 的 `SEARCH_TRACE <JSON>`。

`seekah tui` 現在是核准的低噪音全螢幕介面：首頁、三行結果、內部預覽、已選清單、context 確認、命令與真實索引狀態共用固定底部搜尋列。搜尋後以 ↑／↓ 移動結果、Space 選取、Enter 預覽、PgUp／PgDn 翻頁、Esc／← 返回、Tab／Shift+Tab 切換焦點；游標 `›` 與 checkbox 分離。q 只在非文字焦點退出，輸入欄中的 q 是查詢文字。slash command 保留為 fallback；context 預覽仍只有逐字輸入 `yes` 才複製。EOF／q／`/quit` 退出 0，Ctrl+C 退出 130，並還原終端畫面。

0.36.1 不縮短約 30 萬檔的完整 filesystem reconciliation，也不修改 parser selection 或 error retry policy；0.37.0 已完成日常變更發現、持久 queue、有界 watcher scopes、可接續分批校正、普通使用者登入啟動與 mixed all-terms pruning。公司 Windows 的人工驗收尚未回報。

## 0.36.1 怎麼用

PowerShell：

```powershell
node dist/src/cli.js index "D:/" --profile "$env:USERPROFILE\Desktop\lds-profile.json"
node dist/src/cli.js status
node dist/src/cli.js tui
```

CMD：

```bat
node dist\src\cli.js index "D:\" --profile "%USERPROFILE%\Desktop\lds-profile.json"
```
- 進度稱為「檢查進度」。分母包含未變更與只更新 metadata 的檔案。某份超過 5 秒會提示慢檔與階段，預設不印完整路徑；`--verbose` 才印路徑，仍不印正文。

0.36.2 延續 `docsearch ui` 的本機安全契約；目前 desktop workbench 已以 Paperless-inspired 資訊層級 clean cutover 為正式入口：topbar／sidebar／中央文件 list-table／獨立 detail／臨時文件／根目錄／垃圾桶／設定／preview 與 overlay context drawer。服務仍使用每次啟動的亂數 fragment token、Host／Origin 驗證、nonce CSP 與 20 份／256 KiB 上限。公司 Windows 與 Linux 外部開檔尚未驗收。

LocalDocSearch 0.26.2 是純本機 CLI，目前以 macOS 作為主要可執行與迭代環境，並保留 Windows 相容方向。它支援原有六種格式，並新增 `.doc`、`.xls`、`.mht`／`.mhtml`、`.html`／`.htm`／`.xhtml`、`.adoc`、`.msg` 與 `.vsd`，搜尋檔名、標題及內容。其他格式與無副檔名檔案會進入本機清冊，可依檔名及副檔名找到。文件留在原位置，索引與搜尋不需要網路或外部 AI。

0.26.2 延續 0.26.1 的可接續升級，並針對 Windows 在 SQLite 開庫時就明確設定零等待鎖；`npm ci` 也會自動編譯 `dist`，不必先跑完整測試才能使用 CLI。

目前實作的 FTS5 unigram／trigram postings 只作候選排除，既有全文精確核對、檔名／片段／穩定 reference 與 64 KiB payload 邊界保留。舊索引由明確 writer `index` 背景逐文件遷移；CLI search/status 與 MCP 保持唯讀，工作台首次遇到待升級索引回 202 並在背景完成後自動重送。規格與 benchmark 見 [SPEC §48](docs/SPEC.md#48-fts5-unigramtrigram-postings-搜尋後端)、[D076](docs/DECISIONS.md#d076以-fts5-unigramtrigram-postings-取代全文件候選掃描) 與 [benchmark-ngram.json](docs/benchmark-ngram.json)。

M4 已由使用者於 2026-09-16 回報驗收完成。M5 新增格式篩選、命中原因、原文片段與同步診斷；本機測試與效能證據見 [M5 驗證報告](docs/M5-VALIDATION.md)，M5 公司 Windows 驗收仍待回報。

M6-C 0.9.0 新增 VSD v11 直接儲存的圖形文字搜尋，支援中文與頁面／圖形 ID 定位。再次 index 原根目錄後，使用 `search "圖形文字關鍵字" --type vsd`；0.8.0 的檔名索引會自動重試。舊版本仍保留檔名，尚不展開 master 繼承、動態欄位或 OCR。驗收見 [M6-C 驗證文件](docs/M6C-VALIDATION.md)。

M9 起提供可選 `context`；M10 可匯出多段 JSON／Markdown；M14 可在同一工作階段跨查詢累積規格、文件與 BU 聊天。M11 起可用 `watch` 自動增量索引。預設不接模型。Windows 另附 `docsearch.cmd`。

## 安裝與執行

M6-B 新增 Outlook `.msg` 郵件的主旨、寄件者、收件者／副本／密件副本，以及 HTML、純文字、RTF 正文搜尋。[M6-B 驗證與驗收](docs/M6B-VALIDATION.md) 列出本機證據與公司測試步驟。

目前 Mac 安裝 Node.js 22.17.0 以上版本後，將 M17 壓縮檔解壓並切換到 `LocalDocSearch` 資料夾：

```bash
node --version
npm ci
npm test
node dist/src/cli.js index "$HOME/Documents/測試文件"
node dist/src/cli.js search "關鍵字"
```

Windows 相容操作保留如下，但不再作為逐版開發門檻：

```powershell
node --version
node -p "process.platform + ' ' + process.arch"
npm.cmd ci
npm.cmd test
node dist/src/cli.js --help
node dist/src/cli.js index "C:\Users\你的帳號\Documents\測試文件"
node dist/src/cli.js search "關鍵字"
```

發佈包附帶編譯產物、原始碼、測試與鎖定依賴，不含 Node.js 或 `node_modules`；`npm.cmd ci` 需可取得鎖定套件或本機 npm 快取。安裝可能下載 PDF.js 的平台相依選配套件，沿用 M4 的依賴，不使用 macOS 的 `node_modules` 直接複製至 Windows。安裝完成後，索引與搜尋完全在本機執行，不需要管理員權限、全域安裝或背景服務。

PDF 的 CMap 與標準字型位於 `node_modules/pdfjs-dist/cmaps`、`node_modules/pdfjs-dist/standard_fonts`，請保留完整套件目錄。若修改程式碼，執行 `npm.cmd run build` 重新編譯。

M6-A 的 DOC／XLS 使用純 JavaScript，不必安裝 Word／Excel；SheetJS 官方套件隨包保存在 `vendor/`，請勿移除。其他新增套件為 `word-extractor`、`postal-mime`、`htmlparser2`，版本由鎖檔固定。支援範圍及公司驗收見 [M6-A 驗證與驗收](docs/M6A-VALIDATION.md)。

## CLI 命令

```powershell
node dist/src/cli.js index "C:\Documents" --verbose
node dist/src/cli.js search "合約" --type pdf,docx --page 2 --page-size 20 --verbose
node dist/src/cli.js search "付款 例外 規格" --all-terms
node dist/src/cli.js context "合約" --out "$env:USERPROFILE\Desktop\context.json"
node dist/src/cli.js context "合約" --clipboard
node dist/src/cli.js watch
node dist/src/cli.js autoupdate start
node dist/src/cli.js autoupdate status
node dist/src/cli.js autoupdate stop
node dist/src/cli.js autoupdate startup enable
node dist/src/cli.js autoupdate startup status
node dist/src/cli.js autoupdate startup disable
node dist/src/cli.js tui
node dist/src/cli.js ui
node dist/src/cli.js ui --no-open
node dist/src/cli.js mcp
node dist/src/cli.js setup codex --dry-run
node dist/src/cli.js setup codex
node dist/src/cli.js doctor
node dist/src/cli.js status
node dist/src/cli.js status --issues --types
node dist/src/cli.js rebuild --verbose
.\docsearch.cmd search "合約"
```

- `index`：立即完整校正。新增、重新處理修改文件、重試解析錯誤、略過未變更文件，並移除已確認刪除的索引。會枚舉根目錄；可登錄多個根目錄；若新路徑涵蓋既有子根，會合併歸屬而不刪文件。已包含於上層的子目錄只同步該子樹。不帶路徑則更新全部已登錄位置。日常單檔變更請用 `autoupdate start`。
- `tui`：啟動核准的鍵盤導向本機終端介面。結果區以 ↑／↓、Space、Enter、PgUp／PgDn 操作，Esc／← 返回，Tab／Shift+Tab 在輸入、結果與已選清單間切換；80×24 與 120×40 均保留固定搜尋列和操作提示。`/help` 顯示完整命令，`/select`、`/unselect`、`/selected`、`/clear` 等 slash command 是 fallback。最多選 20 份文件，再以 `/context [1～10]` 完整預覽；只有輸入 `yes` 才複製到本機剪貼簿。非文字焦點 q、`/quit` 與 EOF 退出 0，Ctrl+C 退出 130。TUI 不開網路連接埠，非互動 CLI 行為保持不變。
- `ui`：啟動只綁 `127.0.0.1` 的 desktop-only 瀏覽器工作台。搜尋可指定檔名／內容、根目錄、格式、解析狀態與排序；「完整校正」列舉全部已登錄檔案但略過未變更文件，進行中可停止。設定頁可啟停既有背景增量更新。任何拖曳格式都保留於本次工作階段；支援格式可解析並加入上下文，不支援或解析失敗者只能搜尋檔名並可移除。拖入檔案不加入永久索引。預覽與複製可完全離線；本 GUI 不提供 Provider、model、API Key、AI question、送出或 answer；`--no-open` 只顯示帶亂數 token 的本機 URL，不自動啟動瀏覽器；Ctrl+C 關閉並清除臨時資料。
- `search`：只搜尋現有索引。互動終端每頁預設 20 份，可輸入 `n` 下一頁、`p` 上一頁、`/ 關鍵字` 縮小目前全部命中、`back` 撤回、`reset` 重設、`q` 結束；即使只有一頁或零結果也可操作。非互動輸出只顯示指定頁並提示下一頁命令。`--page-size` 為 1～100，`--page` 從 1 起算；舊 `--limit` 保留為單次輸出，不能與分頁參數併用。每次都會顯示總命中數，避免把前 20 筆誤認為全部。`--type` 接受逗號分隔格式，可有前導點且忽略大小寫；例如 `.PDF,DocX,xml`。`--verbose` 另向 stderr 輸出 `SEARCH_TRACE <JSON>`，包含總耗時、bottleneck、phase timings、candidate strategy/source、文件／payload counts 與結果數；trace 不寫 SQLite 或 profile。
- `.xlsm`／`.odt`／`.rtf`／`.csv`：XLSM 沿用安全 OOXML 儲存格解析且忽略巨集；ODT 擷取標題、段落、清單、表格與連結；RTF 使用與 MSG 共用的受限解析核心；CSV 支援引號、逗號、quoted newline、UTF-8／Big5 與 BOM。既有 metadata-only 紀錄下一次普通 `index` 會自動重試，不必 rebuild。
- `.xml`：依來源行保存原文，搜尋包含標籤、屬性和值；支援 UTF-8、UTF-16 BOM／XML 起始位元組，以及目前 Node.js `TextDecoder` 支援且由 XML declaration 宣告的編碼。格式不完整仍可作原文搜尋，不解析 DTD 或展開外部實體。
- `status`：顯示索引容量、各文件狀態彙總、最後嘗試／完整同步時間。摘要是歷史紀錄，不是目前索引累計狀態。`--issues` 列出目前文件問題與各根同步診斷；`--types` 依副檔名統計份數、來源 bytes 與狀態。
- `.java`／`.sql`／`.js`：逐非空白行保存原文（含註解與字串）。`.class` 僅檔名。文字檔採 BOM／XML 宣告優先，否則嚴格 UTF-8，失敗才回退 Big5。舊 TXT／MD／AsciiDoc／XML 執行一次普通 `index` 即升級，不必 rebuild。
- `rebuild [root]`：重解析指定根目錄，省略時處理全部已登錄位置的文件，不修改或刪除來源文件。重建只影響該根目錄；根目錄無法讀取時保留既有資料並回報問題。

初次索引或要立刻完整校正時執行 `index`。日常檔案新增／修改／刪除請 `autoupdate start`，用 `autoupdate status` 查看事件、局部更新與根目錄掃描次數。解析器更新若影響先前成功的文件（例如 M4 超連結修正），執行 `rebuild`；M4 升級 M5 的搜尋改善不需重建，執行一次 `index` 即可保存新的同步摘要。

## 選取討論上下文（可選）

```powershell
.\docsearch.cmd context "討論關鍵字" --out "C:\Users\你的帳號\Desktop\context.json"
```

在清單輸入編號切換選取，`s <另一個查詢>` 保留已選內容並搜尋下一批候選；`b` 查看跨查詢清單，`r <編號>` 移除。`n`／`p` 翻頁，`v` 預覽；`done` 顯示完整匯出內容，再輸入 `yes` 建立檔案。`q`、Ctrl+C 或結束輸入會取消。跨查詢最多選 20 份，預設 100 筆候選（--limit 最高 500）。可用 `--type`、`--root` 縮小範圍。

改用 `--clipboard` 可在相同預覽與 `yes` 後直接複製 Markdown，與 `--out` 二選一；加 `--format json` 可複製 JSON。內容只寫入本機剪貼簿，不會自動送到 AI 或聊天服務。剪貼簿可能被其他本機程式或作業系統剪貼簿歷程讀取，請依公司政策使用。

如果先用 search 找過文件，可加 `--select "文件代碼1,文件代碼2"` 預選，再調整並確認；省略 query 則先提示輸入關鍵字。預選代碼需出現在本次候選中。

- 匯出是路徑、各自選取查詢、命中片段及來源資訊的 JSON／Markdown，只有選取內容，不含完整文件或未選文件。CLI `context` 本身仍不接模型；本機 desktop workbench 只做 preview／複製，不提供 Provider／Key／問題／外部送出。既有 MCP App／CLI 行為若需 AI 接入，仍依各自契約，不與本工作台混用。若來源或索引已變更，先重新 index 再選取。既有輸出檔案不覆寫，請改用新檔名。

Windows 所有命令皆可用 `.\docsearch.cmd` 代替 `node dist/src/cli.js`；不需要全域安裝或修改 PATH。此入口需 Node.js 已可從終端執行。

## 連接 Codex／MCP Host

0.35.0 保留四個唯讀工具：`search_documents`、`prepare_context`、`index_status`、`open_search_app`。最後一個工具會在支援 MCP Apps 的 Host 顯示搜尋／勾選工作台；資料工具仍可脫離介面使用。完成 `npm ci` 後可先唯讀診斷並預覽註冊內容：

```powershell
node dist/src/cli.js doctor
node dist/src/cli.js setup codex --dry-run
node dist/src/cli.js setup codex
```

`setup codex` 先檢查既有 `localdocsearch`：相同設定不重複新增，同名但指向不同安裝時拒絕覆寫。若要手動註冊，官方 Codex CLI 等價命令為：

```powershell
codex mcp add localdocsearch -- node "C:\完整路徑\LocalDocSearch\dist\src\cli.js" mcp
```

macOS／Linux 將路徑改成解壓目錄的絕對路徑。可用 `codex mcp list` 或 Codex 內的 `/mcp` 核對。只有明確執行 `setup codex` 才會請 Codex CLI 寫入設定；`doctor` 與 `--dry-run` 都不修改設定。Host 以子程序啟動 `docsearch mcp`，stdout 僅供 MCP JSON-RPC，不開 port。

- MCP Host 若支援 `open_search_app`，它開啟的是 MCP App 資源自己的工作台契約；無 UI 時，流程仍是 `search_documents` → 顯示代碼與短片段 → 你明確選代碼 → `prepare_context`。本機 desktop workbench 本批不提供「加入並送出問題」或 Provider 控制。後者最多 20 份文件、每份 10 段、總計 256 KiB，並會重新核對來源；沒有全選或整庫自動灌入。ChatGPT 網頁不會直接讀取本機 Codex 的 stdio 設定，不能把本機索引誤當成已連上雲端。

## 多根目錄

```powershell
node dist/src/cli.js index "C:\工作文件"
node dist/src/cli.js index "D:\BU資料"
node dist/src/cli.js roots
node dist/src/cli.js index
node dist/src/cli.js search "內文關鍵字"
node dist/src/cli.js search "內文關鍵字" --root "D:\BU資料"
node dist/src/cli.js rebuild "C:\工作文件"
node dist/src/cli.js roots remove "D:\BU資料"
```

搜尋預設涵蓋所有登錄位置；`--root` 使用 roots 顯示的路徑。`roots remove` 只移除該位置的索引，不刪來源。父子重疊根目錄會被拒絕，避免重複與排除規則衝突；同一位置的別名沿用既有根目錄。某個目錄離線時保留其舊索引並提示，其他目錄仍更新。

首次使用本版自動升級舊單根目錄資料庫，不必重建；已升級的多根目錄索引請勿交由舊版程式操作。公司實測集中使用 [整合驗收清單](docs/INTEGRATED-ACCEPTANCE.md)，不需逐版重新安裝。

## 開啟搜尋結果

搜尋結果附上文件代碼，例如 `12-a1b2c3d4e5f60708`，這不是結果排名。複製自己的代碼執行：

```powershell
node dist/src/cli.js open 12-a1b2c3d4e5f60708
node dist/src/cli.js reveal 12-a1b2c3d4e5f60708
```

`open` 使用預設程式開啟；`reveal` 在檔案總管選取來源。加上 `--dry-run` 可先檢查路徑而不開啟。來源不存在、不可讀、變成連結或代碼失效時拒絕操作；重建或移除根目錄後，代碼若失效請重新搜尋。內容更新後仍開啟目前來源，並提示索引可能過期。

Windows 使用內建 Windows PowerShell；不要求管理員、SDK 或變更執行政策。被公司政策封鎖或沒有檔案關聯時回報 `ACTION_LAUNCH_FAILED`，不嘗試繞過。成功訊息只表示請求送出，不能保證外部應用程式已顯示。M7 公司驗收見 [驗收文件](docs/M7-VALIDATION.md)。


## 監看自動增量

前台 `watch` 與背景 `autoupdate` 共用局部更新引擎；檔案變更不會每次掃描整根。`autoupdate start` 的啟動／週期校正使用可接續背景批次，每批最多 500 個 entries 或約 250 ms，批次間釋放 writer lock；事件優先且至少每 5 秒讓出一次校正機會。不做 Windows 服務、不開機常駐。

```powershell
node dist/src/cli.js watch
node dist/src/cli.js watch "C:\工作文件" --debounce 2000 --verbose
```

省略路徑時監看全部已登錄位置；指定路徑必須已用 `index` 登錄。預設防抖 1500 ms（`--debounce` 200～60000）。略過 `.git`、`node_modules`、`.localdocsearch` 與 `~$` 暫存。啟動同步期間的變更會排入後續同步；Ctrl+C 等進行中的同步完成後結束。預設每次同步完成後 5 分鐘增量校正，以補償遺漏事件；`--rescan 60000` 改為 1 分鐘，`--rescan 0` 關閉。監看器失效時降級定期掃描並重試；關閉校正時，全部監看失效才自動退出。詳見 [M12 驗證](docs/M12-VALIDATION.md)。M13 起，同一索引寫入互斥；手動命令遇到 INDEX_BUSY 可稍後重試，watch 會自動重試。移除成功後，watch 下次同步會停止該根。

## 人選上下文（可選）

在互動終端把搜尋命中匯出成 JSON 片段檔，供你手動帶入允許的討論通道；**不連線 AI、不自動外傳**。

```powershell
node dist/src/cli.js context "內文關鍵字" --out "$env:USERPROFILE\Desktop\context.json"
node dist/src/cli.js context "內文關鍵字" --format md --passages 5 --out "$env:USERPROFILE\Desktop\context.md"
node dist/src/cli.js context --out "$env:USERPROFILE\Desktop\context.json" --select 12-a1b2c3d4e5f60708 --type msg --root "D:\BU資料"
```

流程：列出候選 → 編號勾選 → 視需要用 `s <查詢>` 搜尋其他來源並繼續勾選 → `v` 預覽／`done` 後輸入 `yes` 才寫入。`--format md` 產出可貼上的 Markdown；`--passages` 控制每份文件最多幾段命中。取消、EOF、非互動或沒有結果不建檔；禁止覆寫。詳見 [M14](docs/M14-VALIDATION.md)。


## 搜尋結果

從舊版升級後，重新執行 `index "原本的資料夾"` 即會加入新格式，原本成功的格式不必重解析。`--type doc,xls,mht,mhtml` 可查看 M6-A 格式，`--type msg` 可只搜尋郵件。

排序依序為檔名完全符合（含副檔名）、檔名包含、標題、內容；同級依修改時間由新到舊，再按完整路徑固定字串順序。每份文件只列一筆，顯示命中原因、來源位置、片段與修改時間。僅命中檔名時會明確標示，不顯示無關段落。

查詢預設採 Unicode NFKC 正規化及忽略大小寫的整段子字串比對，保留原文片段；中文不需斷詞。加上 `--all-terms` 後，空白分隔的每個關鍵字都必須出現在同一份文件，可分散在檔名、標題或不同段落。未加選項時，`"年度 合約"` 的空白仍是片語的一部分；`AND`、`*`、`?` 都是一般文字。沒有布林、正規表示式、繁簡轉換或語意搜尋。片段最多 160 個 Unicode code point，過長命中會標示截短。

`--verbose` 顯示排序依據，或索引時的排除規則與錯誤階段／代碼。同步摘要區分新增、重新處理、未變更、移除、各解析狀態、略過原因及耗時。「同步完整」表示掃描／讀取流程完整，不表示所有文件都成功擷取文字。

## 索引位置與排除規則

Windows 預設索引：`%LOCALAPPDATA%\LocalDocSearch\index.db`。索引含有衍生文件文字，請依公司文件政策保管。可用 `LOCALDOCSEARCH_DATA_DIR` 指定測試資料位置，程式會在其下建立 `LocalDocSearch/index.db`；測試與 Demo 使用獨立暫存目錄。

在來源根目錄建立 `.localdocsearchignore`：

```gitignore
# 排除任一層的 archive 目錄
archive/
# 排除備份文字檔
*.backup.txt
# 只排除根目錄下 private 內的 PDF
/private/*.pdf
```

支援 `*`、`**`、`?`、根目錄 `/` 與目錄尾端 `/`；不支援 `!` 重新納入。修改後再次 `index`。固定略過 `.git`、`node_modules`、`.localdocsearch` 和 `~$` 暫存檔，不自動套用 `.gitignore` 或略過所有隱藏檔；不追蹤符號連結及 Windows junction。

略過數只計已遇到的項目，排除整個目錄不會統計其內部文件。掃描不完整時，增量索引保留無法確認的既有文件，並在搜尋中提示最近同步不完整。

## 格式限制與故障排除

| 狀態／情況 | 說明與處理方式 |
|---|---|
| `indexed` | 已擷取可搜尋文字 |
| `no_text` | 空文件或沒有文字層的 PDF；仍可搜尋檔名，未提供 OCR |
| `encrypted` | 可辨識的加密 PDF／DOC／XLS 無法擷取內容；仍可搜尋檔名 |
| `too_large` | 單檔超過 100 MB，不讀取內容；仍可搜尋檔名 |
| `error` | 檢查原始文件可否開啟及讀取權限；修正後再次 `index` 會重試 |
| 搜尋不到最新內容 | 再次 `index`，查看 `status`；解析器更新後必要時 `rebuild` |
| 沒有 M5 歷史摘要 | 舊索引仍可搜尋；再次 `index` 保存摘要 |
| 排除規則錯誤 | 移除不支援的 `!` 或修正讀取權限，再執行 `index` |
| PDF `Invalid factory url` | 使用目前版本並確認本機 PDF.js 資源完整，再 `index` 重試 |

DOCX／XLSX 可搜尋超連結顯示文字及實際目標；來源位置可能為段落、儲存格或 Word 部件。XLSX 使用公式快取值與常見數字／日期格式，不重新計算公式；複雜自訂格式仍可能與 Excel 畫面不同。

DOC 以正文／註腳等部位與擷取段落定位，不提供 Word 頁碼，也不保證內嵌物件或所有欄位網址；只接受 Word 97–2003 OLE，改副檔名的 RTF／HTML 會記錄解析錯誤。XLS 讀取 BIFF 儲存格、快取結果與超連結，不執行公式、巨集或外部連線。DOC／XLS 每份文件在獨立 worker 解析，30 秒逾時或 worker 失敗時保留可搜尋檔名，下次 `index` 重試。

MHT／MHTML 只擷取 MIME 主體的 HTML 或純文字，不索引附件、圖片或外部資源；HTML 不執行腳本，來源位置為擷取段落。AsciiDoc 索引原始文字及行號，不展開 include。`.vsd` v11 擷取直接圖形文字，較舊版本或不支援結構為 unsupported，仍可搜尋檔名；`.ppt` 仍未支援。M17 起，未知副檔名與無副檔名的一般檔案會保留路徑、檔名、類型、大小與修改時間，可依檔名搜尋及開啟；其內容不會被讀取或搜尋。

MSG 不必安裝 Outlook。正文優先採 HTML，其次純文字，再還原壓縮 RTF，只取一種可讀表示。結果會標明「郵件主旨／寄件者／副本／正文」；不索引附件檔名與內容、不展開附加郵件，也不支援 PST／OST。S/MIME 簽章或加密郵件列 `error`／`MSG_SMIME_UNSUPPORTED`，仍可搜尋檔名；不是已全文索引。一般 RTF 的表格／特殊欄位不保證與 Outlook 相同。MSG 同樣有 30 秒解析期限，RTF 資料另限 20 MiB；超過上限或損壞會明確報錯。

CLI 結束碼：0 為命令完成（單檔問題請看摘要），2 為參數錯誤，3 為根目錄／設定／尚未建立索引，4 為致命內部錯誤。

## 測試、效能與 Demo

```powershell
npm.cmd test
node scripts/demo.mjs
npm.cmd run demo:msg
npm.cmd run benchmark -- "docs/benchmark-windows.json" "SSD"
npm.cmd run package
```

效能腳本建立 1,000 份六格式合成文件，測量首次、無變更及新增／修改／刪除各 10 份的增量索引，並執行 20 組搜尋，每組暖機 3 次、正式 10 次。延遲包含 CLI 啟動、SQLite、排序和輸出；會核對完整命中清單與順序，並驗證無變更時解析器呼叫為 0。請將 `SSD` 改為實際儲存裝置類型；資料在作業系統暫存目錄生成，完成後清除。

測量方法、資料集限制與本機結果見 [M5 驗證報告](docs/M5-VALIDATION.md)。[Windows 驗收表](docs/M5-WINDOWS-ACCEPTANCE.md) 列出仍需在公司電腦執行的步驟；[Demo 與書審材料](docs/M5-DEMO.md) 提供展示流程及架構說明。

既有基準尚未涵蓋 M6-A／M6-B 新格式，M5 歷史報告不是新版效能證據。

產品規格見 [SPEC](docs/SPEC.md)，目前進度見 [STATUS](docs/STATUS.md)，設計原因見 [DECISIONS](docs/DECISIONS.md)。

## 多終端同時使用

0.16.0 起，index／rebuild／roots remove 與 watch 的同步共用寫入協調。忙碌時手動命令回傳 INDEX_BUSY（退出碼 3），不改動索引；search／status 仍讀取已提交內容。watch 等待事件時不占用寫入鎖，遇忙碌會防抖後重試。

索引旁的 `index.db.writer.sqlite` 是協調檔，不含文件內容；即使留在磁碟上也不表示鎖住。程序正常或異常結束後會釋放鎖，請勿在執行期間刪除它。索引應保留在本機磁碟，且不要同時執行舊版 LocalDocSearch。詳見 [M13 驗證](docs/M13-VALIDATION.md)。

目前功能、測試能證明的範圍，以及 Windows／AI 接入仍缺哪些證據，集中見 [產品目標盤點](docs/GOAL-AUDIT.md)。
