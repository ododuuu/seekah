# 專案狀態

最後更新：2026-09-28（package 0.39.0：區段儲存、不記位置索引與提前停止）

## 目前狀態

- **2026-09-28 0.39.0**：依 SPEC §52／D083 完成。
  - 儲存：約 64K 字元的 zstd 區段＋偏移表，只存無法推算的段落位置；內容索引為區段級不記位置 trigram 與 1／2 字 token。
  - 搜尋：依排序延遲驗證、夠用即停；結果內搜尋為過濾層；總筆數預設快速（500 份後回報下限），工作台設定／`--exact-total`／`exactTotal` 可改精確。
  - 遷移：0.38 與更早的 index 由寫入程序遷移，完成後刪除舊結構並自動壓縮；新增 `compact`。
  - 測試：新增 m42，m40 改為區段引擎差分；`npm test` 326 項，321 通過、3 略過，M26 path coverage、M36 profile chmod 兩項既有 win32 環境失敗仍在。
  - 真實資料複本：4.09 GB → 132.8 MiB，遷移（含自動壓縮）434 s；73 個查詢遷移前後完全相同（224,224 筆）；快速第 1 頁 p50 398 ms、精確 p50 935 ms；稀有詞第一頁比 0.38 慢。見 `0.39.0-VALIDATION.md`。
  - 發現既有問題：背景自動更新處理被排除資料夾的全部事件並持續占用 CPU，列入 NEXT-TODO。
  - 本機 win32 證據，不是公司 Windows 驗收。

- **2026-09-28 索引大小研究（研究，未改 `src/`、未改產品行為）**：0.38.0 在真實 index 上約為文字量的 6 倍（172.7 MiB 文字、約 1,040 MiB 索引），主因是一行一列。在同一份快照上實測直接掃描、區段 trigram（64K／16K）、sparse grams、Tantivy，並讀完 Succinct 與 Ferragina 等人的壓縮索引實測論文。建議「64K 區段不記位置 trigram＋zstd 原文＋依排序走訪、找滿第一頁即停」：內容部分 83.6 MiB（0.48 倍），225 查詢全部正確，第一頁 2–18 ms、計數到 10,000 筆 23–319 ms。總筆數語意（超過 10,000 筆）與索引引擎（SQLite FTS5／Tantivy）待使用者決定，尚未寫入 SPEC。見 `research/index-size-2026-09-28/RESULTS.md`。本機 win32 證據，不是公司 Windows 驗收。

- **2026-09-28 0.38.1**：依 SPEC §51／D082 完成。
  - 起因：真實 index 排除 `AppData` 後，刪除校正移除 175,324 份文件，單一交易約兩小時。根因是 `index_migration_documents` 缺少 `document_id` 索引，CASCADE 每份全表掃描約 24 萬筆 marker（35.9 ms／份，補索引後 0.1 ms）。
  - 範圍：外鍵子表索引與 schema 自動檢查；遷移完成即清除 marker；`removeMissing` 每 1,000 份分批提交、可取消、有進度。
  - 測試：新增 m41（外鍵索引檢查、marker 生命週期、分批刪除與取消接續、sync 刪除進度）；`npm test` 319 項，314 通過、3 略過，M26 path coverage、M36 profile chmod 兩項既有 win32 環境失敗仍在。
  - 真實 store 複本（240,237 份）刪除 2,000 份：0.38.0 72 ms／份；0.38.1 在含 31.7 萬 block 的一批為 12 ms／份，metadata-only 批次 0.73 ms／份（含掃描）。見 `0.38.1-VALIDATION.md`。
  - 另案：遷移遇到鎖直接失敗（`database is locked`），不在本版。
  - 本機 win32 證據，不是公司 Windows 驗收。

- **2026-09-27 0.38.0**：依 SPEC §50／D081 實作 C2-hybrid 搜尋後端。
  - 索引：content 用 block 級 trigram `detail=full`（`case_sensitive 1`）phrase 加 unigram／bigram token；檔名與 heading 各自建表。排序前不讀正文，payload 只供當頁 snippet／passages。
  - 遷移：舊 index 由 writer 逐批遷移（`block_index_1`，可取消接續），完成後刪除 Bloom 與文件級 postings；唯讀 CLI／MCP 在遷移前走舊路徑。
  - 修正：含 U+0000 查詢的 `unterminated string` 錯誤。
  - 實作期發現：預設 trigram tokenizer 會把 final sigma 折疊而多出命中，已改為 `case_sensitive 1`，並寫入 D081。
  - 測試：新增 m40（新舊路徑差分等價、刪除清理與 id 重用、U+0000、長壽 writer 在他處完成遷移後繼續寫入）；`npm test` 結果見 `0.38.0-VALIDATION.md`（M26 path coverage、M36 profile chmod 兩項既有 win32 環境失敗仍在）。
  - 真實 235,463 文件 store 複本：遷移後 10 個 benchmark 查詢的結果 hash 全與 0.37 產品相同，排序階段 payload 讀取為 0；延遲與大小見 `benchmark-block-index-2026-09-27.json`。
  - 本機 win32 證據，不是公司 Windows 驗收。

