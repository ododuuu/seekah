# Seekah 使用手冊

Seekah 在本機建立文件索引，讓你搜尋、挑選命中片段並複製精確上下文。文件原檔留在原位置；搜尋、索引與預覽不需要網路。

## 第一次啟動

1. 安裝 Node.js 22.17.0 以上。解壓後直接雙擊啟動，不必先開終端執行 `npm ci` 或 `index`。
2. Windows 雙擊 `seekah-ui.cmd`；macOS 對 `seekah-ui.command` 執行一次 `chmod +x seekah-ui.command` 後雙擊。會跳出命令視窗顯示進度，請不要關掉。
3. 第一次若尚未安裝相依，視窗會立刻出現「正在建立相依套件」和 npm 輸出；完成後顯示「相依與程式已建立完成」並自動開啟工作台。已安裝過會略過安裝，約數秒內開啟。
4. 尚無索引時，在工作台按「加入資料夾」開啟本機資料夾選擇器；選定後按「確認並建立索引」，畫面才會開始顯示檢查進度。已有索引時不會因開啟工作台自動做一次完整校正；預設會在背景更新未執行時提醒你選擇處理方式，也可在設定頁改成開啟工作台時自動補捉或完全不主動處理。

一般建議先選一個實際工作資料夾，確認搜尋結果正確後再加入其他根目錄。按取消或尚未按確認都不會送出索引；選擇器回傳的是本機完整路徑，不需要手動輸入 `%USERPROFILE%` 或 `$env:USERPROFILE`。非 Windows 若沒有本機資料夾選擇器，請繼續使用 CLI `index <資料夾路徑>`。

### 整顆 Windows 本機磁碟的預設排除

