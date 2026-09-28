# Seekah 使用手冊

Seekah 在本機建立文件索引，讓你搜尋、挑選命中片段並複製精確上下文。文件原檔留在原位置；搜尋、索引與預覽不需要網路。

## 第一次啟動

1. 安裝 Node.js 22.17.0 以上。解壓後直接雙擊啟動，不必先開終端執行 `npm ci` 或 `index`。
2. Windows 雙擊 `seekah-ui.cmd`；macOS 對 `seekah-ui.command` 執行一次 `chmod +x seekah-ui.command` 後雙擊。會跳出命令視窗顯示進度，請不要關掉。
3. 第一次若尚未安裝相依，視窗會立刻出現「正在建立相依套件」和 npm 輸出；完成後顯示「相依與程式已建立完成」並自動開啟工作台。已安裝過會略過安裝，約數秒內開啟。
4. 尚無索引時，在工作台按「加入資料夾」開啟本機資料夾選擇器；選定後按「確認並建立索引」，畫面才會開始顯示檢查進度。已有索引時不會因開啟工作台而自動全量掃描；需要時按「完整校正」，日常變更則到設定開啟背景自動更新。

不要把整顆系統磁碟當成索引根目錄。先選一個實際工作資料夾，確認搜尋結果正確後再加入其他根目錄。按取消或尚未按確認都不會送出索引；選擇器回傳的是本機完整路徑，不需要手動輸入 `%USERPROFILE%` 或 `$env:USERPROFILE`。非 Windows 若沒有本機資料夾選擇器，請繼續使用 CLI `index <資料夾路徑>`。

## 最簡單：圖形工作台

啟動：

```sh
node dist/src/cli.js ui
```

Windows 可改用：

```powershell
.\seekah.cmd ui
```

Seekah 只在 `127.0.0.1` 啟動本機工作台。若瀏覽器沒有自動開啟，使用終端印出的網址；網址中的 token 是這次工作階段專用，不要分享。工作台是 desktop-only：最小桌面寬度 1180 CSS px；1440 與 1920 寬度使用同一套版面，不提供手機底部導覽。
頂列的「Trace」會開啟獨立診斷頁（同一個本機工作階段 token）。頁面會每 5 秒讀取最近的 search／answer 事件，可依類型與 success／error 篩選，展開 phase timing、candidate source、counts、bottleneck 與 raw JSON。

### 工作台版面

- 頂列：全域搜尋、完整校正、同步中的停止按鈕、設定與本機索引狀態。
- 左側導覽：所有文件、臨時文件、實際索引根目錄、根目錄管理、垃圾桶與「已選上下文」入口。上下文不是永久第三欄；按「已選 N」才開啟固定抽屜，Esc、遮罩或 × 可關閉。
- 文件頁：可選「檔名與內容／只搜尋檔名／只搜尋內容」，並以根目錄、格式、解析狀態篩選。排序只重排目前已取得的結果，不會再次搜尋；規則為相關性、檔名 A→Z 或最近修改。相關性固定依檔名完全符合、檔名包含、標題、內容，同級較新者優先。
- 文件明細：點「檢視」進入獨立明細 route。左側顯示 metadata／索引片段，右側顯示命中片段預覽；右側明確標示不是完整文件，兩側可各自捲動。

### 搜尋與開啟原檔

1. 在頂列或文件頁搜尋欄輸入關鍵字，選擇 `phrase` 或 `all-terms`，按「搜尋」。
2. 每列顯示檔名、格式、完整路徑、命中原因、位置與 server 片段。Preview list／Table 只是兩種顯示，不會改變查詢或選取集合。
   0.39.0 起，文字以壓縮區段儲存，搜尋只驗證需要的候選，找滿當頁即停止；索引約為文字量的 0.5–1 倍（0.38 約 6 倍）。0.39.0 以前建立的索引第一次在工作台搜尋時，會在背景轉成區段儲存：API 暫回 202，畫面保留原查詢並在完成後自動重送。CLI 的 `index` 等寫入命令也會先完成升級。升級逐批提交、可中斷，下次會從中斷處接續；完成後移除舊的段落表、payload 與所有舊搜尋索引，空白頁超過一半時自動壓縮資料庫一次（期間無法中斷）。
   CLI `search`、`status` 與 MCP 是唯讀，不會偷偷升級；升級完成前它們使用舊路徑，結果相同但較慢，總數永遠精確。
   **總筆數**：預設「快速」，命中超過 500 份時顯示「500 筆以上」；設定頁可改為「精確」，常見詞會先顯示結果，再於數秒內補上精確總數。CLI 用 `search --exact-total`，MCP `search_documents` 用 `exactTotal: true`，回應的 `totalRelation` 為 `gte` 時 `total` 是下限。工作台、MCP 與 TUI 只開放前 500 筆；CLI 翻到之後的頁會繼續驗證。