- **目前 package 仍為 0.36.2；0.37.0 已開工。** CURRENT 進行中版本為 0.37.0。索引／autoupdate 階段 1–7 已完成；desktop workbench 已依 SPEC §47.9／D074 完成 clean cutover。公司 Windows 真實資料與大型庫 profile 尚未完成。
- 2026-09-27 搜尋架構 prototype（研究，未改 `src/`、未改產品行為）：依 `PROTOTYPE-HANDOFF.md`，在真實 235,463 文件 store 的唯讀 snapshot 上建置並比較 A（現況）／B（payload 級 postings）／C1（block 級 FTS5 `detail=none`）／C2（block 級 `detail=full`）／D（fts5vocab 最稀有 trigram）。2,000 查詢差分測試對暴力 ground truth：B／C1／C2／D 的結果、排序與 snippet 全部相同；A 有 1 個含 NUL 查詢的既有錯誤（`unterminated string`，未修）。本機 p50：`SPEC.md` A 12.8 s → C2 4 ms，`測試` 5.2 s → 2 ms，`ing` 39.5 s → 0.86 s。C2 store 估計 3.33 GiB（現況 1.37 GiB）；建議進 ADR 的 C2-hybrid（trigram `full`＋C1 unigram／bigram token）約 2.9 GiB。A 的成本斜率實測約 42 ms／MB（非 20）。kill／resume 與 delete／reinsert 等價已驗證。結果與待辦見 `research/search-architecture-2026-09-27/PROTOTYPE-RESULTS.md`，程式在 `scripts/prototype-search/`。ADR 尚未撰寫、未核准；不是公司 Windows 驗收。
- 2026-09-27：僅補搜尋診斷，不重構／新增索引。實際 235,463 文件完成 `測試`、`SPEC.md`、稀有詞、不存在詞 profiling；總耗時 5.602／14.511／0.637／0.042 秒（同連線、未清 cache，不作優化成果）。`SPEC.md` 4,638 payload 僅多展開 31、duplicate=0；lookup 6.894 秒主要為 1,652,374 metadata rows（3.931 秒）與 1,442,468 mapping rows（1.501 秒）。新增 SQL／bytes／unique／duplicate／ranking-snippet／exact text 診斷，既有 inclusive／self 保留；m38／m39 11 項通過。原始 JSON 與 SQL plans 見 `search-payload-profile-2026-09-27.json`、分析見 `0.37.0-VALIDATION.md`；已更新使用手冊及 D080。沒有實作任何優化，公司 Windows 人工驗收仍未回報。
- 2026-09-27 metadata／mapping overfetch optimization 已依 `docs/metadata-mapping-overfetch-optimization-spec.md` 完成：filtered path 以兩條 statement-local selected CTE 取必要 metadata／完整 owning-block payload closure，Q2 固定使用既有 `document_payload_blocks_document_block`；未新增 index、schema、temp table、cache 或 package version。新增 `candidatePayloadOrdinals`、`owningBlocksFound`、`blockExpansionInputPayloads`，m23 sparse／empty-map／cross-payload 與 m39 diagnostics 回歸通過。256-block fixture ranking metadata 256→2、first-page 256→4，SPEC.md ranking 1,652,374→1,442,468、standalone mapping 1,442,468→0，payload rows 4,638 不變。第二組完整 3 warmup＋10 measurement 同 snapshot 配對報告見 `metadata-mapping-optimization-2026-09-27-*.json`；SPEC.md completed payloadLookup p50 6,471.265→5,202.542 ms（0.804×），外側 wall p50 13,766.514→12,236.205 ms（0.889×），測試 wall p50 0.951×、稀有 query 0.943×、不存在詞 1.003×，p50／p95 gates 均通過，結果 hash 相同。這是本機 win32／Node.js 22.23.2 證據，不是公司 Windows 人工驗收。
- 2026-09-26：desktop workbench 固定為 1180px 以上的 desktop shell；1440×900、1920×1080、1180×800 Chromium 驗收均無水平溢出，sidebar 為 246px（最小寬度 220px），不提供 mobile bottom nav 或永久第三欄。
- 2026-09-26：正式工作台已改用真實 `/api/state`、`/api/index-status`、`/api/search`、`/api/files`、`/api/index`、`/api/trash`、`/api/document-action`、`/api/preview`；搜尋、list/table、stable reference detail、臨時文件、根目錄、垃圾桶、設定與 context drawer 均走實際資料，不保留 fake rows。
- 2026-09-26：GUI 不提供 Provider、model、API Key、AI 問題、送出或回答；context preview 只顯示重新驗證後的選取片段，來源文字以 text node 呈現。CSP、loopback Host／Origin／token、stable reference action、無 storage／cookie／外部資源已由契約測試與 Chromium smoke 覆蓋。
- 2026-09-26：Chromium axe-core 4.13.0 初始頁、context drawer、preview dialog 均為 0 violations；console/page errors 為空。瀏覽器剪貼簿權限被測試環境拒絕時，UI 保留可見預覽並顯示手動複製提示。
- 2026-09-26：依核准 `paperless-inspired.html` 再做視覺微調：固定 viewport shell 與內部捲動、圓形品牌記號、soft active sidebar／count pills、同列 sticky 搜尋篩選列、Paperless-style 文件縮圖／橫向 metadata／選取框線／批次列，以及 edge-to-edge detail 與灰底 paper preview。真實 API、stable reference、CSP 與 context 安全契約未改。
- 2026-09-26：依使用者圖片重新逐像素對齊 demo，而不是只對齊大框架。正式 sidebar 導覽按鈕已移除共用 `.btn` 注入造成的逐列框線；一般列、hover、active row、count pill、群組色彩、38.3px 列高與 footer 狀態結構均改為 demo 規則。文件頁預設 Table、309×36px 查詢框、filter chip、單一中文搜尋模式 chip、結果列、分頁、六欄表格與 sticky 選取列也依 demo 重做，資料仍來自真實 API。1440×900 實測 topbar 58px、sidebar 246px、main 1194px、query x=272/y=170.984375，與 demo 相同；所有 sidebar 導覽 border-width 為 0，文件頁 axe 0 violations。
- 2026-09-26：新增 SQLite FTS5 `search_unigrams`／`search_trigrams` postings。候選先由 postings 取，既有 exact／phrase／all-terms／檔名／snippet／stable reference 與 64 KiB payload 邊界保留；upsert／remove 清理 postings。`m38` 3 項、`m20`／`m23`／`m24` 10 項與 workbench `m35`／`m37` 16 項 focused tests 通過；Chromium 1440×900 已實際驗證 202→背景 upgrade→自動重送；`npm run benchmark:ngram` 與最終 `npm test` 已完成，完整結果見 `docs/0.37.0-VALIDATION.md`。
- 2026-09-26：新增 SPEC §49／D077-D078 搜尋與 answer Diagnostics／Performance Trace。搜尋與 answer trace 記錄總耗時、bottleneck、postings／restricted／Bloom／payload／exact／ranking／snippet 或 context／preview／provider／fallback／response parsing phase、counts 與結果數；`SearchResultSet`／`SearchSession`／`IndexStore.lastSearchTrace()`、MCP／Workbench response、`WorkbenchHandle.lastAnswerTrace()`、CLI `search --verbose` 與獨立 Workbench `/traces` UI 均可見。完成事件追加到索引資料目錄 `trace.log` JSONL（2 MiB × 5 輪替），不寫 SQLite／profile；新增 m39 7 項 logger/API/UI/search 行為測試、m35 answer／empty-search trace 測試。focused 14 項通過；完整 `npm test` 306 項：301 通過、2 個既有 win32 環境失敗、3 略過。
- 2026-09-26：依使用者真實 trace 完成搜尋診斷可觀測性修正（不改搜尋架構、不新增 index）。確認 FTS5 postings 只回 document ID；payload ordinal 由 payload Bloom／block mapping 獨立處理。search trace schema 升為 3，新增 inclusive／self phase、self／inclusive bottleneck、payload read pass、posting payload hit、block expansion、full-document／filename-only fallback metrics。`測試` 的 109 個 exact 文件走 107 次 full fallback、2 個 filename-only，2,601 payload；20 筆 page materialization 後讀取 2,619、125 passes。`SPEC.md` 的 144 個候選中 38 個 filename-only，106 次 payload pass，4,638 payload、31 個 block expansion，`payloadLookup` 仍是主要 self phase。新增 m38／m39 回歸覆蓋 payload ordinal expansion、`payloadsRead` 分離與 nested timing；公司 Windows 大型庫仍未驗證。
- 2026-09-26：修正使用者回報的索引 85%／86.86%／99.52% 假死鏈路（D079）。Workbench 索引改由 worker thread 執行，主 HTTP 可持續回報狀態／停止／搜尋；`indexing.json` 原子保存進度與目前檔名，重開程序會標示前次中斷並保留已提交文件。UI 每 750 ms 輪詢，暫時 busy／locked 不清空最後進度；本機 Chromium 1,200 份合成檔 smoke 已驗證重整後仍顯示 876／1200 與目前檔名，API 最終 `complete`，page errors 0。`m35`／`m37` 聚焦 18 項通過；公司 Windows 大型格式與 30 萬檔 profile 仍未驗證。
- 本批後 `npm test`：310 項，305 通過、M26 `path coverage` 與 M36 `profile chmod` 兩項既有 win32 環境失敗、3 略過；本批 m23／m38／m39 與 Workbench／索引狀態回歸通過。不能把完整套件宣稱為零失敗。
- 2026-09-25 階段 5：新增 `autoupdate startup enable|disable|status`。Windows 目前使用者 Startup `.lnk` 由普通帳號建立，固定目前 Node／編譯 CLI 並以 `--data-dir` 綁定索引；預設關閉、不啟動第二 daemon、不裝 Service。產品 marker 保護擁有權；同名非產品檔案、政策拒絕、路徑搬移與非 Windows 平台明確回報。
- 2026-09-25 階段 6：all-terms 文件候選改為所有不在檔名中的必要長詞 Bloom 都必須可能存在；混合長短詞、短詞跨 payload、缺 Bloom 仍完整精確核對，避免 false negative。新增 3 項階段 5／6 聚焦測試，既有 M16／M23／M25 回歸通過。
- 2026-09-25 階段 4：daemon 啟動／週期校正改用 `${index}.work.sqlite` 的 generation、directory frontier、已檢查量與失敗 scope；每批最多 500 entries 或約 250 ms，批次間釋放 writer lock，事件優先且至少每 5 秒讓一批校正執行。成功列舉且沒有較新事件的 scope 才移除缺失文件；中斷後重列目錄並依 generation 去重。新增 `m37-reconcile` 5 項，含重啟接續、lock 釋放、事件交錯、失敗保留與 daemon 整合。
- 2026-09-25 階段 3：根目錄非遞迴 watcher 加各直屬子目錄遞迴 watcher；句柄上限 128，超出或分割失敗改 coarse。新目錄先 attach 再補掃；子範圍未知事件只校正該子樹；無法定位的 filename 仍整根校正。連結／junction 不另開句柄。`autoupdate status` 顯示範圍與句柄數。
- 2026-09-25 階段 2：索引旁獨立 `${index}.work.sqlite` 工作狀態庫（schema_version=1），與單例 `.live.sqlite` lease 分開。事件落盤後才接受；索引提交後依世代 ack；重啟標記 downtime gap；超過 10,000 條路徑先存 dirty scope。落盤失敗時 status 降級。兩庫沒有跨庫原子交易，重播為至少一次。聚焦 queue／autoupdate／m11／smoke 43 項通過。
- 2026-09-25 階段 1：檔案事件經 debounce 與兩次相同 metadata 觀察後走 `applyFileUpdate`／`applyPathChange`，不呼叫根目錄 `scan()`。`autoupdate status` 顯示事件／局部更新／根目錄掃描次數、最後事件、最後局部更新、上次／下次完整校正。未知 filename 仍整根校正。`--profile` 新增 `enumerate` 階段；本機合成資料三次量測。USER-GUIDE／CLI help 把 `autoupdate start` 定義為日常路徑、`index` 為立即完整校正。聚焦 autoupdate／m11／m37-autoupdate／smoke 34 項通過。公司 30 萬檔 profile 與真實 Windows 事件延遲尚未取得。
- **0.36.2 GUI 為歷史 baseline；已由 0.37.0 的 D074 desktop clean cutover 取代。** 舊版曾完成三區版面、搜尋分頁／跨查詢選取、臨時文件、狀態讀取與精確預覽；目前正式工作台已移除舊永久第三欄、mobile 路由、fake rows 與 GUI AI controls。
- 2026-09-25 階段 7：已有索引時，索引狀態頁提供「選擇資料夾」與「確認並建立索引」兩步按鈕。重用本機資料夾選擇器、`POST /api/index`、`validateRoot` 與 `sync()`；選取後只顯示唯讀路徑，確認後才開始索引；忙碌時回 409「索引進行中，請完成後再加入。」，不再默默重用同一輪 `indexingTask`。開啟工作台仍只同步已登錄根；臨時文件不入永久索引。
- 2026-09-26：工作台新增已索引根目錄勾選、全選、確認刪除、刪除提醒偏好與垃圾桶。刪除只移除索引並保留來源資料；垃圾桶可重新索引還原或永久移除 metadata。
- 2026-09-26 使用者補充：選完資料夾必須再按確認才開始索引；已同步更新工作台兩步操作、測試與文件。
- 2026-09-25 文件對齊：`docs/handoff/README.md`、`CURRENT.md`、`NEXT-TODO.md`、SPEC 開頭、`ROADMAP.md`、`AGENTS.md`、`HANDOFF.md` 入口均指向「0.36.2 已完成、0.37.0 進行中、沒有 0.38.0」。本次新增 desktop clean cutover 的現況與限制；公司 Windows 人工驗收仍未回報。
- `/api/document-action` 僅接受搜尋結果的 stable reference 與 `open|reveal`，重用 `actOnDocument` 的 root／連結／一般檔案／可讀性驗證；瀏覽器不提交任意 path。GUI 搜尋列、上下文與狀態頁不顯示 ISO 時間，GUI context 產物亦省略建立／修改時間。
- `/api/index-status` 只讀既有 store／indexStatus；`POST /api/index` 才在背景重用既有 `sync()` 同步使用者已登錄或明確輸入的根目錄。兩者不建立第二套 parser、資料目錄或 schema；0.37.0 階段 4 的背景校正另走可接續工作狀態，不改 GUI 的加入根目錄邊界。階段 5 登入啟動只由 CLI opt-in，不由 GUI 或一般 start 順帶註冊。
- Scanner 現在回報最小 `protectedScopes`。`removeMissing()` 只保留位於失敗 scope 的舊文件；正常 sibling 的已刪文件仍移除。root `readdir` 失敗保護整根，rebuild 也不會先清掉失敗 subtree；同步摘要顯示受掃描失敗保護的數量。
- `$RECYCLE.BIN` 與 `System Volume Information` 改用唯一的 Windows path 判定，僅排除 drive／UNC share root 的精確直接子目錄及其後代，case-insensitive。完整掃描、watch 與局部更新共用；相似名稱、一般子目錄內同名路徑及非 Windows 路徑不排除。
- `--profile` 仍以 exclusive create 拒絕覆寫，也不建立父目錄。失敗診斷顯示 resolved parent、錯誤碼、CMD `%USERPROFILE%` 與 PowerShell `$env:USERPROFILE` 範例；疑似傳入另一 shell 的字面變數只提示，不自動展開。失敗發生在索引寫入前。
- TUI 已依 SPEC §45.8／D063 改為 Claude Code 式單欄 transcript：本次 session 只在記憶體保留最多 12 筆真正完成的 prompt／search／selection／context，結果 cards 與 preview／selected／context／help／roots／status 共用固定 composer。三行結果、`›` active、`[x]` selected、context 精確 bytes 與逐字 `yes` 保留；raw decoder、reducer、slash commands、open／reveal、訊號及 terminal cleanup 未改。
- 本機 Node.js v26.7.0／Darwin 27.0.0：完整 `npm test` 256 項、254 通過、0 失敗、2 項 Windows CMD launcher 略過。聚焦 m32／m33／m36 22 項全通過。80×24 PTY 已走完搜尋、選取、preview、context `yes` 複製、q 退出與 `NO_COLOR`；公司 Windows／Windows Terminal 未驗收。
- 使用者已在公司 Windows 實測 0.36.0：舊索引沿用；一次性 `文字解析升級=60014` 完成後第二次為 0；約 299,530 份未變更文件會直接略過。0.36.1 不更改此 parser selection，也不處理固定 parser errors。
- 普通 `index D:/` 仍是完整 reconciliation，約 30 萬檔的 2～4 分鐘枚舉成本不屬 0.36.1。0.37.0 已完成日常 `autoupdate` 的局部事件、持久 queue、有界 scopes、可接續校正、登入啟動與 mixed all-terms pruning。不使用 USN、不要求管理員權限。
- 本批 workbench 驗證：`npm run build` 通過；`dist/test/m35.test.js` 與 `dist/test/m37.test.js` 共 14 項通過。正式 Chromium smoke 已覆蓋 1440×900、1920×1080、1180×800、搜尋 25／頁 20、list/table、選取／預覽失效、臨時文件 indexed、根目錄資料夾選擇去重、刪除／垃圾桶／還原；axe 0 violations。完整 `npm test` 在本 Windows 環境有 M26 path coverage 與 0.36 profile 兩項失敗，詳見交付報告；不能宣稱全套通過。公司 Windows 真實資料、Node.js 22.17.0 實機與大型庫 profile 尚未驗收。
- GitHub 儲存庫已於 2026-09-24 由 `ododuuu/quiet-index` 改名為 [`ododuuu/seekah`](https://github.com/ododuuu/seekah)，本機 `origin` 已改指向新網址；這不改動 LocalDocSearch 相容資料目錄、環境變數、IPC／MCP 識別或 CLI 行為。
- GUI 已修正上下文面板 ×：桌面與窄螢幕都能關閉，右上「已選 N」可重新開啟。工作台開啟時背景同步已登錄根目錄；狀態頁「更新索引」會重用 `sync()` 取得新增／修改／刪除，尚無索引時要求使用者明確輸入第一個根目錄。
- GUI 精確上下文現在只供本機複製，已不顯示 Provider、model、API Key、問題、外傳同意或 AI 回答。新增 `seekah-ui.cmd` 與 `seekah-ui.command` 直接開啟圖形工作台；首次 `npm ci` 後不必每次重跑。

## 已交付基線與歷史紀錄

- 目前版本：**0.35.0 本機拖曳工作台與可選 AI API**，規格見 SPEC §43、D052；本機實作完成。`docsearch ui` 只綁 `127.0.0.1`，整合既有索引搜尋、人工勾選、拖曳臨時文件、256 KiB 精確預覽／複製，以及經 HMAC preview 與明確同意後的 OpenAI／xAI Responses API 選配。
- 拖曳原檔在權限受限暫存目錄解析後立即刪除；正文與 UI 輸入的 Key 只留在目前程序記憶體。API endpoint 固定，不提供任意 proxy、cookie 擷取或消費訂閱代登入。ChatGPT 與 OpenAI API、Grok 與 xAI API 分別計費。
- 0.35.0 本機 Node.js 22.13.1 完整 `npm test` 共 233 項：232 通過、0 失敗、1 項 Windows cmd 專屬略過；正式最低仍為 22.17.0。真實 Provider 未呼叫，公司 Windows 尚未驗收；驗證見 `docs/0.35.0-VALIDATION.md`，剩餘優化見 `docs/NEXT-TODO.md`。
- 交付包逐檔核對 258 個檔案：`LocalDocSearch-0.35.0.zip`，SHA-256 `a7be696053bcdd1473decacb061099a94d93fe9ea8b1722b624a394b96aaff53`。
- 目前版本：**0.34.0 MCP App 搜尋工作台與本機接入**，規格見 SPEC §42、D051；本機實作完成。相容 Host 可透過標準 MCP App 搜尋、跨頁勾選、更新模型上下文與明確送出問題；另有安全冪等的 Codex 註冊及唯讀 doctor。不支援 UI 時維持四個 headless 工具與 TUI 備援。
- 0.34.0 本機 Node.js 22.13.1 完整 `npm test` 共 228 項：227 通過、0 失敗、1 項 Windows cmd 專屬略過；正式最低仍為 22.17.0，公司 Windows 與真實 MCP Apps Host 尚未驗收。驗證見 `docs/0.34.0-VALIDATION.md`。
- 交付包逐檔核對 246 個檔案：`LocalDocSearch-0.34.0.zip`，SHA-256 `779cf31e00ce3c1513131c3d72fa2c7326e2fd3d83e6d2a2c6a760f5e1df8c6e`。
- 目前版本：**0.33.0 本機 MCP 與人選上下文閉環**，規格見 SPEC §41、D050；本機實作完成。唯讀 stdio MCP 提供 `search_documents`／`prepare_context`／`index_status`，TUI 提供選取籃、預覽與確認複製；不含 MCP 寫入工具、遠端 HTTP、整庫自動匯入或 Host 專屬滑鼠 UI。
- 0.33.0 本機 Node.js 22.13.1 完整 `npm test` 共 222 項：221 通過、0 失敗、1 項 Windows cmd 專屬略過；正式最低仍為 22.17.0，不得把此結果宣稱為公司 Windows 通過。驗證見 `docs/0.33.0-VALIDATION.md`。
- 交付包逐檔核對 239 個檔案：`LocalDocSearch-0.33.0.zip`，SHA-256 `adb5a8485cc2aa083b86955ca5caf05a67ce98e5d252ce739a4f09af20882b57`。
- 目前版本：**0.32.0 XLSM／ODT／RTF／CSV 正文解析＋終端互動介面**，規格見 SPEC §40、D048、D049；本機實作完成。從 0.31.0 起以版本號作唯一里程碑名稱，不再新增 M 編號。
- `.xlsm` 共用安全 OOXML 儲存格解析；`.odt` 擷取 `content.xml` 可見文字；`.rtf` 與 MSG 共用受限核心；`.csv` 支援 RFC 4180 相容 quoting、quoted newline、BOM／UTF-8／Big5。禁止執行巨集、公式、物件或外部資源；舊 unsupported 下一次普通 index／背景完整校正會重試。
- `docsearch tui` 已提供純 Node 全螢幕終端介面，整合搜尋、全部詞、翻頁、結果內縮小、open／reveal、status 與 roots。它不開網路連接埠；context 與 autoupdate 管理仍使用既有 CLI。
- 需要公司真實檔案才能定位的 PDF／PPTX／XLS 問題已集中至 `docs/COMPANY-WINDOWS-DIAGNOSTICS.md`，由公司 Windows 電腦上的 Codex 處理；不得上傳公司文件。
- 已提供 `autoupdate start|status|stop`、可驗證本機單例、事件佇列與精確檔案／子樹更新、預設 6 小時完整增量校正、動態 roots、降級復原、安全停止及有界日誌。本版不做開機／登入自啟，不安裝 Windows Service，0.30.0 索引可直接使用。
- 編碼政策已鎖定：明確 BOM／XML 宣告優先；無訊號時整份嚴格 UTF-8，失敗才整份嚴格 Big5。精度優先，不加統計猜測或要求使用者指定目錄編碼。
- 產品 package **0.32.0**。本機 Node.js 22.13.1（低於正式最低 22.17.0）建置及 0.32.0 聚焦測試通過；完整 218 項為 217 通過、0 失敗、1 項 Windows cmd 專屬測試略過。另修正 macOS `/var` 與 `/private/var` 根目錄別名通過安全驗證後，open／reveal 應保留使用者登錄路徑。交付包逐檔核對 232 個檔案：`LocalDocSearch-0.32.0.zip`，SHA-256 `6e2665d0a624ff33f6dd567a4e3a76f5ecca84bdd8898f66e7ed4e52f3ca77f3`；不得把本機結果宣稱為公司 Windows 通過。
- 前景 `watch` 已改用局部更新引擎；檔案事件不再每個都全根 `sync()`。search／status 不會暗中啟動背景程序。
- Linux 開發沙盒完整 `npm test`：213 項中 210 通過、1 失敗、2 略過。新增 16 項 0.31.0。失敗項為既有 M7 開啟在非 darwin／win32 回報 `ACTION_PLATFORM_UNSUPPORTED`。略過項為 M5 無法讀取目錄（root）及 Windows cmd 專屬測試。不得把此沙盒結果宣稱為 macOS 全套通過或 Windows 驗收。
- 0.30.0 原始碼、Big5 與索引觀測 **已完成實作**。下列 0.30.0／0.29.1 為歷史紀錄。
- 2026-09-22 Linux 開發沙盒 `npm test`：197 項中 194 通過、1 失敗、2 略過。新增 16 項 M27。失敗項為既有 M7 開啟在非 darwin／win32 回報 `ACTION_PLATFORM_UNSUPPORTED`。略過項為 M5 無法讀取目錄（root）及 Windows cmd 專屬測試。不得把此沙盒結果宣稱為 macOS 全套通過或 Windows 驗收。交付包逐檔核對 200 個檔案：`LocalDocSearch-M27-0.30.0.zip`，SHA-256 `4390a048913f76dec7a3b0ebc8bb199e85b8e6b595961af863c7b5bd48df822e`。
- 合成效能（Node.js v22.23.2，160 份 java／sql／js，重測中位數，見 `benchmark-m27.json`）：嚴格 UTF-8 解碼 0.20 ms、UTF-8 失敗後 Big5 0.33 ms；完整索引約 195 ms（兩種編碼相近，成本在寫入而非解碼）；無變更約 12 ms；錯誤重試約 10 ms。索引約 516 KiB。不得外推為固定加倍或零成本，也不得用此小樣本代表 378 GB 公司庫。
- 使用者已回報 0.29.1 公司 Windows 人工執行成功，D 槽合併既有子根 2 個並保留 107,414 文件；找到 358,102 份一般檔案、更新 256,564、未變更 101,526、移除 0；新增 250,688、重新處理 5,876、解析器呼叫 12,161 次。
- 0.29.1 該次處理狀態：indexed 11,534、no_text 561、unsupported 244,403、too_large 0、encrypted 0、error 66；掃描／讀取錯誤 13，同步完整為否，未確認的舊資料被保留。這些是該次處理量，不是全庫累計狀態；不將人工成功擴張為所有格式或全套自動測試通過。
- 同步耗時 8,455,609.94 ms（約 2 小時 21 分），使用者表示電腦仍順暢且耗時可接受。來源規模約 378 GB；容量以使用者後續回報的 1113.18 MiB 為準，暫無立即瘦身需求。來源 GB 並非實際解析 bytes，不能作文字壓縮率。
- XML、PPTX、PDF 的具體失敗根因尚未取得完整錯誤碼；XML 明確宣告失敗不回退 Big5。0.30.0 升級後請比較 XML 錯誤碼分布，不得直接推定所有 XML error 都是 Big5。
- 2026-09-22 Linux 開發沙盒完整 `npm test` 見上方 197 項結果。下列 0.29.1 為歷史紀錄。
- 2026-09-22 Linux 開發沙盒 `npm test`：181 項中 178 通過、1 失敗、2 略過。失敗項為既有 M7 開啟在非 darwin／win32 回報 `ACTION_PLATFORM_UNSUPPORTED`。略過項為 M5 無法讀取目錄及 Windows cmd 專屬測試。不得把此沙盒結果宣稱為 macOS 全套通過或 Windows 驗收。交付包逐檔核對 193 個檔案：`LocalDocSearch-M26-0.29.1.zip`，SHA-256 `add7f3a02441e321fe67ed726c6bd9c9ac989b722d18651bc2b0432433625736`。

- 搜尋會回報完整命中總數、頁碼及本頁範圍。TTY 預設每頁 20 筆，接受 n／p 翻頁、`/ 關鍵字` 縮小、back／reset 與 q；非互動使用 `--page`／`--page-size` 並顯示下一頁提示。`--limit` 保留為互斥的單次輸出。命中排序只建立一次，每頁才回讀片段；工作階段期間若 SQLite `data_version` 改變則回報 `SEARCH_INDEX_CHANGED`。
- `.xml` 逐行保存原文，包含標籤、屬性和值；支援 UTF-8、UTF-16 BOM／起始位元組與 TextDecoder 可辨識的 declaration 編碼，不解析 DTD／entity。舊 unsupported XML 執行一次普通 index 即重試，不需 rebuild。
- 0.27.0 在 macOS／Node.js 26.7.0 完整逐檔回歸為 155 項：154 通過、0 失敗、0 取消、1 Windows CMD 專屬略過（17.13 秒）。新增 5 項覆蓋 45 筆三頁、CLI 總數／範圍／續頁提示／越界、XML 第 12 行、UTF-16、格式不完整、未知編碼及舊 unsupported 升級。交付包逐檔核對 185 個檔案：`LocalDocSearch-M24-0.27.0.zip`，SHA-256 `10a9f058bb2c67ea20e48ef14e666cc3c4410e5411a00433761b93185513cc0b`。公司 Windows 人工驗收已由使用者回報成功；新版完整自動測試結果未另回報。
- 前一里程碑 0.26.3 依 SPEC §34.7 修復公司搜尋已確認的 `too many SQL variables`；下列 0.26.2 為歷史紀錄。
- 公司 0.26.2 真實 index／status 已成功：9,845 份檔案、593 indexed，payload Bloom 1；10 份 PPTX 的 OFFICE_MISSING_PART 與 1 份 XLS 錯誤尚未定位，不能宣稱格式驗收全部通過。
- 公司兩次直接搜尋診斷都在 streamBlocksFor 得到 ERR_SQLITE_ERROR／too many SQL variables。本機新增單份 40,000 區塊案例已在修正前重現相同堆疊；改用固定參數的 json_each 後通過，另驗證 33,001 payload 的跨邊界命中。
- 公司逐檔 M24 為 4 通過；M7／M9／M12／M13 為 33 通過、1 略過。2026-09-22 並行全套為 143 通過、3 失敗、2 略過，仍是 CLI 五秒逾時。0.26.3 預設逐檔測試並延後 watch 的解析器載入；不得將 0.26.2 timeout 設定宣稱為已證根因。
- 0.26.3 在 macOS／Node.js 26.7.0 完整逐檔回歸為 150 項：149 通過、0 失敗、0 取消、1 Windows CMD 專屬略過（16.48 秒）。公司真實搜尋與新版完整測試仍待複驗。交付包由 npm run package 逐檔核對，SHA-256 見同名 .sha256。

- 里程碑：M23 Windows 複驗修正 0.26.2——索引升級、唯讀 status、Windows 開庫零等待與原始碼安裝；規格見 SPEC §34。6。程式、本機回歸與交付包已完成，公司 Windows 重跑尚未完成。
- 公司 Windows／Node.js 22.17.0／0.26.1 全套實測為 148 項：142 通過、4 失敗、2 略過。M13 寫入鎖競爭及 M24 的 live writer／hot journal 三項都在 CLI 子程序五秒期限耗盡；M9 cmd launcher 在 `quiet-index-main (1)` 的含空白／括號路徑回傳 1。這次已執行但未通過，不能標記 Windows 驗收完成。
- 0.26.2 將 `DatabaseSync` 的 `timeout: 0` 提前至主索引唯讀／寫入與 writer 協調資料庫的建構階段，確保任何查詢或 `BEGIN IMMEDIATE` 前已有零等待 busy handler；不延長原五秒測試期限。M9 測試以暫存 wrapper 避免 Node argv 與 `cmd /c` 的雙層特殊字元解析，仍從不同 cwd 呼叫真正的 `docsearch.cmd`。
- GitHub Source code 壓縮檔沒有 `dist`，因此 0.26.2 加入 npm `prepare`：`npm ci` 完成後直接產生編譯檔。0.26.1 的第一次 `MODULE_NOT_FOUND` 發生於 build 前，不是索引資料錯誤；其後 `npm test` 已成功 build。
- 0.26.2 在目前 Mac 的 M9／M13／M24 聚焦回歸為 21 通過、0 失敗、1 項 Windows cmd 專屬略過。完整 148 項為 146 通過、0 失敗、1 項 M11 原生 watcher 在此環境 15 秒逾時而取消、1 項 Windows cmd 專屬略過；單獨重跑 M11 仍為同一環境限制，與本次開庫修正無關。
- 0.26.2 交付包已逐檔核對 181 個檔案：`LocalDocSearch-M23-0.26.2.zip`，雜湊寫入同名 `.sha256`。全新解壓後以 Node 22.13.1 執行 `npm ci`，prepare 成功建立 `dist` 且 CLI help 可執行；版本低於正式目標而出現 engine 警告，不能取代 Windows／22.17.0 重跑。
- 公司 Windows／Node.js 22.17.0／0.26.0 已回報 index 超過五分鐘無進度、status 無輸出，未通過本次驗收。診斷副本回復後可讀：610 文件、219,518 區塊，content_storage_version=2、multi_root_version=1，缺少 payload_bloom_version=1；主庫 84,459,520 bytes、journal 12,965,512 bytes。唯讀診斷曾得到 776（待回復交易），不得當作原始延遲主因或資料毀損證據。
- 已移除共用開庫的自動遷移：status／search 等讀取命令以唯讀連線開庫；status 在任何資料庫查詢前顯示索引位置，列出格式與升級進度。776 會回報 INDEX_RECOVERY_REQUIRED，busy／locked 立即回報 INDEX_BUSY。
- Bloom 升級受 writer lock 保護，直接逐 payload 建立對應與摘要，不重壓縮或改寫 payload；以 Map 線性查找、逐文件交易及完成標記接續。Ctrl+C 在文件／payload 安全點停止並回傳 130；index、rebuild 與 watch 的同步預設輸出節流進度。
- 新增 M23 修正版 4 項回歸：唯讀檢查零遷移、中斷後接續且 payload bytes 不變、主資料庫真實寫入交易期間 status 五秒內讀取，以及 hot journal 明確回報並由下一個 writer 回復。M8／M20 舊遷移測試改為明確寫入升級。
- 610 文件／219,518 區塊合成舊索引量測：Node 26.7.0 為 877.44 ms、峰值 RSS 113,295,360 bytes；Node 22.13.1 為 985.25 ms、峰值 RSS 103,006,208 bytes。兩者 610 個 payload 的數量與 bytes 前後完全相同，建立 219,518 個 mapping、610 個 Bloom／完成標記。這是目前 Mac 合成資料，不取代公司 Node 22.17.0 真實索引複驗。
- 0.26.1 在目前 Mac 的全套共 148 項：146 通過、0 失敗、1 項既有 M11 原生 watcher 在目前環境 15 秒逾時而取消、1 項 Windows cmd 專屬略過。公司 Windows 結果以上述 142／4／2 取代「待複驗」狀態，但尚未通過。以下 0.26.0 記錄為缺陷回報前的歷史證據。
- 0.26.1 交付包已逐檔核對 181 個檔案：`LocalDocSearch-M23-0.26.1.zip`；SHA-256 為 `6164546db0fd62f83b1bce7cf17bd71f84ed9ca901feb3e8932394ab7904d9e3`。公司複驗步驟見 `M23-FIX-WINDOWS-ACCEPTANCE.md`。
- 0.26.0 M23 新增 payload／block 對應與 1 KiB payload 級 trigram Bloom；文件 Bloom 先排除不可能文件，再只解壓含可能 trigram 的完整文字區塊。跨 payload 片語、短詞、舊索引或無 payload 候選均安全回退，搜尋結果語意未變。M20～M23 相關自動測試 6 項通過；完整全套在此受限 sandbox 仍有 M11 原生監看逾時，且 M15 CLI 因預設索引位置唯讀而得到 4（預期 3），待可寫入的標準環境重跑。Windows 0.26.0 尚未實機驗證。
- M23 交付包已建立並逐檔核對 174 個檔案：`LocalDocSearch-M23-0.26.0.zip`；SHA-256 為 `5195f205ceaa9b9ecc0be4fba8fd654da2b46d0d6fe1dcfa24fb10c79e90c2fd`。Windows 仍需使用者在公司電腦完成實機驗收。
- 0.21.0 自動測試共 136 項：135 通過、0 失敗、1 項 Windows cmd 專屬測試在 macOS 略過。M18 測試封鎖舊 `candidates()` 整庫載入，覆蓋片語、多詞、篩選、片段與 context passages。
- 0.22.0 自動測試共 138 項：137 通過、0 失敗、1 項 Windows cmd 專屬測試在 macOS 略過。新增 M19 大型 Unicode 原文與長命中截短回歸。
- M19 交付包為 `LocalDocSearch-M19-0.22.0.zip`，SHA-256 為 `e6523104bd193ef65104be33ff67304dd7f7a72ea8a51e101e3e09a4d29defa5`；Windows 0.22.0 尚未實機驗證。
- 0.20.0 自動測試共 135 項：134 通過、0 失敗、1 項 Windows cmd 專屬測試在 macOS 略過。新增案例涵蓋未知副檔名、無副檔名、不讀正文、任意類型篩選、open dry-run、增量修改／刪除及排除／連結。
- 使用 `/Users/hermes/Downloads/測試用資料` 唯讀實測：找到並登錄 471 份一般檔案，151 次內容解析；結果為 indexed 139、no_text 11、unsupported 320、encrypted 1、error 0，首次 5.11 秒。第二次增量 471 份全數未變更、解析器呼叫 0、21.6 ms。
- 真實資料已用 `.mov` 的 `IMG_8805.MOV` 與 `.zip` 的 `開發手冊.zip` 驗證檔名搜尋及 `--type` 篩選，兩者均清楚顯示 unsupported／僅檔名命中。
- 若索引資料庫位於掃描根目錄內，會排除自身 SQLite、WAL、SHM、journal 與 writer 協調檔，避免索引輸出回饋成來源。
- 交付包為 `LocalDocSearch-M17-0.20.0.zip`；打包程序逐檔核對 156 個檔案，全新解壓後 `npm ci` 無弱點警告並重跑相同 135 項測試結果。
- `search`／`context` 新增 `--all-terms`；全部空白分隔詞可分散在同一文件的檔名、標題與不同內容區塊，既有預設仍為精確片語。
- 代表片段依詞涵蓋數、標題優先與原始順序選擇；context passages 優先補足尚未顯示的關鍵字，預覽後以同模式重新驗證。
- context JSON schemaVersion 4 新增 `matchMode`，Markdown 同樣標示搜尋模式。
- macOS／Node.js 26.7.0 與 22.17.0：131 項，130 通過、0 失敗、1 Windows cmd 略過。
- 0.19.0 交付包全新解壓、`npm ci` 後以 Node.js 22.17.0 重跑，結果相同；Windows M15 剪貼簿與 M16 多詞功能依使用者時間延後實測。
- 0.19.0 交付包為 `LocalDocSearch-M16-0.19.0.zip`，並附同名 `.sha256` 檔供下載或複製後核對檔案完整性。
- `context --clipboard` 在完整預覽及 `yes` 後將 Markdown（或明確指定的 JSON）送入本機剪貼簿；與 `--out` 二選一，不連線外部服務。
- 剪貼簿資料只經子程序 stdin 傳遞；Windows 固定 PowerShell UTF-8 `Set-Clipboard`，macOS 使用 `/usr/bin/pbcopy`。自動測試不改動真實剪貼簿。
- macOS／Node.js 26.7.0 與 22.17.0：127 項，126 通過、0 失敗、1 Windows cmd 略過。
- context 內可用 `s <查詢>` 保留選取並搜尋下一批候選；`b` 查看跨查詢清單，`r <編號>` 移除。
- JSON schemaVersion 4 與 Markdown 都標示搜尋模式、總查詢及每份文件／passage 的查詢來源；同一文件去重，跨查詢總上限 20。
- 匯出前後依各文件自己的查詢重新驗證索引與來源；取消、無結果與無效操作不破壞已選狀態或建立部分檔案。
- macOS 真實 TTY 已完成「規格查詢→選取→BU 聊天查詢→選取→預覽→yes→Markdown」流程。
- 公司 Windows／Node.js 22.17.0 執行 0.17.0 `npm test`：M13 寫入鎖競爭測試超過 10 秒，M9 cmd 啟動測試受引號解析影響；其餘回報未顯示失敗。這次是已執行但未通過，不能標示 Windows 驗收完成。
- 0.17.1 將 SQLite 零等待設定與取鎖拆開，補上競爭耗時斷言及子程序期限；cmd 測試改以環境變數和 `call` 傳遞含空白的絕對路徑，失敗診斷不再解碼 OEM 錯誤內容。
- macOS／Node.js 26.7.0 與 22.17.0：123 項，122 通過、0 失敗、1 Windows cmd 略過；M13 整組分別約 1.57 秒與 1.41 秒。
- 0.17.1 交付包為 `LocalDocSearch-M14-0.17.1.zip`，144 個檔案逐檔核對；全新解壓後 `npm ci` 並以 Node.js 22.17.0 重跑，122 通過、1 Windows 專屬略過。最終雜湊記錄在同名 `.sha256` 檔。
- 使用者於 2026-09-18 回報公司 Windows 的 0.17.1 驗證通過；M13 鎖競爭與 M9 cmd launcher 修正完成驗證。此回報證明自動測試通過，不擴張為所有公司真實文件、open／reveal 或長期日常使用皆已驗收。

## 後續與限制

- 已用 `/Users/hermes/Downloads/測試用資料` 完成第一輪儲存／搜尋後端對照。12 組完整命中集合均與 0.20.0 相同；現況 17.70 MiB，64 KiB Brotli 4.46 MiB，Brotli＋Bloom 6.02 MiB，Brotli＋FTS5 12.16 MiB。詳見 `STORAGE-BACKEND-COMPARISON-2026-09-19.md` 與原始 JSON。
- 現有 SQLite 只改逐列串流，原型峰值 RSS 由 477.6 MiB 降至 104.7 MiB。下一里程碑建議先修正式搜尋的整庫載入，再做版本化 Brotli 分塊；Bloom 候選排在壓縮之後，FTS5 暫不採用。
- M18 對「測試用資料」重跑 12 組完整命中集合，結果與 M17 相同；正式搜尋已不載入所有 blocks。長時間連續查詢 worker 的峰值仍為 433.5 MiB，原因是 `makeSnippet()` 對命中的超大區塊建立整段 Unicode 對照表，不是 SQLite 整庫載入。下一步先將片段定位改成有界記憶體；在那之前不宣稱 M18 已達到 104.7 MiB 的正式 CLI 峰值。
- M19 在同一資料夾、Node.js 26.7.0 的 12 組查詢重跑，完整命中集合不變；正式 worker 峰值 RSS 為 405.8 MiB，最慢 p95 為 185.2 ms。片段的整段位置陣列已移除，但全文正規化與逐一核對仍是主要記憶體成本；不得把這個小幅下降宣稱為壓縮後端的成果。原始量測為 `storage-backend-comparison-m19.json`。
- M20 的第一個每 block Brotli 實作已由真實資料否決：115,618 個 payload 使資料庫達 19.31 MiB，高於 M17 的 17.70 MiB。命中與資料完整性均正確，但空間目標未達成；正在改為每文件合併小 block 的 payload 設計，尚不可封裝或宣稱 M20 完成。
- M20 改為每文件合併小 block 的 64 KiB Brotli payload 後，真實資料的 payload 數降為 285，資料庫為 12,259,328 bytes（11.69 MiB），較 M17 的 17.70 MiB 減少 34.0%。`管理系統` 搜尋命中、位置與原始片段正確。140 項自動測試為 139 通過、0 失敗、1 Windows 專屬略過；Windows 0.23.0 尚未實機驗證。
- M21 將主搜尋改為逐 payload、逐 block 產生，並修正 payload 寫入必須依 block ordinal 排序。141 項自動測試為 140 通過、0 失敗、1 Windows 專屬略過。真實 12 查詢結果集合不變；獨立程序連續量測峰值 RSS 394,512 KiB（約 385 MiB）。仍需解壓與正規化全部 payload，下一步候選過濾才可能有量級改善。
- M22 新增 1 KiB 文件級正規化 trigram Bloom；三字以上長查詢可跳過確定不命中的文件，一、二字及缺摘要資料安全回退。142 項測試為 141 通過、0 失敗、1 Windows 專屬略過。真實 12 查詢結果不變，峰值 RSS 389,280 KiB（約 380 MiB）；長片語／無結果較快，但常見詞候選多，下一步需 payload 級候選。

- 2026-09-19 使用使用者指定的本機開發手冊作唯讀原型：20 份支援文件、239 個文字區塊。Brotli 將 152,742 bytes 文字壓至 78,538 bytes，但加上精簡 contentless trigram 後合計 335,872 bytes，高於現有 249,856 bytes 索引；五組三字以上查詢未漏候選，一／二字搜尋仍未解。詳見 `SEARCH-BACKEND-EXPERIMENT-2026-09-19.md`。
- 第三方 `@oxdev03/node-tantivy-binding@0.3.3` 可載入預編譯套件，但實際 API 缺少型別宣告中的 n-gram tokenizer 建構方法；不加入產品依賴。Tantivy 若續評估，需以官方 Rust crate 建立受控 sidecar 原型。
- 使用者已授權以目前 Mac 持續逐版做到完整目標，不逐版要求確認。M16 已補上多詞分散命中；後續繼續以本機自動測試推進，並依實際搜尋失敗案例調整查詢、格式支援或本機整合，不預設連接外部帳號。
- 專用聊天平台匯入、AI／IDE 直接接入與查詢改寫仍未實作；M14 只處理本機索引中的 TXT／MD／MSG 等既有來源。
- 不混用舊版寫入索引、不刪除執行中的協調檔；索引放本機磁碟。搜尋不是整批同步的固定快照。
- 保留大量既有未提交工作，不重置或覆蓋舊版交付包。

## M13 目標證據盤點與效能複測

- 2026-09-17 已逐項整理 GOAL-AUDIT.md，區分本機已證明、Windows 缺證據與後續選配。
- Node.js 22.17.0 的 0.16.0 固定 1000 份六格式合成小文件：初次索引中位數 4087.98 ms、未變更 217.99 ms、搜尋 p95 216.63 ms；所有結果及增量異動斷言通過。
- 原始報告 benchmark-m13-node22.json 與 M13-PERFORMANCE.md 為本次補充；舊 M5 數據與已交付 0.16.0 壓縮檔未覆寫，程式碼沒有變更。
- 缺口仍是公司 Windows 新版實際使用證據；AI／IDE 自動接入、專用聊天匯入與 GUI 按鈕並未實作，依路線圖為未啟動選配。不把 CLI 匯出冒稱已連接 AI。

## 開發目標調整

2026-09-17 使用者明確取消公司 Windows 逐版驗收門檻，要求先在目前 macOS 電腦持續迭代到完整目標。Windows 相容與未驗證事實仍保留，但不再視為 active blocker。

M14 先讓同一個 context 工作階段能跨多次查詢累積選取，將規格、程式文件與 BU 聊天等不同關鍵字來源放入同一份精準上下文。仍需逐項預覽與 yes，不自動傳送到 AI。