若明確把 Windows 本機磁碟根目錄（例如 `C:\`）加入，Seekah 仍可建立索引，但會預設略過 `Windows`、`Program Files`、`Program Files (x86)`、`ProgramData`、`Users\<profile>\AppData`、`PerfLogs`、`$Recycle.Bin` 與 `System Volume Information`。`Users`、`Desktop`、`Documents`、`Downloads` 及未列入清單的其他資料夾仍可掃描；UNC 路徑、非 volume 根目錄與 macOS／Linux 不套用這份 Windows volume 清單。

- 完整校正與背景更新會在摘要／狀態中保留「已排除」的規則計數；若排除範圍已有舊索引，下一次完整校正會清理索引列，但不刪除來源檔案或使用者設定。
- 需要索引被預設略過的內容時，先在 Seekah 移除父 volume root，再直接加入該內容的窄根目錄。父根仍存在時，新增窄根不是 override。
- 已知限制：Windows 8.3 short-name alias（例如 `C:\PROGRA~1`）不解析為 `Program Files`，因此透過 `PROGRA~1` 存取的路徑目前不會套用這項預設排除；這是已知漏排。請改用長檔名路徑或窄根目錄管理索引範圍。


### 找不到檔案時的排查

Seekah 不會把被排除的路徑當成「已成功索引」，也不會用歷史 skipped 計數猜測目前狀態。請針對目前路徑重新檢查：

- CLI：`node dist/src/cli.js exclusions` 查看每個已登錄根目錄的內建／磁碟預設規則、`.localdocsearchignore` 路徑與規則、逐規則最近略過計數及既有索引清理進度；`--root "根目錄"` 可只看一根。再執行 `node dist/src/cli.js explain "完整檔案路徑"`，結果會明確指出被排除、已索引、尚未索引、解析錯誤碼、僅檔名可搜尋或不在任何已登錄根目錄內。
- 工作台：搜尋零結果時，空狀態第二行提供「檢查某個檔案為何搜不到」輸入；「索引根目錄」每列可展開查看預設規則、理由、警告、逐規則略過與清理進度；設定頁的「哪些位置預設不索引」顯示同一份政策。
- TUI：零結果訊息會指向 `/explain <路徑>`；`/status` 顯示預設排除摘要，`/explain <路徑>` 重新計算目前狀態。MCP 可使用唯讀 `explain_path`，`index_status` 也會附排除摘要。
- 若說明結果是被排除，先看來源類別與命中的祖先路徑。需要索引時，依規則調整 `.localdocsearchignore`，或移除涵蓋它的父 volume root 後直接登錄窄根目錄；父根存在時窄根不是 override，`!` 不能重新納入，link／junction 也不會被追蹤。上述查詢只回傳路徑、規則、狀態與錯誤碼，不顯示文件正文。


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
- 搜尋結果（0.40.0 起）：像搜尋引擎的列表，每筆有檔名、路徑列（根目錄名稱 › 子資料夾 › 檔名 · 格式）與約兩行命中片段；下方有「顯示所在位置」、「加入上下文」、「複製路徑」與「複製檔名」操作。`all-terms` 若不同詞落在不同位置，檔名／路徑下會依序列出各段位置、命中詞與片段；列表與表格檢視都會顯示，片段可單獨框選複製。檔名、路徑與片段可用滑鼠拖曳選取，沒有獨立的明細頁。

### 搜尋與開啟原檔

1. 在頂列或文件頁搜尋欄輸入關鍵字，選擇 `phrase` 或 `all-terms`，按「搜尋」。查詢超過約一秒時會顯示實際等待秒數與「取消搜尋」按鈕；取消會顯示「搜尋已取消」，並保留上一筆結果與輸入。
2. 每列顯示檔名、路徑列與命中片段（最多約兩行，關鍵字標黃）。`all-terms` 的多段結果會顯示「第 N 行」等位置與該段命中詞；顯示上限外的搜尋詞會提示「還有 N 個詞未列出」。以檔名命中為代表時顯示「檔名符合」。可直接框選文字後按瀏覽器 `Ctrl+C`；「複製路徑」複製完整原始路徑，「複製檔名」複製原始檔名，中文、空白與 emoji 不會被轉義。列表／表格只是兩種顯示，不會改變查詢或選取集合。
   0.39.0 起，文字以壓縮區段儲存，搜尋只驗證需要的候選，找滿當頁即停止；索引約為文字量的 0.5–1 倍（0.38 約 6 倍）。0.39.0 以前建立的索引第一次在工作台搜尋時，會在背景轉成區段儲存：API 暫回 202，畫面保留原查詢並在完成後自動重送。CLI 的 `index` 等寫入命令也會先完成升級。升級逐批提交、可中斷，下次會從中斷處接續；完成後移除舊的段落表、payload 與所有舊搜尋索引，空白頁超過一半時自動壓縮資料庫一次（期間無法中斷）。
   CLI `search`、`status` 與 MCP 是唯讀，不會偷偷升級；升級完成前它們使用舊路徑，結果相同但較慢，總數永遠精確。
   **總筆數**：預設「快速」，命中超過 500 份時顯示「500 筆以上」；設定頁可改為「精確」，常見詞會先顯示結果，再於數秒內補上精確總數。CLI 用 `search --exact-total`，MCP `search_documents` 用 `exactTotal: true`，回應的 `totalRelation` 為 `gte` 時 `total` 是下限。工作台、MCP 與 TUI 只開放前 500 筆；CLI 翻到之後的頁會繼續驗證。
3. 點檔名直接以系統預設程式開啟原檔；若拖曳選取檔名，該次點擊只保留選取、不會誤開檔。點「顯示所在位置」在檔案總管中顯示；按「複製路徑」或「複製檔名」寫入本機剪貼簿。表格檢視點檔名、上下文抽屜按「開啟」也一樣。只送出該結果的 stable reference，不送任意路徑。
4. 開啟前，Seekah 會用搜尋結果的文件代碼重新確認檔案仍位於已索引根目錄、不是連結、是可讀的一般檔案。檔案已移動、刪除或索引過期時會拒絕操作，請重新搜尋或重新索引。

「開啟檔案」只表示系統已接受啟動請求；外部應用程式若被公司政策或檔案關聯封鎖，Seekah 會顯示錯誤。Linux 目前不支援此操作；滑鼠移到路徑列可看到完整路徑，也可按「複製路徑」後自行開啟。

### 建立與複製上下文

1. 勾選結果左側 checkbox；「已選 N」會累積已選文件，跨頁和跨查詢仍保留。索引文件與臨時文件合計最多 20 份；同一 stable reference 不重複計數。
2. 按「檢查精確上下文」。對話框會重新向 server 驗證選取來源，顯示這次實際文字與 UTF-8 bytes；GUI 不顯示建立／修改時間等索引雜訊。
3. 按「複製預覽」後，內容只會寫入本機剪貼簿。選取或搜尋模式改變會使舊預覽失效，必須重新檢查。

工作台目前不提供聊天助手、Provider、model、API Key、AI question、送出或 answer 控制；這不影響 CLI／MCP 既有行為。

### 臨時文件、根目錄與垃圾桶

- 「臨時文件」接受任何格式，只保留本次工作階段且不寫入永久索引。支援格式可解析並加入上下文；不支援或解析失敗的項目仍有穩定 ID、可依檔名搜尋及移除，但因沒有正文不能加入上下文。臨時文件頁與已選上下文抽屜的名稱可選取，也提供「複製路徑」／「複製檔名」；若只有檔名資料，兩者都只複製目前顯示的檔名，不會暴露暫存內部路徑。
- 「根目錄」頁只顯示實際登錄根、文件數、完整性與錯誤摘要。上次同步錯誤超過 100 筆時，摘要會寫「共 N 筆，只列前 100 筆」；完整診斷請用命令列 `status --issues`。「加入資料夾」只開啟本機選擇器；選取後先顯示唯讀路徑，按「確認並建立索引」才呼叫索引。取消或未確認不會新增根。
- 「完整校正」會列舉已登錄根目錄並比較 metadata，只重新解析新增或變更文件。進行中可按「停止同步」；server 等索引 store 關閉後，根目錄移除才會重新啟用。
- 「重新檢查資料夾」會用本機 folder picker 選一個已登錄根目錄內的現有子資料夾，選定後立即只同步該子樹；根目錄列的「重新檢查此根目錄」則只同步該根目錄。選到未登錄、根目錄外、不存在或非目錄位置時，server 會拒絕，不會新增根目錄。
- 重新檢查完成後，狀態訊息會顯示「新增／更新／移除／略過」件數；進行中可按「停止同步」。若背景自動更新或其他 writer 正在使用索引，請等完成後重試，不要停止不屬於本工作台的程序。
- 工作台索引的列舉、解析與寫入在背景 worker 執行；即使單一大檔或慢格式仍在處理，狀態頁、搜尋與「停止同步」仍可回應。索引進行中畫面每 750 ms 只更新 `indexing`／`autoupdate` 輕量進度；首次載入、手動重新整理、設定／根目錄／垃圾桶操作完成與索引完成才讀取完整狀態。完整狀態仍只傳送錯誤預覽，不會把整份同步錯誤清單傳進瀏覽器。重新整理頁面不會停止這輪索引。
- CLI 等價操作是 `.\seekah.cmd index "資料夾路徑"`；當路徑已在已登錄根目錄內時，CLI 依既有 root plan 只同步該子樹。未登錄路徑在 CLI 仍可能代表加入新根目錄，請不要把它誤當成工作台的受限重新檢查。
- 索引進度另存於索引資料目錄的 `indexing.json`，只含狀態、計數、路徑與摘要，不含文件正文。若命令視窗或程序在索引中被關閉，重開工作台會顯示「上次索引程序已中斷」；這不是索引損壞，已提交的文件仍保留，再按「完整校正」會從已提交文件接續，未提交文件會重新檢查。
- 「完整校正」在同一輪可能先列舉／檢查，再進行解析或搜尋 postings 升級；這些是同一個索引請求的不同階段，不代表 UI 自己送出了第二次。只有按下按鈕或 API 明確送出才會開始新一輪。
- 勾選根目錄後按「移至垃圾桶」：預設顯示確認對話框，明確說明只移除索引、不刪來源。勾選「下次不再提醒」只在刪除成功後保存；設定可重新開啟提醒。
- 「垃圾桶」列出根路徑、文件數與 `deletedAt` metadata。可還原並重新索引，或在永久刪除確認後只刪 metadata；來源資料夾與檔案不會被刪除。
- 設定頁的刪除提醒、背景自動更新、登入 Windows 時自動啟動與總筆數模式使用 Toggle Switch；旁邊的「已開啟／已關閉」是目前狀態，送出期間會顯示「處理中…」並暫停操作。背景自動更新切換以 `POST /api/settings` 回應為準，不會等待慢速狀態重新整理才更新畫面；登入啟動只設定下次登入的 Windows 啟動捷徑，不代表目前背景 daemon 已啟動。工作台仍只在本機執行，背景更新以檔案事件做增量更新，預設每 6 小時完整校正；這不是只改畫面的假開關。
- 設定頁的「開機補捉」可選「詢問後補捉」、「自動補捉」或「不補捉」；既有索引預設為「自動補捉」。「詢問後補捉」只在明確按下「立即補捉」後處理離線期間的 downtime gap，「稍後提醒」保留待辦，「略過本次」只略過該次 gap，「關閉開機補捉」會保存「不補捉」並略過該次 gap。「不補捉」不處理離線 gap，但啟動後明確收到的檔案事件仍會更新；`C:\` 根目錄會提醒可能重新檢查大量檔案。設定保存或補捉失敗時，畫面會回復可操作狀態並保留錯誤訊息。
- 設定頁的「工作台開啟提醒策略」與「開機補捉」是兩個不同選項；前者預設為「開啟時提醒」，適用新建與既有索引，只在已有索引、至少一個根目錄、沒有索引工作且沒有背景或前景監看時評估。提醒會顯示上次成功同步時間與關閉期間可能遺漏的檔案，提供「開啟背景更新並補上遺漏」、「只做一次完整校正」、「稍後再說」、「不再提醒」四個動作；「詢問」與「不主動處理」不會因工作台開啟偷偷啟動 daemon。選擇自動補捉時，工作台才會以本次明確的 `startup-catchup auto` 啟動背景更新；若登錄 `C:\` 根目錄，提醒會說明可能重新檢查大量檔案並耗用磁碟與 CPU。索引進行中、狀態過期或請求失敗時，控制項會停用或保留可讀錯誤，不會把失敗當成已同步。

## 終端使用方式

不想開瀏覽器時，可直接搜尋：

```sh
node dist/src/cli.js search "合約"
node dist/src/cli.js search "付款 例外 規格" --all-terms
node dist/src/cli.js search "合約" --verbose
node dist/src/cli.js status
```

`status` 會顯示各根最近同步錯誤總數；超過 100 筆時標示「共 N 筆，只列前 100 筆」，預設不印出錯誤本文。要看完整文件問題與各根同步診斷，用 `status --issues`。

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
- 已有根目錄但懷疑 `fs.watch` 漏掉事件時，可在「索引根目錄」按「重新檢查資料夾」，選取已登錄根目錄內的子資料夾；不需要重新掃描其他 sibling。也可使用 `.\seekah.cmd index "資料夾路徑"`。

```powershell
.\seekah.cmd autoupdate start
.\seekah.cmd autoupdate status
.\seekah.cmd autoupdate stop
.\seekah.cmd autoupdate startup enable
.\seekah.cmd autoupdate startup status
.\seekah.cmd autoupdate startup disable
```
`.\seekah.cmd autoupdate start --startup-catchup ask|auto|off` 只套用這次背景 daemon 的開機補捉模式；工作台設定頁保存的三態選擇才是後續啟動的持久設定。`autoupdate status` 會在 live 狀態列出目前模式與 `none`／`pending`／`running`／`complete`／`skipped` 狀態。

`autoupdate start` 會先掛監看，再以可接續的背景批次做啟動校正，然後對檔案事件做局部更新；健康時單檔變更不必再跑完整 `index`。每批最多檢查 500 個 entries 或約 250 ms，批次之間會釋放 writer lock；事件優先，但至少每 5 秒保留一次校正機會。監看預設是根目錄非遞迴加上各直屬子資料夾的遞迴 watcher；句柄上限 128，超出時改為整根粗範圍。`.localdocsearchignore` 排除的直屬子資料夾（例如 `/AppData/`）不建立 watcher；被排除路徑的事件在入口就丟棄，不寫入工作佇列、不觸發更新。修改 `.localdocsearchignore` 後監看範圍會依新規則重建，並排一次整根校正。檔案持續變動時，最長約 15 秒（防抖 10 倍）一定會處理一次。每輪最多處理 500 筆；每檔各自等待防抖時間確認 metadata 穩定，前一檔進入解析／準備時下一檔可開始穩定等待；仍在寫入的檔案會延後到下一輪，連續 5 次仍在變動就先保留舊索引，等下次變動再處理。某個程式一次產生數千個檔案時，之後新建的檔案要等前面處理完，通常數十秒內可搜尋（依格式與電腦速度而定）。一直被改寫的檔案不會讓其他待辦永遠輪不到：每一輪先處理這一圈還沒處理過的待辦。資料夾本身的「修改」通知會忽略（裡面的檔案另有各自的通知）。新建或搬進來的資料夾會分批展開：每輪最多列出 2,000 個項目，檔案排在一般變更之後處理，所以搬進大型資料夾時，你之後新建的檔案仍能在數秒內搜尋；整個資料夾則需要較長時間才全部可搜尋。能定位到某一子範圍的未知事件只補掃該範圍。`index` 仍是立即完整校正：會枚舉整個根目錄並比對既有索引。`--profile` 請用目前這個 shell 已經展開的新檔案路徑（PowerShell 用 `$env:USERPROFILE\...`，CMD 用 `%USERPROFILE%\...`），報告含 enumerate／stat／parse／compress／bloom／write／commit，不含路徑或正文。
- 直接子目錄 watcher 若單獨 attach 或執行期失敗，只會將該子目錄列為降級並排入有界補掃／後續校正；健康的 sibling watcher 仍維持 split。只有句柄上限等整體資源不足才會退回 coarse。

局部積壓超過 500 筆時，每批會保留部分最新且穩定的事件，同時處理最舊待辦；因此 800 筆以上的穩定積壓中新檔通常至多再等一輪，舊待辦仍按輪替前進。剛延後的同一工作項會排在穩定待辦之後，但不會永久跳過。
完整校正只有在目前目錄及其子目錄都完成列舉、已檢查路徑已落盤且沒有讀取失敗或延後核對時，才會對該範圍清理已消失的索引列；中斷或失敗範圍會保留既有索引，來源文件不會被刪除。
當校正與事件同時待辦時，校正批次後下一輪會先處理事件待辦；持續事件期間校正仍約每 5 秒取得進度，兩者交錯，不會因單一類型待辦而永久餓死。
Windows 可選登入啟動必須明確執行 `autoupdate startup enable`；預設關閉，不安裝 Service、不要求管理員權限，也不會立即啟動第二個 daemon。`status` 顯示是否為 Seekah 擁有的 Startup 捷徑；`disable` 只移除 Seekah 自己建立的捷徑，遇到同名非產品檔案會拒絕。公司政策拒絕或非 Windows 平台會明確回報，手動 `autoupdate start` 仍可用。
`autoupdate status` 會顯示目前階段、最後事件、最後局部更新、最後／下次完整校正、事件／已排除事件／局部更新／根目錄掃描次數，以及工作佇列待辦與是否降級。「已排除事件」很大但 CPU 偏高時，通常是監看退回整根粗範圍（根目錄列顯示 `範圍=coarse`）；先確認直屬子資料夾數量，必要時 `autoupdate stop` 後重新 `start`。根目錄列出的校正世代、已檢查量、剩餘範圍、讀取失敗與延後核對是目前進度；總量未知時不顯示百分比。讀取失敗代表本輪確實無法讀取或核對，延後核對代表仍有待辦或尚未完成的範圍，兩者都不表示完整校正成功。工作台狀態頁不顯示監看健康度。已落盤的事件在程序重啟後會重播；尚未落盤就中斷的窗口由啟動校正補回。佇列滿 10,000 條不同路徑時會改存 dirty scope 再校正該範圍。工作狀態庫在索引旁的 `.work.sqlite`，不含正文，也不是跨庫原子交易。
- 不確定事件也會在 status 顯示：`空檔名` 是收到但無法定位檔名的事件數，`補掃` 是實際排入 watchDir 目錄展開的次數，`最近補掃` 是最後一次排入時間；同一 watchDir 會受冷卻、60 秒上限與有限退避抑制。根目錄仍保留完整校正安全網。`GET /api/index-status` 的 `autoupdate.live` 會保留同一批欄位；若某個子目錄降級，根目錄列會顯示路徑與原因。
- `uncertainRescanStateCount` 是目前每根／全部根目錄保留的 watchDir 冷卻狀態數；每根最多 1,024，child watcher 釋放／降級／移除或根目錄移除後會清除，供 status／API 診斷記憶體界線。
- `autoupdate status` 的每個根目錄若已有局部批次，會追加最近一次的事件→排程、穩定等待、列舉、取鎖與提交毫秒數；這些是診斷量測，不是固定完成時間承諾。搜尋 query 時間仍以搜尋 trace／量測記錄為準。
每次自動更新啟動時會清除 `.work.sqlite` 中不再登錄根目錄的事件、校正與已見範圍，並在日誌記錄清理筆數；移至垃圾桶、移除或合併子根時也會清理，還原根目錄後可照常接收新事件。


## 索引資料目錄與 WAL 附屬檔

Windows 預設索引在 `%LOCALAPPDATA%\LocalDocSearch\`（可用 `LOCALDOCSEARCH_DATA_DIR` 改到其他**本機**路徑）。0.43.0 起主索引使用 SQLite WAL，資料目錄除 `index.db` 外會出現 `index.db-wal`、`index.db-shm`（以及既有的 `.writer.sqlite`、`.work.sqlite`、journal 等）。這是正常現象，不是損壞。

- 命令列 `status` 會列出這些檔的大小，合計才是索引佔用（工作台的索引狀態目前不列出 `-wal`／`-shm`）。
- 備份或搬移索引：先讓 Seekah 全部關閉（含背景自動更新與工作台），再整組複製／移動，不要只複製 `index.db`。
- 不要手動刪 `-wal`、`-shm` 或 journal 來「修復」忙碌或容量。
- 索引必須放在本機磁碟。SQLite 官方文件指出 WAL 不能用在網路檔案系統（所有存取程序必須在同一台電腦上）。雲端同步軟體或防毒軟體若掃描、鎖住資料目錄內的檔案，可能造成短暫忙碌；遇到時請稍後重試，必要時請 IT 將資料目錄加入排除清單（這一點是建議，尚未在公司環境驗證）。

`INDEX_BUSY` 表示另一個本機程序正在使用索引，請稍後重試；搜尋通常仍可讀已提交內容。`INDEX_RECOVERY_REQUIRED` 表示有未完成交易，下一次 `index` 會由 SQLite 安全回復；請勿刪附屬檔。

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
| 工作台根目錄顯示「共 N 筆，只列前 100 筆」或完整狀態輪詢很慢 | 這是上次同步錯誤清單的預覽上限或冷讀取成本。畫面與 MCP `index_status` 只帶前 100 筆；索引進行中會改用輕量進度輪詢，完整清單用 `node dist/src/cli.js status --issues`。 |
| 索引卡在單一檔案且停止沒有立刻完成 | 某些 parser／檔案 IO 只能在安全點取消；停止最多等待約兩秒後終止背景 worker。下次完整校正會依已提交 SQLite 交易重新檢查未完成文件。 |
| 用 `.localdocsearchignore` 排除大量檔案後同步較久 | 掃描後會顯示「刪除校正」目前／總數，每 1,000 份提交一次。可按「停止同步」或 Ctrl+C，已刪部分會保留，下次同步接續刪除其餘。資料庫檔不會自動變小；先 `autoupdate stop`，再執行 `compact` 回收空白頁（顯示含 `-wal`／`-shm` 的合計大小），完成後 `autoupdate start`。 |
| 常見詞只顯示「500 筆以上」 | 這是預設的快速模式。要精確總數：工作台設定頁改為「精確」，或 CLI 加 `--exact-total`。 |
| 搜不到剛修改的檔案 | 到設定開啟背景自動更新（可查看健康摘要確認 phase 與待辦），開關成功後旁邊會立即顯示「已開啟」；若狀態讀取很慢，仍以設定 POST 回應為準。也可調整 debounce 參數，或按「完整校正」或執行一次 `index`。 |
| 背景自動更新顯示無法停止或要求被拒絕 | 先看設定頁健康摘要。若顯示「前景監看請在原終端按 Ctrl+C 結束」，代表是 CLI `watch` 的前景程序，必須回原終端停止；若是設定 API 失敗，開關會回復原值並在設定狀態區顯示錯誤，不會留下假狀態。 |
| 工作台搜尋不到剛修改的檔案 | 先到「索引根目錄」按「重新檢查資料夾」並選取該檔案所在、且已在登錄根目錄內的資料夾；完成後查看新增／更新／移除／略過計數。若選取位置不在已登錄根內，先回到「加入資料夾」建立新根，或改用 CLI 的既有 `index` 語意。 |
| 搜不到某個檔案或搜尋零結果 | 先用 `node dist/src/cli.js explain "完整檔案路徑"`；工作台空狀態輸入路徑；TUI 用 `/explain <路徑>`。若顯示被排除，查看命中的規則與祖先路徑，再依「找不到檔案時的排查」處理。 |
| 要移除已索引目錄 | 若正在同步，先按「停止同步」。再到「根目錄」勾選目錄、按「移除所選」或個別「移至垃圾桶」並確認。來源資料不會刪除。 |
| autoupdate status 顯示工作佇列降級 | 工作狀態無法落盤。先確認磁碟空間與索引目錄可寫，再 `autoupdate stop` 後重新 `start`。 |
| 啟動後工作佇列出現舊根目錄狀態 | `.work.sqlite` 會自動清理不再登錄根目錄的事件、校正與已見範圍，日誌會列出筆數；還原根目錄後可重新接收更新。 |
| 雙擊後出現「不是內部或外部命令」或「不是可執行的外部指令」 | 命令視窗找不到 Node.js。安裝 Node.js 22.17.0 以上並勾選 Add to PATH，關掉視窗後再雙擊。可先執行 `node -v` 確認。 |
| Codex 沒有 Seekah／搜不到文件 | 先建索引，再執行 `setup codex`，重開 Codex 後用 `/mcp` 核對 `localdocsearch`。複製預覽不會自動進 Codex。 |
| `setup codex` 說找不到 codex | 先安裝或更新 Codex CLI／Desktop，確認終端能執行 `codex`。 |
| 無法開啟檔案 | 確認檔案未移動、不是連結且有讀取權限；更新索引後再搜尋。 |
| 沒有 AI 送出功能 | 工作台只複製到剪貼簿。要給 Codex 用 MCP：`setup codex` 後請它搜尋並選定文件代碼。 |
| 關閉工作台後臨時文件消失 | 這是預期行為：臨時文件只保留在本次程序。 |
| 搜尋正常但看到 `database is locked` | 這是 0.42.0 及更早、rollback journal 加零等待時的症狀：搜尋仍 200，背景更新寫入失敗並把 SQLite 原文寫進健康摘要。0.43.0 改為固定「INDEX_BUSY：索引目前由另一個程序使用，請稍後重試。」WAL 下讀不擋寫，此訊息應少見；仍可能在兩個寫入者互斥、checkpoint 邊界或 1500 ms 寫入等待用盡時出現。請稍後重試，不要刪 `-wal`／`-shm`。 |
| 看到 INDEX_RECOVERY_REQUIRED | 索引有未完成交易。執行一次 `index` 讓 SQLite 回復。不要刪 journal、`-wal` 或 `-shm`。 |

## 隱私與邊界

- 文件索引、搜尋、片段預覽、臨時解析與複製都在本機。索引資料目錄須在本機磁碟，不要放網路磁碟。
- 工作台不傳送文件、問題或 API Key 到外部 AI Provider。
- Seekah 不開放 LAN，不讀取瀏覽器 cookie；開啟工作台不會自動完整掃描既有根目錄。「完整校正」只同步已登錄根；先按「加入資料夾」、再按「確認並建立索引」才登錄新路徑。臨時文件仍只留在本次工作階段。
- 公司 Windows 與 Linux 外部開檔的正式驗收仍未完成；請先依公司政策用非機密測試資料驗證。