3. 點「檢視」進入明細；在結果、明細或上下文抽屜按「開啟檔案」／「顯示位置」，只送出該結果的 stable reference，不送任意路徑。
4. 開啟前，Seekah 會用搜尋結果的文件代碼重新確認檔案仍位於已索引根目錄、不是連結、是可讀的一般檔案。檔案已移動、刪除或索引過期時會拒絕操作，請重新搜尋或重新索引。

「開啟檔案」只表示系統已接受啟動請求；外部應用程式若被公司政策或檔案關聯封鎖，Seekah 會顯示錯誤。Linux 目前不支援此操作，仍可從明細複製路徑後自行開啟。

### 建立與複製上下文

1. 勾選結果左側 checkbox；「已選 N」會累積已選文件，跨頁和跨查詢仍保留。索引文件與臨時文件合計最多 20 份；同一 stable reference 不重複計數。
2. 按「檢查精確上下文」。對話框會重新向 server 驗證選取來源，顯示這次實際文字與 UTF-8 bytes；GUI 不顯示建立／修改時間等索引雜訊。
3. 按「複製預覽」後，內容只會寫入本機剪貼簿。選取或搜尋模式改變會使舊預覽失效，必須重新檢查。

工作台目前不提供聊天助手、Provider、model、API Key、AI question、送出或 answer 控制；這不影響 CLI／MCP 既有行為。

### 臨時文件、根目錄與垃圾桶

- 「臨時文件」接受任何格式，只保留本次工作階段且不寫入永久索引。支援格式可解析並加入上下文；不支援或解析失敗的項目仍有穩定 ID、可依檔名搜尋及移除，但因沒有正文不能加入上下文。
- 「根目錄」頁只顯示實際登錄根、文件數、完整性與錯誤摘要。「加入資料夾」只開啟本機選擇器；選取後先顯示唯讀路徑，按「確認並建立索引」才呼叫索引。取消或未確認不會新增根。
- 「完整校正」會列舉已登錄根目錄並比較 metadata，只重新解析新增或變更文件。進行中可按「停止同步」；server 等索引 store 關閉後，根目錄移除才會重新啟用。
- 工作台索引的列舉、解析與寫入在背景 worker 執行；即使單一大檔或慢格式仍在處理，狀態頁、搜尋與「停止同步」仍可回應。畫面每 750 ms 更新一次，會顯示檢查數與目前檔名；重新整理頁面不會停止這輪索引。
- 索引進度另存於索引資料目錄的 `indexing.json`，只含狀態、計數、路徑與摘要，不含文件正文。若命令視窗或程序在索引中被關閉，重開工作台會顯示「上次索引程序已中斷」；這不是索引損壞，已提交的文件仍保留，再按「完整校正」會從已提交文件接續，未提交文件會重新檢查。
- 「完整校正」在同一輪可能先列舉／檢查，再進行解析或搜尋 postings 升級；這些是同一個索引請求的不同階段，不代表 UI 自己送出了第二次。只有按下按鈕或 API 明確送出才會開始新一輪。
- 勾選根目錄後按「移至垃圾桶」：預設顯示確認對話框，明確說明只移除索引、不刪來源。勾選「下次不再提醒」只在刪除成功後保存；設定可重新開啟提醒。
- 「垃圾桶」列出根路徑、文件數與 `deletedAt` metadata。可還原並重新索引，或在永久刪除確認後只刪 metadata；來源資料夾與檔案不會被刪除。
- 設定頁可保存刪除提醒與總筆數模式（快速／精確），並實際啟動／停止既有 detached 背景自動更新。背景更新以檔案事件做增量更新，預設每 6 小時完整校正；這不是只改畫面的假開關。

## 終端使用方式

不想開瀏覽器時，可直接搜尋：

```sh
node dist/src/cli.js search "合約"
node dist/src/cli.js search "付款 例外 規格" --all-terms
node dist/src/cli.js search "合約" --verbose
node dist/src/cli.js status
```
加上 `--verbose` 時，CLI 仍把一般結果寫到 stdout，並向 stderr 輸出一行 `SEARCH_TRACE <JSON>`；同一筆 trace 也會追加到索引資料目錄的 `trace.log`。Windows 預設為 `%LOCALAPPDATA%\LocalDocSearch\trace.log`；指定 `LOCALDOCSEARCH_DATA_DIR` 時位於 `<該目錄>\LocalDocSearch\trace.log`。log 以 JSONL 保存，單檔 2 MiB、最多保留目前檔加 4 個輪替檔。Workbench 頂列「Trace」或同一工作階段的 `/traces#<token>` 會開啟獨立 UI；`/api/traces` 提供受 token 保護的篩選 API。search trace schema version 5 內含總耗時、`bottleneck`（self）、`inclusiveBottleneck`、`phasesMs`（inclusive）與 `phaseSelfMs`（self）、candidate strategy/source、文件／payload counts、payload ordinal block expansion、full-document／filename-only fallback、完整結果數與本頁回傳數；answer trace 仍使用自己的 phase schema。trace log 不含 API Key、文件正文、上下文正文或 answer 正文，但會保留查詢／問題字串供本機追查；不寫回 SQLite 或 profile。
0.39.0 的 `candidateStrategy` 為 `chunk-index`（結果內搜尋為 `chunk-index+restricted-ids`）；`indexPostingRows` 是檔名／heading／區段索引回傳列數，`indexCandidateChunks` 是候選區段數，`indexVerifiedChunks`／`indexVerifiedBytes` 是實際解壓驗證（含當頁 snippet）的區段數與壓縮位元組；`totalRelation` 為 `gte` 表示快速模式提前停止、總數是下限。`payloadsRead` 恆為 0。以下 payload 欄位說明只適用於升級完成前的舊路徑：
`postings` 只回傳文件 ID，不回傳 payload ordinal；payload-level pruning 與 block reconstruction 的數字分別看 `payloadsAfterPruning`、`expandedPayloads` 與 `blockExpansionRatio`。`payloadsRead` 是所有實際 stream pass 的總和，page materialization 可能重新讀取同一文件，因此不必等於或小於 `payloadsConsidered`。
診斷慢查詢時，`diagnostics.payloadSql` 分開顯示 metadata、owning-block mapping、blob 查詢的 prepare／execute 次數與時間；execute 含 SQLite 回傳 JS rows／blob 的成本，不等於純磁碟 I/O。`blocksMetadataRows` 是 metadata query 回傳列數，`owningBlockMappingRows` 只含獨立 `blockSource` mapping rows；filtered ranking／snippet 的 selected CTE 內部 mapping 不重複計數。`candidatePayloadOrdinals`、`owningBlocksFound`、`blockExpansionInputPayloads` 可對照候選 payload、selected owners 與 block expansion 輸入。`diagnostics.payloadReads` 分開 ranking、snippet 回讀與其他讀取；`uniquePayloadsRead`／`duplicatePayloadsRead` 可辨識跨 pass 重讀。`compressedBytesRead`／`decompressedBytes` 包含實際重讀／解壓量；`payloadBrotliMs` 與 `payloadDecodeParseMs` 是 decompression phase 的子計時，不能再相加到總 phase。`exactTextMs` 是 block 正規化／比對，不等於包含重建與 Map 成本的 exact self。詳細量測與限制見 [0.37.0 驗證](0.37.0-VALIDATION.md)。

直接用系統程式開啟或顯示檔案位置：

```sh
node dist/src/cli.js open 12-a1b2c3d4e5f60708
node dist/src/cli.js reveal 12-a1b2c3d4e5f60708
```

文件代碼來自搜尋結果，不是排名。先加 `--dry-run` 可只驗證來源，不啟動外部程式。

全螢幕終端介面：

```sh
node dist/src/cli.js tui
```

在結果畫面用 ↑／↓ 移動、Space 勾選、Enter 看片段、PgUp／PgDn 換頁、Esc／← 返回；Tab／Shift+Tab 切換輸入、結果與已選清單。輸入 `/help` 查看所有 fallback 命令。要複製 context，必須在確認列完整輸入 `yes`；`q` 在非文字輸入焦點退出。

## 日常變更與完整校正

第一次請用工作台「選擇資料夾」後按「確認並建立索引」，或命令列 `index` 建立索引。之後日常新增、修改、刪除請啟動背景更新：

```powershell
.\seekah.cmd autoupdate start
.\seekah.cmd autoupdate status
.\seekah.cmd autoupdate stop
.\seekah.cmd autoupdate startup enable
.\seekah.cmd autoupdate startup status
.\seekah.cmd autoupdate startup disable
```

`autoupdate start` 會先掛監看，再以可接續的背景批次做啟動校正，然後對檔案事件做局部更新；健康時單檔變更不必再跑完整 `index`。每批最多檢查 500 個 entries 或約 250 ms，批次之間會釋放 writer lock；事件優先，但至少每 5 秒保留一次校正機會。監看預設是根目錄非遞迴加上各直屬子資料夾的遞迴 watcher；句柄上限 128，超出時改為整根粗範圍。`.localdocsearchignore` 排除的直屬子資料夾（例如 `/AppData/`）不建立 watcher；被排除路徑的事件在入口就丟棄，不寫入工作佇列、不觸發更新。修改 `.localdocsearchignore` 後監看範圍會依新規則重建，並排一次整根校正。檔案持續變動時，最長約 15 秒（防抖 10 倍）一定會處理一次。每輪最多處理 500 筆，整批只等一次防抖時間確認檔案沒在寫入；仍在寫入的檔案會延後到下一輪，連續 5 次仍在變動就先保留舊索引，等下次變動再處理。某個程式一次產生數千個檔案時，之後新建的檔案要等前面處理完，通常數十秒內可搜尋（依格式與電腦速度而定）。一直被改寫的檔案不會讓其他待辦永遠輪不到：每一輪先處理這一圈還沒處理過的待辦。資料夾本身的「修改」通知會忽略（裡面的檔案另有各自的通知）。新建或搬進來的資料夾會分批展開：每輪最多列出 2,000 個項目，檔案排在一般變更之後處理，所以搬進大型資料夾時，你之後新建的檔案仍能在數秒內搜尋；整個資料夾則需要較長時間才全部可搜尋。能定位到某一子範圍的未知事件只補掃該範圍。`index` 仍是立即完整校正：會枚舉整個根目錄並比對既有索引。`--profile` 請用目前這個 shell 已經展開的新檔案路徑（PowerShell 用 `$env:USERPROFILE\...`，CMD 用 `%USERPROFILE%\...`），報告含 enumerate／stat／parse／compress／bloom／write／commit，不含路徑或正文。
Windows 可選登入啟動必須明確執行 `autoupdate startup enable`；預設關閉，不安裝 Service、不要求管理員權限，也不會立即啟動第二個 daemon。`status` 顯示是否為 Seekah 擁有的 Startup 捷徑；`disable` 只移除 Seekah 自己建立的捷徑，遇到同名非產品檔案會拒絕。公司政策拒絕或非 Windows 平台會明確回報，手動 `autoupdate start` 仍可用。
`autoupdate status` 會顯示目前階段、最後事件、最後局部更新、最後／下次完整校正、事件／已排除事件／局部更新／根目錄掃描次數，以及工作佇列待辦與是否降級。「已排除事件」很大但 CPU 偏高時，通常是監看退回整根粗範圍（根目錄列顯示 `範圍=coarse`）；先確認直屬子資料夾數量，必要時 `autoupdate stop` 後重新 `start`。根目錄列出的校正世代、已檢查量、剩餘範圍與失敗 scope 是目前進度；總量未知時不顯示百分比。工作台狀態頁不顯示監看健康度。已落盤的事件在程序重啟後會重播；尚未落盤就中斷的窗口由啟動校正補回。佇列滿 10,000 條不同路徑時會改存 dirty scope 再校正該範圍。工作狀態庫在索引旁的 `.work.sqlite`，不含正文，也不是跨庫原子交易。

## 接到 Codex

工作台的「複製預覽」只進本機剪貼簿，不會自動成為 Codex 上下文。要讓 Codex 搜尋並引用 Seekah 索引，用本機 MCP，不是把 GUI 嵌進 Codex。

1. 先用工作台或 `index` 建好索引。
2. 確認這台電腦能執行 `codex`（Codex CLI／Desktop）。在 Seekah 解壓目錄執行：

```bat
node dist\src\cli.js doctor
node dist\src\cli.js setup codex --dry-run
node dist\src\cli.js setup codex
```

macOS／Linux 把反斜線改成 `/`。Windows 也可用 `.\seekah.cmd setup codex`。

3. 重新開啟 Codex 工作階段，輸入 `/mcp`。應看到名稱 `localdocsearch`（相容舊識別，不是 seekah）。
4. 在對話裡請它搜尋關鍵字。它會呼叫 `search_documents`，列出文件代碼與短片段。你明確指定要哪些代碼後，它才呼叫 `prepare_context`；這份有界 Markdown 才進入該次 Codex 上下文。

上限 20 份文件、總計 256 KiB；沒有全選或整庫灌入。來源被改過會拒絕舊代碼，請再搜一次。若 Codex 顯示 MCP Apps 工作台，可改請它呼叫 `open_search_app` 勾選後加入上下文；沒有嵌入 UI 時，用上面的搜尋→選代碼流程即可。

ChatGPT 網頁讀不到這台電腦的 MCP，不要當成已連上。


## 常見問題

| 現象 | 處理方式 |
| --- | --- |
| 工作台顯示沒有索引 | 到「索引狀態」按「選擇資料夾」，在本機選擇器選定第一個資料夾，再按「確認並建立索引」。 |
| 要加入第二個資料夾 | 到「索引狀態」先按「選擇資料夾」，確認唯讀路徑後按「確認並建立索引」。也可繼續用 `.\seekah.cmd index "路徑"`。 |
| 加入資料夾時提示進行中 | 按「停止同步」，等畫面顯示已停止後再加入或移除；也可等目前同步完成。 |
| 索引百分比長時間不變 | 先看目前檔名與 API 狀態；Workbench 仍可操作時可按「停止同步」，再重新按「完整校正」。若剛關閉命令視窗，重新開啟後看到「上次索引程序已中斷」屬預期，已提交文件會保留。 |
| 重新整理後顯示索引狀態未知 | 先等待一次狀態輪詢；UI 會保留最後一次成功進度，短暫 SQLite busy／locked 不應清空畫面。若仍顯示暫時無法讀取，確認索引資料目錄可寫且只啟動一個工作台程序。 |
| 索引卡在單一檔案且停止沒有立刻完成 | 某些 parser／檔案 IO 只能在安全點取消；停止最多等待約兩秒後終止背景 worker。下次完整校正會依已提交 SQLite 交易重新檢查未完成文件。 |
| 用 `.localdocsearchignore` 排除大量檔案後同步較久 | 掃描後會顯示「刪除校正」目前／總數，每 1,000 份提交一次。可按「停止同步」或 Ctrl+C，已刪部分會保留，下次同步接續刪除其餘。資料庫檔不會自動變小；先 `autoupdate stop`，再執行 `compact` 回收空白頁，完成後 `autoupdate start`。 |
| 常見詞只顯示「500 筆以上」 | 這是預設的快速模式。要精確總數：工作台設定頁改為「精確」，或 CLI 加 `--exact-total`。 |
| 搜不到剛修改的檔案 | 到設定開啟背景自動更新，等狀態完成局部更新後再搜；也可按「完整校正」或執行一次 `index`。 |
| 要移除已索引目錄 | 若正在同步，先按「停止同步」。再到「根目錄」勾選目錄、按「移除所選」或個別「移至垃圾桶」並確認。來源資料不會刪除。 |
| autoupdate status 顯示工作佇列降級 | 工作狀態無法落盤。先確認磁碟空間與索引目錄可寫，再 `autoupdate stop` 後重新 `start`。 |
| 雙擊後出現「不是內部或外部命令」或「不是可執行的外部指令」 | 命令視窗找不到 Node.js。安裝 Node.js 22.17.0 以上並勾選 Add to PATH，關掉視窗後再雙擊。可先執行 `node -v` 確認。 |
| Codex 沒有 Seekah／搜不到文件 | 先建索引，再執行 `setup codex`，重開 Codex 後用 `/mcp` 核對 `localdocsearch`。複製預覽不會自動進 Codex。 |
| `setup codex` 說找不到 codex | 先安裝或更新 Codex CLI／Desktop，確認終端能執行 `codex`。 |
| 無法開啟檔案 | 確認檔案未移動、不是連結且有讀取權限；更新索引後再搜尋。 |
| 沒有 AI 送出功能 | 工作台只複製到剪貼簿。要給 Codex 用 MCP：`setup codex` 後請它搜尋並選定文件代碼。 |
| 關閉工作台後臨時文件消失 | 這是預期行為：臨時文件只保留在本次程序。 |

## 隱私與邊界

- 文件索引、搜尋、片段預覽、臨時解析與複製都在本機。
- 工作台不傳送文件、問題或 API Key 到外部 AI Provider。
- Seekah 不開放 LAN，不讀取瀏覽器 cookie；開啟工作台不會自動完整掃描既有根目錄。「完整校正」只同步已登錄根；先按「加入資料夾」、再按「確認並建立索引」才登錄新路徑。臨時文件仍只留在本次工作階段。
- 公司 Windows 與 Linux 外部開檔的正式驗收仍未完成；請先依公司政策用非機密測試資料驗證。
