# 設計決策紀錄

## D098：主索引改用 WAL 並將 busy 等待設為有上限

- 日期：2026-09-29。
- 事實：
  - SQLite 官方 WAL 文件（[`sqlite.org/wal.html`](https://sqlite.org/wal.html)）明確區分 reader snapshot、單一 writer、checkpoint 與 `-wal`／`-shm` sidecar；WAL 可讓 reader 與 writer 並行，但不能取消 writer 間互斥，也不能把 checkpoint 忙碌當成資料遺失。
  - Firefox Places 的資料庫實作（[`toolkit/components/places/Database.cpp`](https://searchfox.org/mozilla-central/source/toolkit/components/places/Database.cpp)）是長期本機 SQLite 使用者，提供採用 WAL、保護 checkpoint 與處理 sidecar／回復限制的可比對工程脈絡；Seekah 不複製 Firefox 程式碼或產品行為。
  - Seekah 既有主索引與 readonly 連線曾在 `store.ts` 使用建構時 `timeout=0`／`PRAGMA busy_timeout=0`；coordination、live lease、live queue 另有零等待互斥需求。D097 的 rollback-journal 假設使 reader `SHARED` lock 直接把背景主庫提交打成 SQLITE_BUSY。
  - 索引容量列舉已包含主庫 `-wal`／`-shm`／`-journal` 與 coordination／live／work sidecar；WAL 轉換、readonly 缺 sidecar、hot journal 及 copy／清理路徑仍需逐一驗證。
  - 本機壓力測試（Windows、Node 22.23.2、60 秒 × 2、N=1／4）以 4 ms 額外 reader transaction 放大 checkpoint starvation：WAL/0 與 WAL/5000 皆零讀寫鎖錯誤，但 `-wal` 最大約 540–670 MiB；每秒 `TRUNCATE` 可壓至 14–21 MiB，寫入吞吐約由 1900 降至 400 次／輪，且有偶發單次 BUSY。真實 Seekah 搜尋沒有顯式長讀交易，因此壓力參數比產品查詢嚴苛。
- 決定：
  - writable `IndexStore` 在 coordination writer lock 內嘗試 `PRAGMA journal_mode=WAL`；fresh database 直接建 WAL，既有 rollback database 在下一次 writable open 轉換。轉換因 busy 或 SQLite 回傳非 WAL 時記錄診斷、保留原模式、不中止 writable open，下一次再試；readonly 永不改 mode。
  - 主索引 centralized constants：constructor／schema 初始化 busy 上限 200 ms、readonly busy 上限 200 ms、初始化完成後 writable 寫入上限 1500 ms；constructor option 與後續 PRAGMA 依階段設定。`write-lock.ts`、live lease、live queue 與 work state 維持零等待。
  - WAL writable connection 以 page size 換算約 2 MiB `wal_autocheckpoint`，設定 4 MiB `journal_size_limit`；每批提交先做 non-blocking `PASSIVE`，`-wal` 超過 64 MiB 才在 coordination writer lock 內各做一次 `RESTART`／`TRUNCATE`。full sync／rebuild、migration、compact／VACUUM 可額外要求一次 truncate；checkpoint 失敗不重試卡住。
  - CLI 將 `SQLITE_READONLY_ROLLBACK` 776、`SQLITE_READONLY_CANTINIT` 1288、`SQLITE_CANTOPEN_DIRTYWAL` 1294 視為 `INDEX_RECOVERY_REQUIRED`；既有 hot journal 回復與 sidecar status 列舉保留。
- 理由：
  - WAL 直接解決本機搜尋 reader snapshot 阻塞索引 writer 的主要互斥；但 `DatabaseSync` busy handler 是同步阻塞。constructor 初始化的每一條受影響 statement 最多阻塞 200 ms，正常寫入 statement 最多阻塞 1500 ms，多條 statement 可能累加；這是有上限的同步停頓，不是無限等待。coordination lock 仍保留跨程序 `INDEX_BUSY` 的即時語意。
  - 以 constructor timeout 加 PRAGMA 雙層設定，覆蓋 sqlite3_open_v2 後的第一個查詢與後續 transaction；coordination 零等待則保留跨程序 `INDEX_BUSY` 的即時語意。
  - PASSIVE 每批嘗試加 64 MiB threshold 只在必要時升級，避免每秒 TRUNCATE 將約 1900 次／輪吞吐壓到約 400 次／輪；在長 reader snapshot 期間仍接受 WAL 暫時變大，checkpoint 忙碌不阻塞或重試寫入。
- 不做什麼與風險：
  - 不刪除 WAL／SHM／journal，不關閉 durability，不把 writer lock 改成 timeout，不改 schema、搜尋結果、generation、資料目錄相容性或本機處理邊界。
  - 初始化／寫入 busy 都是同步等待：初始化單條最壞 200 ms，正常單條寫入最壞 1500 ms；多條 SQLite statement 的總阻塞可累加。產品搜尋不新增長時間顯式 read transaction；長時間 readonly transaction 仍可能延後 checkpoint 使 WAL 暫時變大，4 MiB limit 是回收目標，不保證讀者持鎖時立即 truncate。一般主庫 busy 仍可能在 1500 ms 後回報 `INDEX_BUSY`。
  - WAL sidecar 需要資料夾權限；readonly 開啟缺 sidecar 的成功條件與 `SQLITE_READONLY_*`／dirty-WAL 錯誤碼必須由測試覆蓋。公司 Windows 人工驗收未回報前，不把本機結果稱為 Windows 通過。
- 版本：0.42.0。

## D097：背景自動更新遇主庫 SQLITE_BUSY 走 INDEX_BUSY 重試

- 日期：2026-09-29。
- 事實：
  - 主索引採 rollback journal，`src/store.ts` 的主庫唯讀／寫入連線與 writer 協調連線都設定 `busy_timeout = 0`。搜尋的唯讀連線持有 `SHARED` lock 時，背景自動更新即使已取得 coordination write lock，主庫的 BEGIN、寫入或 COMMIT 仍可能直接回傳 SQLite errcode 5／6。
  - 原始 SQLite busy 不是 `IndexBusyError`。`LiveUpdateEngine.runRoot` 原本只對 `IndexBusyError` 保留待辦，其他錯誤會記 `LIVE_UPDATE_FAILED` 並把 `database is locked` 帶進工作台健康摘要；背景校正的單檔 catch 也會把主庫 busy 誤分類為 `readFailures`。
  - 0.42.0 的局部更新群組提交在 `local-update.ts` 的 backoff 只辨識 `IndexBusyError`；若主庫交易本身 busy，已準備結果路徑不能使用既有忙碌重試語意。
- 決定：
  - 在 `write-lock.ts` 匯出共用 `isSqliteBusy(error)`，以 `errcode & 0xff` 判斷 SQLITE_BUSY／SQLITE_LOCKED（含 extended code），並讓 writer lock、live lease、store migration、CLI、Workbench 與背景更新路徑使用同一判斷。
  - `LiveUpdateEngine` root catch 把原始 SQLite busy 視同 `IndexBusyError`：記錄 `INDEX_BUSY：<root>：稍後重試同步。`，設定 writer busy，保留 dirty／reconcile／pending，不設定 `syncFailed`，不記 `LIVE_UPDATE_FAILED`。
  - `withWriterBackoff` 與 §63 群組提交納入原始 SQLite busy。群組仍只取得一次 coordination lock，逐份重試主庫交易；成功的文件才完成 ack，未完成文件保留待辦。
  - `runBackgroundReconcileBatch` 遇主庫 busy 時重新拋出，不寫入 `readFailures`；busy 前的 seen checkpoint 先落盤，busy 項目不標記 seen、不提前 pop frontier、不執行 finish／generation ack。
- 理由：
  - SQLite 回滾日誌的讀寫鎖競爭是暫時性資源忙碌，不是來源文件讀取失敗。沿用既有有限／分輪 retry 可保留 at-least-once 與已提交進度，也避免工作台暴露原始 SQLite 診斷。
  - 共用判斷避免不同入口對 extended code 的處理分歧；維持 `busy_timeout = 0` 可保留 Windows 上立即回報與可取消的鎖語意。
- 不做什麼：
  - 不改主索引、work state、write-lock、live-lease 或 live-queue 的 timeout，不設定全域非零 `busy_timeout`。
  - 不把非 busy 的 SQLite 或檔案錯誤改成重試，不改 schema、generation、搜尋／索引語意，不加入網路或外部服務。
- 版本：0.42.0。

## D096：背景校正 checkpoint 批次化（perf P0-3）

- 日期：2026-09-29。依 .claude/task.md P0-3 分析、SPEC §64 與 D093 平行分支分配（SPEC 64、決策 D096）。
- 問題：src/reconcile.ts 每目錄項目就呼叫 queue.saveReconcileStep；live-queue.ts 每次 save 都是獨立 BEGIN IMMEDIATE + COMMIT + 完整 JSON.stringify(frontier+failed+acks)；synchronous=FULL 使 fsync 成本高。大量檔時 work.sqlite tx 數與 I/O 成為瓶頸，也延長 main writer lock 持有。
- 決定：
  - checkpoint 與 event 耐久性分離：acceptPath 等事件仍維持每筆立即落盤；reconcile 的 seen/state 改為 bounded batch。
  - 在 reconcile.ts 內對單一 reconcile 回合累積 pendingSeen（path + kind）陣列；用記憶體 Set 讓 hasReconcileSeen 在 batch 期間能看到未提交者（避免同一批內重處理）。
  - 新增 LiveWorkQueue.saveReconcileSteps(state, steps[])：單一 runWrite tx 內做多筆 INSERT OR IGNORE reconcile_seen + 一次 UPDATE reconcile_state。
  - 批次上限自訂為 200 項或約 1000 ms（合理平衡重播量與 tx 減益）；到限即 flush。
  - 強制 flush 點（硬性）：
    - 目錄 entries 處理完、frontier.pop() 之前。
    - 呼叫 store.removeMissing(known) 之前（保證 known 來自 durable seen）。
    - 校正結束（frontier 空、finishReconcile）之前。
    - abort/cancel 時（signal 檢查前 flush）。
  - 維持既有 process batch（500 entries / 250 ms）用來釋放 main lock；checkpoint batch 可在其內多次 flush。
  - saveReconcileStep 單筆方法保留（相容性），reconcile 內部改走 batch。
  - 無任何 schema 變更；PRAGMA synchronous = FULL、journal=WAL、busy=0 完全不動。
  - readFailures / deferredChecks / complete 語意、removeMissing 前提、at-least-once 全部維持 §60 與既有契約。
- 驗證：
  - test/m53.test.ts 用 persistHook 計 tx 數證明減少；中斷重啟案例；remove 前未 flush 誤刪案例（patch 模擬）。
  - 反向驗證：git show main:src/... 暫換回舊碼，m53 至少 1 項失敗（tx 未降或 restart 案例）；還原通過。
  - 量測：數千檔合成樹，前後 wall-time 與 tx count 對比（同一資料）。
- 否決／取捨：
  - 否決每批都用單一 tx 寫 frontier（會讓 pop 太晚，crash 重播過多；現採「seen batch，pop 後再保存 frontier」）。
  - 否決把 batch 做到 event 層：會混淆 durability，違反「事件落盤即收」。
  - 選 200/1000ms 而非 500/250：checkpoint 更細粒度，crash 重做量小；process batch 仍保 lock 釋放。
  - 不改 JSON 序列化頻率以外：仍每 flush 一次 stringify，但次數大幅降。
- 相容：行為完全等價（索引內容、搜尋結果、status complete、失敗分類、刪除判斷皆不變）；只改善效能。
- 版本：0.42.0。

## D095：局部更新在 writer lock 外準備、有限群組鎖內提交

- 日期：2026-09-29。依效能審查 P0-2；行為見 SPEC §63。
- 問題：現行 `LiveUpdateEngine.runRoot` 在局部更新批次開始前取得 writer lock，穩定等待、檔案讀取、解析與每份文件提交都在同一把鎖內；手動 `index`、工作台索引與其他根目錄 writer 會被沒有 SQLite 寫入的等待與解析阻塞。改成每份文件各自取鎖後，雖降低等待，卻在大量 flood 下造成 lock acquire 開銷與吞吐下降。
- 決定：
  - 局部更新的批次觀察與一次穩定等待移到 writer lock 外；每份一般檔案的讀取與解析也在鎖外完成。
  - 已準備結果以最多 50 份或約 250 ms（先到者）封存成群組；每群組只取得一次 writer lock，逐份重新 `lstat` 並核對 `size`、`mtime`、檔案身分後才 `upsert`／metadata 提交，再釋放鎖。
  - 群組內某份重新確認失敗、檔案消失或根目錄不再登錄時，只放棄該份過期結果；變動依 §54 延後，消失依既有安全刪除流程處理，同群組其他文件照常提交。取消與停止在提交前不 ack；SQLite transaction 保證已開始的單份提交不會留下半寫入。
  - 同時保留的 prepared 文件最多 50 份，文字內容預算為 8,000,000 字元；準備前以來源 size 預留，解析後以 block heading/content 累計。單一超過預算且不可拆分的文件單獨成群組，不與其他文件並存；不平行解析。
  - 仍沿用每輪 500 筆／約 5 秒、一次穩定等待、連續 5 次延後、排除規則傳遞與 at-least-once queue 語意；不改 writer 交易內部。
- 取捨：
  - 群組提交增加單次 writer lock 可能涵蓋的 SQLite 工作量，但把群組上限固定為 50 份／約 250 ms，避免逐份 lock acquire 的吞吐損失，同時讓穩定等待、讀檔與解析不阻塞 writer。
  - 有界 prepared 群組的文字預算限制記憶體峰值；大型單檔仍需單獨保留其不可拆分的 `DocumentRecord`，平行解析與更細粒度 parser streaming 另案，不在本次擴張。
- 否決：
  - 不在鎖外解析後直接寫入，避免來源變動造成過期內容。
  - 不重新把整輪最多 500 份解析結果放在記憶體，也不讓一份一份取鎖的低吞吐取代群組提交。
  - 不為了群組化取消 metadata recheck；每份文件仍在同一群組鎖內獨立核對，變動文件不得污染未變動文件。
- 相容：不改索引 schema、工作佇列 schema、搜尋結果、排序、片段、排除結果或背景校正契約；非 live 的 CLI／watch 單檔 `applyFileUpdate` 仍沿用既有 lock/backoff 行為。
- 版本：0.42.0。

## D094：chunk candidate 延遲化與 SQL 排序／bounded top-K

- 日期：2026-09-29。依 P0-1 效能審查與 SPEC §62；版本 0.42.0。
- 問題：chunk store 搜尋目前對每個 term 呼叫 `chunkCandidates()`，以 `.all()` 取得所有 posting row，建立完整 `Map<documentId, number[]>`；之後再一次載入候選文件並在 JavaScript 全量排序。常見詞的準備工作造成不必要的 row materialization、Map、文件 metadata 與 GC 峰值。
- 決定：
  - 新增只讀 candidate iterator，將 term 的 filename／heading／chunk posting 聯集與 `all-terms` 交集推入 SQLite，並在 SQL 套用 type、root、subtree、status 範圍。
  - `filename`／`modified` 直接以 SQL 的穩定 tie-break 順序使用可續 cursor；`relevance` 分開檔名、heading、content rank，content 維持可續的有界 top-K 驗證，不預先載入所有候選。
  - 路徑排序維持既有 JavaScript UTF-16 code-unit 順序：索引沒有 supplementary code point 時走 SQLite 原生文字排序；有時改用 UTF-16 big-endian BLOB sort key，避免 Unicode tie-break 改變結果。
  - `path_order` 持久化於 metadata：新索引寫入 `native`；`upsert` 或 `touchMetadata` 遇到 supplementary path 在同一交易升級成 `utf16`，刪除永不降級。舊索引由可寫入開啟一次性掃描並回填；唯讀缺旗標直接保守採 `utf16`，絕不在開啟時掃描 `documents`。
  - 每份文件只在被 iterator 取到時讀取 metadata；每份文件的 heading／chunk candidate 也延遲到 rank verification，`within` 則完全保留上一層 document ID 順序。
  - 保留既有 `rankOne`／exact verification 的正規化、all-terms coverage、代表 block、片段與 passage 選擇；SQL 只提供 superset，不把 FTS candidate 當成命中。
  - fast／exact 仍由 `totalTarget()` 決定驗證邊界；精確模式排空 iterator，快速模式超過 500 份仍只回報下限。
- 否決：
  - 不用 JavaScript `Map` 收集每個 term 的完整 chunk postings。
  - 不以 SQLite 的候選 row 順序取代既有 exact verification，也不將 content rank 直接推定為命中。
  - 不改 schema、FTS tokenizer、chunk 格式、總數契約或未完成 migration 的舊路徑。
- 相容：搜尋文件集合、順序、rank、代表 block、passage、snippet、reason、片段狀態與快速／精確 total 必須與改動前逐筆相同；所有文件留在本機處理。
- 驗證：`test/m51.test.ts` 對照舊路徑完整結果；`test/m54.test.ts` 驗證唯讀開啟不掃描與旗標生命週期；`npm run build`、`npm test`；同一資料與查詢量測搜尋與 32 萬份資料庫的唯讀開啟＋第 1 頁 wall time 前後差異。

## D093：平行分支開發與審查合併流程

- 日期：2026-09-29。使用者要求多個 AI 工程師像團隊一樣同時實作不同任務，完成後提交分支，由審查者合併並處理衝突。AGENTS.md 原規定「每次只實作 STATUS 指定的進行中里程碑」。
- 決定：
  - 使用者核准時可平行開發。每項工作一條分支（`feat/…`、`perf/…`）與一個 git worktree，互不共用工作目錄。
  - 開工前分配 SPEC 章節與決策編號，避免撞號；新章節版本寫「待合併時決定」。
  - 實作者只改自己的範圍並在分支提交、不 push；不改版本號、STATUS、handoff、NEXT-TODO。
  - 審查者逐條看 diff、在該分支重跑完整測試，不合格退回；依規格章節順序合併，文件並列衝突保留雙方並依序排列，程式衝突先由實作者 rebase，邏輯取捨由審查者決定；每次合併後在 main 重跑完整測試；最後統一更新版本與交接文件。
- 取捨：平行可縮短總時程，但合併成本與文件衝突增加；以事先分配編號、共用檔案由單一合併者處理來控制。
- 首次適用：0.41.0（§58～§60）。

## D092：局部更新重用 RootExclusion 避免每檔重讀規則（perf P0-4）

- 日期：2026-09-29。依 P0-4 分析與 SPEC §61 實作純效能改動。
- 問題：local-update.ts applyFileUpdateLocked 每檔呼叫 loadRootIgnore → RootExclusion.load（讀 ignore + store.ignoreBases）；live 已有 state.exclusion 卻未傳入。
- 決定：
  - `LocalUpdateOptions` 加入可選 `exclusion?: RootExclusion`。
  - LiveUpdateEngine 建立 inner 時傳入 `state.exclusion`（批次內 reuse）。
  - 未傳時 fallback 每次 load，維持 CLI/watch/其他呼叫者原有行為。
  - 快取失效由既有 handleEvent（規則檔/root） + runRoot 前重載（scope merge 後） + newState 保證；exclusion 為 immutable 實例，換新即生效。
  - 結果完全等價，不改排除語意。
- 驗證：m50（spy 計數 + 規則變更生效 + 等價行為）；npm test/build。
- 相容：不改 schema、status、API 契約、排除結果。
- 規則檔 parse 錯誤時：runRoot try loadSync 失敗，state.exclusion 仍用 builtinOnly（事件層不變），但 inner 不傳 exclusion，讓 apply 每檔 load 拋錯、更新失敗不寫入；與未傳 exclusion 一致。m50 d 驗證。
- 版本：0.41.1。

## D091：背景校正拆分讀取失敗與延後核對

- 日期：2026-09-29。NEXT-TODO 指出背景校正把讀取錯誤與本輪尚未處理完的 scope 都放在 `failedScopes`，使可讀資料夾也被使用者看到「失敗」。行為見 SPEC §60。
- 根因：`reconcile.ts` 的目錄列舉／檔案更新錯誤，以及 scope 收尾時被待辦事件阻擋，原本都寫入同一個 `failed_scopes_json` 陣列；status 只能顯示一個無法解釋的失敗數。
- 決定：
  - `ReconcileState` 改為分開保存 `readFailures` 與 `deferredChecks`。權限、IO、列舉、刪除安全核對與更新流程錯誤歸入前者；檔案不穩定、待辦事件或未完成 scope 歸入後者。
  - scope 只有在兩類集合都沒有且沒有待辦時才可執行 `removeMissing`；`deferredChecks` 仍使 `complete = false`，不把「延後」當成成功。
  - `failed_scopes_json` 欄位與工作狀態庫 schema version 不變。新值以 `{"readFailures":[...],"deferredChecks":[...]}` 保存；舊版 JSON 陣列保守解讀為 `readFailures`，讓既有佇列可直接開啟並維持未完成語意。
  - `autoupdate status` 改顯示「讀取失敗」與「延後核對」兩個數字，不再顯示合併的「失敗scope」。
- 否決：
  - 不把延後核對計入讀取失敗，避免可讀資料夾被標示為讀取錯誤。
  - 不以資料庫 rebuild、刪檔或 schema version bump 處理既有工作狀態。
- 取捨：為保留既有 schema 與資料庫直接可讀，不升版或重建工作狀態庫；因此新物件格式寫入後不支援舊版 daemon 降級接續同一輪校正，避免舊版把失敗記錄當成空集合而誤刪索引文件。
- 版本：0.41.0（與 D089、D090 同批發布）。

## D090：遷移時對 SQLITE_BUSY 做有限重試（而非提高 busy_timeout 或全域等待）

- 日期：2026-09-29。任務來源 docs/NEXT-TODO 第 29 行及 D082 末「不在本版處理：遷移遇到 SQLITE_BUSY 時直接失敗（`database is locked`）的問題，另案處理」。
- 事實：src/store.ts ctor 與 migrate*（migrateChunkStore、migratePayloads）內的 BEGIN IMMEDIATE 在 timeout=0 + PRAGMA busy=0 下，遇到主庫鎖定即直接 throw raw sqlite 錯誤或讓上層看到 database is locked；acquireWriteLock 僅保護 coordination 的 .writer.sqlite ，main db 的 batch tx 在持有 coordination 時仍可能因第二連線、WAL checkpoint 或 timing 拿到 BUSY。sync/upgrade 路徑目前無重試。
- 決定：
  - 只針對遷移格式升級的 tx 區塊加入有限重試（退避上限總等待 ~8s，5 次）；重試用 async sleep + yieldToEvents，失敗後仍 rollback 並轉拋（cli 會顯示 INDEX_BUSY）。
  - 維持 write-lock / ctor / coordination 的 0 等待不變。
  - 新增 test/m48.test.ts 用第二個 DatabaseSync 連線持有 main db 寫鎖來模擬 busy，驗證重試後成功。
- 取捨與否決：
  - 選有限重試而非 busy_timeout=5000：避免 Windows 繼承非零值導致 BEGIN 前卡住；也避免長時間 block 單執行緒；重試明確可控且有上限。
  - 只限遷移（而非所有寫入）：日常 upsert 已由 caller withWriterBackoff 或 lock 保護；擴張會讓並行 bug 更難發現。D082 已承諾另案。
  - 不用無限 retry 或 promise 無限等：符合「不阻塞」原則，與 local update 退避一致。
  - 相容：不動 schema、lockHeld、IndexBusyError 契約；現有 5/6 碼處理繼續有效。
- 實作風險：重試只包 migration tx，test 必須 bypass acquire 直接持 main lock 才能觸發；若 SQLite 在同程序多 conn 行為不同，需實測。
- 版本：0.41.0（與 D089、D091 同批發布）。

## D089：0.41.0 將 autoupdate 管理搬進 GUI 並擴充登入啟動、健康摘要與可調參數

- 日期：2026-09-29。原 0.37.0 規劃時因時程排除 GUI autoupdate 開關（§46.0、46.11.5、46.11.6 明列「不做」），本次使用者要求補齊四項（B 登入啟動、C 健康摘要、D 可調參數）並搬進設定頁，SPEC 新增 §58。
- 事實：0.37.0 已實作 GUI 勾選框與後端 autoupdateEnabled，但 SPEC 仍寫「GUI 不做」「健康度只經 CLI」「不在 GUI 顯示或操作」。參數原寫死，無 GUI 調整入口；登入啟動僅 CLI。
- 決定：
  - 為何把 autoupdate 管理搬進 GUI（原排除僅因當時時程）：0.37 時 GUI 尚在初版，daemon 控制已存在但為避免延誤主線（日常更新＋加入根）而排除；現 GUI 穩定，健康狀態與參數調整對使用者日常操作更直接，CLI 仍保留完整入口。
  - 為何參數持久化在索引庫：仿 `searchTotalMode`／`setSearchTotalMode` 做法，存於 store 的 settings 區，與總筆數模式同屬使用者偏好；重啟 workbench 後讀回，daemon 啟動時套用；不放 CLI 旗標預設或個別檔，以免與索引資料分離。
  - 為何參數變更採停止再啟動：daemon 執行中改變 debounce／reconcile 須立即生效，但不另開 IPC 通道或動 daemon 內部；沿用既有 `autoupdateStop` + `autoupdateStart` 確保新參數載入，簡潔可靠；前景 watch 執行中則拒絕以保護使用者預期。
  - 為何不做自動輪詢：設定對話框開啟時讀取一次即足，另提供「重新整理」按鈕（`settings-autoupdate-refresh`）；自動輪詢會增加不必要負載與複雜度（daemon 狀態變化不頻繁），與「不做 GUI 內自動輪詢」原則一致。
- 相容：CLI `autoupdate` 契約、預設值、捷徑無參數時行為完全不變；非 Windows supported=false；持久化驗證沿用既有 resolve 函式；登入啟動捷徑擴充後仍與既有相容。

## D088：0.40.0 工作台搜尋結果改為搜尋引擎式列表，移除明細頁

- 日期：2026-09-29。使用者認為明細頁的預覽「很醜」，要求改成類似 Google 搜尋；使用者同意「照建議」並確認先只改工作台畫面。行為見 SPEC §57。
- 事實：明細頁的預覽紙內容就是列表上已有的同一段片段（同一個 `item.snippet`），點進去不會得到新資訊。
- 決定：
  - 結果列只留標題（點擊開啟原檔）、路徑列與片段；「顯示所在位置」與「加入上下文」縮為次要連結。
  - 移除明細頁、勾選框、檔案圖示、標籤、命中位置與右側資訊欄。使用者表示只需知道命中在哪份文件，不需要行號。
  - 保留上下文選取（使用者選擇保留，但降為次要）。
- 延後：
  - 同一份文件的第二段片段（需要伺服器產生，先看新版列表再決定）。
  - MCP 改為傳檔案路徑讓 Codex 自己讀（使用者已表態方向，但明確表示之後再處理）。
- 相容：搜尋 API、`open`／`reveal` 安全驗證、表格檢視與上下文上限不變。

## D087：0.39.4 新資料夾分批展開成逐檔待辦

- 日期：2026-09-28。使用者要求繼續處理尚未改善的項目；0.39.3 交接列出「移入的大型資料夾仍整棵掃描、不分批」。行為見 SPEC §56。
- 決定：
  - 資料夾待辦改為每輪最多讀 2,000 個目錄項目，檔案寫入工作佇列，沿用 §54／§55 的分批、穩定確認與輪替；解析與寫入不再和列出綁在同一輪。
  - 展開完成且無讀取失敗時，才對未看到的舊文件逐一確認不存在後排入刪除；避免展開期間才建立的檔案被誤刪。
  - 展開狀態只存在記憶體，資料夾待辦在完成前不確認，重啟後重新展開。
  - 展開出來的待辦排在同一圈的事件待辦之後：否則移入的大量檔案先進佇列，之後新建的檔案仍要等它們全部處理完。沿用工作佇列既有的 `reason` 欄位（`event`／`expand`），不改 schema。與 D086 否決的「新進先處理」不同：事件待辦之間仍先進先出。
- 否決：
  - 改由整根背景校正處理（§46.8 已分批，但會走完整個根目錄，使用者根目錄有 6.5 萬個檔案）。
  - 讓背景校正支援子樹範圍（一個根目錄只有一份校正狀態，與進行中的校正合併時已走過的目錄會被略過，容易漏檔）。
  - 持久化展開進度（重啟後重新列出只花讀目錄的成本，檔案處理本身已在佇列中冪等）。
- 相容：不改 schema、工作佇列 schema 或 status 欄位；`subtreeScanCount` 改為計算開始展開的次數。

## D086：0.39.3 忽略已在監看範圍內的資料夾 `change` 事件

- 日期：2026-09-28。使用者同意修正 0.39.2 重啟後卡在 `.grok` 子樹掃描的問題。行為見 SPEC §55。
- 證據：
  - 本機 Windows 實測：在直屬子目錄內寫檔，根目錄非遞迴 watcher 回報 `change:<子目錄>`，子目錄的遞迴 watcher 另外回報每個檔案與 `change:<更深的資料夾>`。
  - 使用者環境：13:47:47 起超過 5 分鐘停在 `.grok`（666 檔、499 MB）子樹掃描，程序單核 64% CPU；佇列累積到 10,000 筆上限。0.39.1 log 也有一次「更新 6257；耗時 135822 ms」。
- 決定：
  - 資料夾的 `change` 只代表其中項目變動，而這些項目本身已有事件；內容已被監看時忽略。
  - `rename`（新增、移入、改名）仍掃描子樹，因為移入的資料夾內的檔案不會各自產生事件。
  - 局部更新處理時間上限改從穩定等待之後起算：事件湧入時主執行緒忙於事件回呼，觀察 500 個檔案本身要 4–13 s，原本的上限讓每輪只處理 1 份。
  - 局部更新待辦輪替：量測發現 0.39.2 的每輪上限加上「再次變動保留原排序時間」，會讓持續變動的檔案一直排在最前面、新檔永遠輪不到；改為每一輪先處理本圈未處理過的待辦；同一圈內仍先進先出。
- 否決：
  - 子樹掃描改為分批（有其必要，但本規則後只剩新資料夾會觸發；先量測，需要再另案）。
  - 忽略所有資料夾事件（移入的資料夾會漏掉內容）。
- 否決（輪替）：
  - 同一圈內新進的先處理：新筆記 3 s 可搜尋，但湧入期間每輪只處理約 30 份（推測是剛寫入的檔案正被防毒即時掃描，lstat 與解析都變慢；未另行驗證），2,500 檔在 500 s 內未處理完；0.39.2 同條件 55 s 清空。
  - 依事件世代排序（實測一開始各檔世代相同，新檔仍排在後面，31.8 s）。
  - 再次變動時更新排序時間（會讓持續變動的檔案永遠排在最後，同樣不公平，且要改佇列語意）。
- 相容：不改 schema 或 status 欄位；非 Windows 平台 fs.watch 多以 `rename` 回報，行為較保守。

## D085：0.39.2 局部更新分批、每批只等一次穩定時間，變動中的檔案延後而不原地退避

- 日期：2026-09-28。使用者驗證 0.39.1 時新建 `Desktop\測試用.md` 搜尋不到，同意開始修正。行為見 SPEC §54。
- 根因（使用者真實工作佇列）：Codex 在 12:12–12:35 解開 `.codex\.tmp\plugins` 2,492 個與 `.codex\plugins\cache` 255 個檔案；局部更新逐一「觀察 → 等 1.5 s → 再觀察」，新檔排在 2,840 筆之後，約需 70 分鐘。持續寫入的檔案還會在同一輪內退避最多約 53 s。
- 決定：
  - 每輪最多 500 筆或約 5 s，輪與輪之間釋放 writer lock、立即接續。
  - 整批先觀察、只等一次防抖時間、再觀察。
  - 變動中的檔案延後到下一輪，連續 5 次後才記為不穩定，與原本退避用盡的結果一致。
- 否決：
  - 縮短或取消穩定等待（會解析寫到一半的檔案，違反 §46.6）。
  - 未變更檔案跳過等待（整批只等一次後效益很小，且會讓事件不再經過 `applyFileUpdate`，改變既有契約）。
  - 讓新事件插隊（先進先出較好理解；分批後整體延遲已降到數十秒）。
  - 平行解析（writer 仍是單一序列，且 parser 記憶體不可控；另案量測）。
- 相容：不改 schema、status 欄位或背景校正；§46.6 的兩次觀察保證不變。

## D084：0.39.1 自動更新在監看與事件層就套用排除規則，防抖設上限

- 日期：2026-09-28。使用者同意開始處理 0.39.0 驗證時發現的自動更新問題（NEXT-TODO）。行為見 SPEC §53。
- 根因：
  - 使用者規則只在完整掃描、背景校正與單一檔案判斷時套用；watcher 與事件路徑只有內建排除。`C:\Users\mains` 下的 `AppData` 有自己的遞迴 watcher，每個事件都 `lstat`＋寫工作佇列。
  - 防抖計時器每個事件都重設，事件不間斷時永不觸發：log 顯示背景校正每 6 小時只跑一批、「剩餘範圍 13；完整：否」一直沒有進展，一般檔案的變更也沒被處理。
  - 局部更新只比對路徑本身，只排除目錄的規則（`/AppData/`）不會排除目錄內的檔案。
- 決定：
  - 排除判斷統一為「任一上層目錄或路徑本身被排除」，與完整掃描不進入被排除目錄的結果一致；監看建立、事件過濾、佇列待辦、局部更新共用。
  - split 模式不監看被排除的直接子目錄；coarse 模式以字串比對在事件入口丟棄，不做 IO。
  - 防抖最長等待 10 倍防抖時間。
  - 新目錄 attach 前已消失時不退回 coarse（實際 log：啟動 2 分鐘後因「新目錄 attach 失敗」變成 coarse，之後整個 `AppData` 又回到監看範圍）。
- 否決：
  - 只加快事件處理（仍然每個事件都做 IO，且防抖仍會被餓死）。
  - 引入原生 watcher 以在 OS 層排除子樹（§46.7 不引入原生依賴；split 模式已能避開被排除的直接子目錄）。
  - 對已排除的舊待辦做全庫清除（改為處理時逐筆 ack，沿用 at-least-once 契約）。
- 相容：不改索引 schema、工作佇列 schema 或哪些文件會被索引；只新增 status 欄位 `excludedEventCount`。

## D083：0.39.0 改用區段儲存＋不記位置 trigram＋提前停止；總筆數預設快速、可切換精確

- 日期：2026-09-28。使用者指出 0.38.0 的索引比文件大好幾倍不合理，要求重新研究、架構可以整個重做。研究見 `research/index-size-2026-09-28/RESULTS.md`，使用者於 2026-09-28 核准總筆數「做成設定切換、預設快速」。
- 根因：0.38.0 一行一列（中位數 31 字元），每段都付 FTS row、`blocks` row、payload↔block 對照的固定開銷；真實資料 172.7 MiB 文字對應約 1,040 MiB。trigram 位置不是必要成本（Tantivy 區段級位置索引只要 0.3 倍）。
- 決定：
  - 原文以約 64K 字元的區段、zstd 壓縮存放；段落位置以偏移表記錄，只有無法推算的段落另存 heading／location。
  - 內容索引改為區段級、不記位置的 trigram 與 1／2 字 token（SQLite FTS5 `detail=none`），沿用 `node:sqlite`，不引入原生模組。
  - 查詢結果改為依排序延遲產生的串流：檔名與標題命中由小索引完整算出，內文命中依排序走訪候選區段、即時正規化驗證，夠用即停。結果內搜尋改為疊在上一層串流上的過濾。
  - 總筆數：快速模式（預設）驗證到 500 份即停，超過時回報下限；精確模式驗證全部。
- 證據（同一份真實快照，225 查詢與暴力比對完全相同）：內容部分 83.6 MiB（0.48 倍）；以文件計，前 20 份 5–59 ms、前 500 份 27–258 ms、精確總數稀有詞 27–158 ms、常見詞 0.5–3.6 s。
- 否決：
  - 直接掃描（0.30 倍，但單執行緒 2–4 s、8 執行緒仍約 1 s）。
  - 16K 區段（索引較大、沒有變快）。
  - sparse grams（索引 8.6 倍、候選幾乎不減）。
  - FM-index／壓縮後綴陣列（大小無明顯優勢；定位約每秒 10 萬個命中；建置記憶體 5–9 倍；靜態結構；JS 無實作）。
  - Tantivy（建置快約 15 倍，但需要個人維護的原生模組；SQLite 已足夠）。
  - 以詞為單位的索引（不能搜片段，不符合 exact substring 語意）。
- 相容：
  - 遷移從 payload docstore 直接轉成區段，不經過 §50 的 block index；舊 index 在遷移完成前走原路徑。
  - 完成後刪除所有舊結構；free pages 超過一半時自動 `VACUUM` 一次，另提供 `compact` 命令。這推翻 D081「不做 VACUUM」：使用者明確在意檔案大小。
- 代價：
  - 快速模式下常見詞的總數是下限。
  - 精確模式與「/ 縮小」的每一層在常見詞上要 0.5–3.6 s。
  - 驗證需要即時 NFKC（實測 437 MB/s）。
- 實作補充（2026-09-28，驗證後）：
  - 真實資料 4.09 GB → 132.8 MiB，73 查詢遷移前後完全相同；但稀有詞第一頁比 0.38 慢（約 150–300 ms 對數十 ms），因為每個候選區段都要解壓驗證。以 1/8 大小換取，並以下列方式降低成本：
  - 區段比對先對整段正規化一次、沒有命中就跳過；純 ASCII 區段只轉小寫並用偏移表對回段落（與逐段比對等價，差分測試覆蓋）。
  - 唯讀連線 `mmap_size` 1 GiB；zstd 解壓輸出緩衝 256 KiB（248 → 353 MiB/s）。
  - 遷移不重寫 0.38 的舊 block 索引（它在遷移期間仍正確），只寫新區段。
  - parser 輸出重複段落序號時整筆寫入失敗（原由 `blocks` UNIQUE 約束保證）。

## D082：0.38.1 外鍵子表一律有索引、遷移記號完成即清除、刪除校正分批提交

- 日期：2026-09-28。使用者在真實 index（約 24 萬份文件）以 `.localdocsearchignore` 排除 `AppData` 後，刪除校正要移除 175,324 份文件，單一交易跑了約兩小時。使用者核准三項修正一起做，先寫 SPEC（§51）。
- 根因（在真實 store 備份上實測）：`index_migration_documents` 的主鍵是 `(version, document_id)`，沒有以 `document_id` 開頭的索引。`DELETE FROM documents` 的 `ON DELETE CASCADE` 因此每份文件都全表掃描約 24 萬筆 marker：每份 35.9 ms，175,324 份約 105 分鐘；補上索引後每份 0.1 ms。0.38.0 的測試 fixture 只有數百份文件，所以沒有暴露這個問題。
- 決定：
  - 所有外鍵子表欄位都必須是某個索引的最左欄位，並以自動測試檢查全部 schema。這遵循 SQLite 官方對外鍵子表欄位加索引的建議，讓同類缺陷在新增資料表時就被擋下。
  - 遷移 marker 只代表進行中遷移的逐文件進度。完成時與 version 同一交易刪除；已完成遷移的 index 由 writer 開啟時清掉殘留 marker。0.38.0 讓每份文件永久保留 `block_index_1` marker，也讓每次寫入都多寫一列，這沒有必要。
  - `removeMissing` 每 1,000 份文件一個交易，批內用集合式 SQL，批次之間可取消並回報進度。刪除校正可由掃描結果重算，所以分批不需要新的 marker；中斷後下次同步會補刪。
- 不分批的操作：`removeRoot`、`moveRootsToTrash`、`clearDocuments` 必須和 root 登錄、`root_trash` 原子完成；補索引後主要成本已消除，因此維持單一交易。
- 參考：Lucene／Elasticsearch 以刪除標記加背景合併處理大量刪除；FTS5 `contentless_delete` 內部也是這種模式。Seekah 的瓶頸不在 FTS5，而在外層的單一大交易與缺少索引的 CASCADE，因此不另建刪除標記層。
- 不在本版處理：遷移遇到 SQLITE_BUSY 時直接失敗（`database is locked`）的問題，另案處理。

## D081：0.38.0 搜尋改用 block 級 FTS5 位置索引（C2-hybrid），Bloom 與文件級 postings 退為遷移期 fallback

- 日期：2026-09-27。依據 `research/search-architecture-2026-09-27/PROTOTYPE-RESULTS.md`：在真實 235,463 份文件 store 的唯讀 snapshot 上，比較 A（現況）、B（payload 級 postings）、C1（block 級 `detail=none`）、C2（block 級 `detail=full`）、D（fts5vocab 最稀有 trigram）五種索引。使用者於 2026-09-27 授權「依你認為最好的做法實作並發布」，本 ADR 據此核准。
- 根因：文件級 postings 只能指出「哪份文件」，候選確定後必須解壓並逐 block 驗證整份文件；成本與候選文件 bytes 成正比，實測約 42 ms／MB（R² 0.98）。固定 1 KiB Bloom 在 64 KiB payload 上已飽和，無法定位文件內位置。
- 決定：content 以 block 為 FTS row（rowid＝`blocks.id`）。
  - 三個以上 code point：trigram `detail=full`，以 phrase 查詢證明連續出現，排序前不讀正文。
  - 一、二個 code point：`detail=none` 的 unigram／bigram token，本身就是精確判斷。
  - 檔名與 heading 各自有小型 trigram／unigram／bigram 表，候選以明文驗證。
  - rank、代表 block、all-terms 覆蓋度、`field`／`sort`／篩選語意完全不變。
  - payload 只在當頁 snippet 與 passages 讀取。
- 證據：2,000 查詢差分與暴力 ground truth 完全相同（含 snippet）。`SPEC.md` 12.8 s→4 ms，`測試` 5.2 s→2 ms，`ing` 39.5 s→0.86 s。kill／resume 與 delete／reinsert 均與 clean build 等價。
- 代價：store 約從 1.37 GiB 增至約 2.9 GiB；每文件刪除成本與 block 數成正比。命中十萬筆以上的查詢（例如單字 `e`）仍約 3 s，瓶頸在結果集大小；total count／top-K 另行決策，本版不改分頁與總數語意。
- 否決：
  - B：常見 ASCII 查詢仍 O(bytes)。
  - C1：≥3 字仍需讀正文，`ing` 仍約 5.9 s。可作為大小預算不足時的備案。
  - D：fts5vocab instance 會把 offset 全部送進 JS，常見詞比原生 phrase 慢約 8 倍。
  - 外部 sidecar：沒有必要承擔部署與跨庫一致性風險。
  - 以 unigram `detail=full` 做短詞：大小是 token 表的兩倍，精確度相同。
- 相容：舊 index 仍保留 D076 路徑，直到 writer 以逐文件 marker（`block_index_1`）完成遷移；唯讀 CLI／MCP 不遷移，未完成時只走舊路徑。
  - 遷移完成時，同一交易刪除 `document_blooms`、`document_payload_blooms`、`search_unigrams`、`search_trigrams`，之後的寫入不再產生它們。
  - fresh index 從不建立這些結構；DB 檔不做 VACUUM，釋放的 page 由新索引重用。
  - 舊路徑程式碼只為遷移期保留，日後可移除。
- trigram 表一律使用 `case_sensitive 1`：實作時的差分測試發現，預設 trigram 會再做一次 case folding，把 `ΣΟΦΟΣ`→`σοφος` 查詢誤配到 `σοφοσreport`（JS 的 final sigma 取決於上下文），prototype 的查詢集沒有抽到這種情況。由於文字與查詢已先由 JS 正規化，關閉 folding 後 phrase 就是精確的 code point 子字串。
- 含 U+0000 的 ≥3 字查詢無法寫成 FTS5 字串（SQLite 會截斷），改以 unigram token AND 取候選後讀正文驗證；舊路徑的同一錯誤一併改走保守 fallback，不再丟出 `unterminated string`。
- 版本：0.37.0 從未發布，因此 0.38.0 同時包含 0.37.0 各階段與本搜尋後端；公司 Windows 驗收仍未回報，不得宣稱通過。

## D080：搜尋效能診斷先補 payload／nested phase 可觀測性，不改搜尋架構

- 日期：2026-09-26。使用者提供的 `測試`／`SPEC.md` trace 顯示 postings 查詢只有毫秒級，主要成本落在 payload lookup、Brotli／JSON 解壓與 exact verification；先證明候選傳遞與 fallback，再決定是否優化，不新增第二套 index、不把猜測當根因。
- 程式實證：`postingDocumentIds()` 的 FTS5 rows 只含 document `rowid`；payload ordinal 來自 `document_payload_blooms`，再由 `document_payload_blocks` 展開到完整 owning block。每次 `streamBlocksFor` 是一個 block mapping query 加一個 payload SELECT，不是每個 payload 一條 SQL；`blockSource()` 在 page materialization 可能再次讀相同文件。
- Search trace schema version 3 保留 `phasesMs` 作 inclusive，新增 `phaseSelfMs` 與 `inclusiveBottleneck`；`bottleneck` 改依 self time。新增 `payloadReadPasses`、`postingPayloadHits`、`expandedPayloads`、`fullDocumentFallbacks`、`filenameOnlyFallbacks`、`blockExpansionRatio`，並明確記錄 `payloadsRead` 可跨 candidate pass／page reread，故不與 `payloadsConsidered` 直接作上限比較。
- 實測 `測試`：111 posting documents → 109 document-Bloom 後 exact；短詞使 payload Bloom 保守回完整文件，107 次實際 full fallback，2 個 filename-only，2,601 payload。page 20 後 2,619 rows／125 pass，新增 18 rows 來自 page materialization reread。實測 `SPEC.md`：144 documents、4,954 summaries、4,640 payload candidates、38 filename-only、106 pass、4,638 rows、31 個 block expansion，self bottleneck 為 payload lookup。
- 本批只修 diagnostics／回歸與文件；不改短詞 fallback、block reconstruction、SQL batching 或 payload storage。後續若要降低成本，必須以 schema 3 metrics 先建立可重現基線。
- 2026-09-27 補：保留既有搜尋行為，增補 SQL prepare／execute、metadata／mapping rows、ranking／snippet reads、unique／duplicate、bytes、Brotli／JSON 與 exact text 計時。實際 235,463 文件的四查詢證據寫入 `search-payload-profile-2026-09-27.json`。`SPEC.md` 的 4,638 payload 只有 31 個為 expansion、無 duplicate；lookup 主要為 1,652,374 metadata rows 與 1,442,468 mapping rows 的查詢／JS materialization，不是每 payload round trip。優先提案是減少 metadata／mapping 資料量與改善既有候選選擇性；未核准前不實作、不截斷完整 block，也不新增索引。
- 2026-09-27 實作補充：依 `metadata-mapping-overfetch-optimization-spec.md` 完成兩條 statement-local selected CTE。Q1 只回 selected metadata、以 `s.block_id AS id`／`ordinal IS NULL` 保留 missing marker；Q2 以既有 `(document_id, block_id)` index 求完整 owning-block payload closure；selected Map 在 payload lookup boundary 後建立以保持 timing 可比。新增三個 trace counters，未新增 index／schema／cache。256-block fixture metadata 256→2、first page 256→4；同 snapshot SPEC.md metadata 1,652,374→1,442,468、standalone mapping 1,442,468→0、payload 4,638 不變；第二組完整 3＋10 benchmark 的 result hashes 相同，payloadLookup p50 0.804×、wall p50 0.889×，測試／稀有／不存在詞 p50／p95 gates 通過。報告見 `docs/metadata-mapping-optimization-2026-09-27-*.json`；本機證據不等於公司 Windows 驗收。

## D079：0.37.0 工作台索引改由 worker 執行並持久化可恢復進度

- 日期：2026-09-26。使用者回報第一次索引在約 85%／86.86% 停住、停止後重跑仍停住、重開 `seekah-ui.cmd` 後狀態變未知並在 99.52% 卡住。根因是 Workbench 原本在 HTTP Node event loop 直接執行 `sync()`；大型或慢 parser／SQLite 寫入會阻塞 `/api/index-status` 與停止要求，而進度只存在程序記憶體，頁面 reload 也沒有持續輪詢。
- 手動 Workbench 索引現在由 `worker_threads` 執行，主程序只負責 API、狀態與控制；每個已提交文件仍由既有 `sync()` 交易保留，並以索引資料目錄內原子替換的 `indexing.json` 保存狀態、進度、目前路徑與摘要。這不是第二套 parser、資料庫或同步語意；檔案只保存 metadata，不保存正文，並列為索引產物。
- 新程序若讀到前一程序 `running`／`stopping` 但 PID 已死亡，改顯示「已中斷」而不偽造完成；普通索引會依既有 metadata 略過已提交文件、繼續檢查未完成部分。狀態檔只作診斷／恢復提示，寫入失敗不能讓索引本身失敗。
- Workbench 頁面在索引中每 750 ms 讀取狀態，保留最後成功狀態以避免暫時 SQLite busy／locked 變成「未知」；停止先送取消，兩秒仍未離開安全點才終止 worker。這不能中斷單次不可取消的 parser 內部運算，但能恢復 HTTP 控制面，下一次索引依已提交交易接續。

## D075：工作台搜尋、更新與拖曳失敗皆使用真實可控狀態

- 日期：2026-09-26。工作台搜尋欄位、根目錄、格式、解析狀態與排序皆由 server 搜尋契約套用，不保留只改文字的假控制項。相關性固定為檔名完全符合、檔名包含、標題、內容，同級以修改時間再路徑排序。
- 工作台啟動不再暗中執行完整校正。「完整校正」仍列舉根目錄並比較 metadata，只解析新增或變更文件；使用者可中止目前同步，server 等待 write store 關閉後才允許根目錄刪除。日常增量更新沿用既有 detached `autoupdate`，由設定頁明確啟停。
- 拖曳不支援格式或 parser 失敗時，server 仍建立本次 session 的穩定文件 ID 與狀態，因此可依檔名搜尋並移除；沒有正文的項目不能加入上下文。臨時文件不寫入永久索引。

## D074：0.37.0 工作台採 desktop-only Paperless-inspired clean cutover

- 日期：2026-09-26。依使用者最新 UI 契約，正式工作台以 Paperless 的資訊層級作參考，完全取代舊三區 GUI；不把 Paperless 假資料、品牌或外部服務帶入 runtime。
- `src/workbench-app.ts` 採固定桌面 shell：最小 1180 CSS px、58 px topbar、約 246 px sidebar；中央文件頁支援 Preview list／Table，明細 route 使用左右獨立捲動，已選上下文改為固定 overlay drawer。手機版與底部導覽不實作。
- 所有狀態由既有 loopback API 提供；GUI 不顯示 Provider、model、API Key、AI question、送出或 answer。`/api/preview` 僅重新驗證並產生可複製的本機上下文。
- 舊固定第三欄、舊 route、假資料、unsafe HTML、瀏覽器儲存與外部資源均不保留。此決策只改 GUI；CLI／TUI／MCP 與既有 provider backend 契約維持。

## D073：0.37.0 工作台根目錄刪除採垃圾桶流程

- 日期：2026-09-26。使用者要求可勾選已索引目錄、全選、確認刪除、下次不再提醒、設定重新開啟提醒，以及垃圾桶。
- UI 刪除只移除索引資料，不刪來源資料夾或檔案；刪除的根目錄 metadata 進入 SQLite 垃圾桶。還原不保存舊索引快照，而是重新驗證來源並重新索引；成功後移除垃圾桶項目。
- 刪除提醒預設開啟，偏好保存於索引 metadata；確認對話框可關閉後續提醒，設定頁可再次開啟。垃圾桶永久刪除只移除垃圾桶 metadata，不操作來源路徑。

## D072：0.37.0 工作台加入資料夾改用本機資料夾選擇器

- 日期：2026-09-25。使用者要求「加入資料夾」改為按鈕開啟資料夾選擇器，不要求使用者手動輸入完整路徑；選取後必須再按確認才開始索引。
- Windows 工作台由 loopback server 透過目前使用者的 PowerShell `FolderBrowserDialog` 取得選取路徑；瀏覽器先顯示唯讀選取結果，只有「確認並建立索引」才呼叫既有索引入口。
- 取消選擇或未確認不送出索引；非 Windows 若沒有原生選擇器則清楚提示並保留 CLI `index <資料夾路徑>` 入口。臨時文件的瀏覽器選取仍是另一個只留工作階段的流程。

## D070：0.37.0 登入啟動採目前使用者 Startup 捷徑

- 日期：2026-09-25。`autoupdate startup enable|disable|status` 僅在 Windows 實作；預設關閉，enable 不立即啟動 daemon，disable 不影響現存 daemon。
- enable 在目前使用者 Startup 資料夾建立產品專屬 `.lnk`，固定指向目前 `node.exe` 與編譯 CLI，透過 `--data-dir` 綁定實際索引資料目錄。使用 PowerShell COM 並以 encoded command／環境變數傳遞路徑，不拼接未跳脫 shell 命令。
- 以旁邊的產品擁有權 marker 驗證可更新或刪除的捷徑；同名非本產品檔案拒絕覆寫，disable 不刪除。政策拒絕、路徑搬移與非 Windows 平台明確回報，手動 `autoupdate start` 保留。

## D071：0.37.0 all-terms 以必要長詞 Bloom 做文件候選縮減

- 日期：2026-09-25。all-terms 的文件級 Bloom 判定改為所有不在檔名中的必要長詞都必須可能存在；缺任一長詞即可安全排除，全部短詞仍完整精確掃描。
- payload 級仍只在沒有短詞時縮小候選 payload；混合長短詞必須讀取完整文件 payload，避免長詞與短詞分散時 false negative。缺少或舊版 Bloom 一律保守放行。
- filename-only 命中不受正文 Bloom 排除；排序、精確判定、snippet、passages 與 phrase 模式不變。測試涵蓋中文／英文、檔名命中、跨 payload、短詞與缺詞。

## D069：0.37.0 背景校正採可接續批次並釋放 writer lock

- 日期：2026-09-25。依 SPEC §46.8，daemon 啟動與週期完整校正不再以單次整根 `sync()` 長時間持有 writer lock；改由獨立工作狀態庫保存 generation、directory frontier、已檢查數、失敗 scope 與本輪待確認的事件世代。
- 每批最多處理 500 個 entries 或約 250 ms，批次結束即釋放 writer lock；下一批前先處理已落盤事件，連續事件時至少每 5 秒讓一批校正執行。目錄會重列並依 generation 去重，不把 OS iterator 或排序 offset 當成可靠 cursor。
- 只有成功列舉完成且沒有失敗或較新事件的 scope 才允許 `removeMissing`；失敗、離線、尚未完成或交錯事件的範圍保留既有索引。工作庫與主索引仍沒有跨庫原子交易，採至少一次重播與冪等更新。
- 手動 `index`、前景 `watch` 及既有局部事件契約不變；本決策不加入 USN、Service、提權或 parser selection 變更。

## D068：0.37.0 工作台要能加入新的索引根目錄

- 日期：2026-09-25。使用者確認已有索引時，也要能在 UI 直接加入新資料夾，不必改用 CLI。完整行為見 SPEC §46.0 與 §46.11。2026-09-25 使用者決定開工；CURRENT 已切到 0.37.0，階段 7 已實作。
- 重用既有 `POST /api/index` 帶 `root`、`sync()` 與多根合併／重疊拒絕；不另建 parser、資料目錄或索引寫入入口。開啟工作台仍只同步已登錄根，不得把未確認輸入當新根。
- 索引狀態頁在 `available` 時提供「選擇資料夾」與「確認並建立索引」兩步按鈕；選取結果先顯示但不開始索引。進行中同步必須可見拒絕，禁止默默吞掉第二次請求。daemon 若已在跑，沿用動態 roots 刷新，不暗中 start。
- 臨時文件拖曳仍不進入永久索引。GUI 提供根目錄多選刪除、全選、確認提醒與垃圾桶；不刪來源資料，還原以重新索引完成。仍不提供一次選取多條新路徑、整碟建議或 GUI 內 autoupdate 開關。

## D067：雙擊啟動自行建立相依並顯示索引進度

- 日期：2026-09-24。使用者要求不必先開終端執行 `npm ci` 或 `index`。`seekah-ui.cmd`／`seekah-ui.command` 在命令視窗顯示進度；缺少 `node_modules` 或 `dist` 時自動安裝相依，完成後才開工作台。
- Windows 啟動器必須自己找出 `node.exe`（略過 Microsoft Store 別名），並用同一份 Node 執行 `npm-cli.js`；不得 `spawn npm.cmd`。`.cmd` 使用 CRLF。

## D066：GUI 回到本機索引與複製，不提供聊天 Provider

- 日期：2026-09-24。使用者確認目前沒有聊天助手需求；GUI 隱藏 Provider／model／Key、外部送出與回答面，精確上下文只重驗後複製至本機剪貼簿。CLI／MCP 不變。
- 工作台開啟後背景同步既有根目錄；使用者可按「更新索引」。尚無索引時必須由使用者在受 token、Host／Origin 保護的 UI 明確輸入第一個根目錄，背景工作重用既有 `sync()`，不另建 parser、資料目錄或同步核心。

## D065：GitHub 儲存庫改名為 seekah，不觸碰相容識別

- 日期：2026-09-24。使用者要求統一產品的 GitHub 名稱；遠端儲存庫由 `ododuuu/quiet-index` 改名為 [`ododuuu/seekah`](https://github.com/ododuuu/seekah)，本機 `origin` 同步更新。
- 此改動只影響 GitHub repository slug 與 clone URL。依 D057，LocalDocSearch 資料目錄、`LOCALDOCSEARCH_DATA_DIR`、ignore、IPC／MCP 識別、認證 header、`docsearch` 相容入口、schema、parser selection 與 CLI／MCP 行為均不變。

## D064：GUI 文件操作以 stable reference 交給既有安全服務，時間雜訊不進工作流

- 日期：2026-09-24。使用者要求命中預覽可直接選擇開啟檔案，並移除無助於選擇的 ISO 時間；新增 `POST /api/document-action`，只接受 `{reference, action:"open"|"reveal"}`。
- 伺服器重用 `actOnDocument`，不接受瀏覽器 path，不另做 OS launch 或放寬 root containment、連結、一般檔案及可讀性檢查。GUI 以完成或安全錯誤訊息回報，不把送出請求誤稱外部程式已顯示。
- GUI 省略搜尋、狀態與 context 文字中的建立／修改時間；`prepareContextTool` 的預設仍保留時間，確保 CLI 與 MCP context 契約不變。新增 `docs/USER-GUIDE.md` 作為產品操作入口。

## D063：TUI 改採 Claude Code 式 session-local 單欄 workflow

- 日期：2026-09-24。使用者核准把既有 OpenCode 式 tab／首頁面板改為單欄時間序 transcript；D057 的品牌、安全、鍵盤與交接決策保留，視覺方向由本決策及更新後的 SPEC §45.8 取代。
- `runTui()` 以最多 12 筆 in-memory union 記錄真正完成的 prompt／search／selection／context；退出或索引版本改變即清除，不落盤 query、結果、路徑或 view state。
- renderer 使用真實搜尋總數、選取數、passage 數與 UTF-8 bytes；結果 card 保留三行、`›` active 與 `[x]` selected。固定 composer 與 message 分列，80×24 裁掉最舊 block，120×40 顯示更多歷史。
- 保留 decoder、reducer、slash commands、SearchSession、context 重驗、剪貼簿 `yes`、open／reveal、read-only store、raw mode、訊號與 alternate-screen cleanup。不新增 LLM、agent、Claude Code runtime、Provider、daemon 或持久狀態。
- `docs/design/seekah-tui.html` 只使用明示的示範資料，供 120×40／80×24 外觀審閱；不把 agent activity、AI 回答、daemon 或假索引統計列為產品需求。


## D059：核准 GUI 稿落為 0.36.2 規格，優先於 0.37.0

- 日期：2026-09-24。使用者要求照 D058 設計稿寫 SPEC，再由 Luna Max 實作。以 SPEC §47 定義 0.36.2 相容 GUI 改版；0.37.0 既有規劃暫緩，不混入本批。
- 正式工作台保留全部現有能力，尤其原型缺少的 Key／model 設定與 AI 回答；補受保護的唯讀索引狀態 API，其餘重用既有搜尋、上傳、預覽與 Provider。
- 原型的假 bytes／事件／文件計數不能成為實作。容量只接受 server 預覽 bytes，未知如實顯示；命中預覽不是全文。只複製不要求 Key，外傳仍需 HMAC、來源重驗與明確同意。
- 固定交接入口改為 0.36.2，提供指定給 Luna Max 的實作 prompt。本工具介面無模型切換功能，沒有宣稱已切換或已啟動；規格提交不改 package、程式或發佈包。

## D062：0.36.2 正式 GUI 只補狀態讀取，維持本機安全邊界

- 日期：2026-09-24。依 SPEC §47 完成正式三區工作台；外觀原型不作資料來源，搜尋／parser／context／Provider 服務維持單一契約。
- GUI 新增的後端面只有受 token、Host／Origin 保護且 `no-store` 的 `GET /api/index-status`；它使用既有唯讀 `IndexStore`／`indexStatus`，不掃描、升級、寫入索引或啟動 watcher。
- 精確 bytes 只採 server context 預覽，選取／Provider／model／問題／目的地改變即失效；AI preview HMAC 單次消費，`auto` 只在 quota／rate limit fallback 一次。Key、文件與查詢不持久化。
- 本批不修改 TUI、不實作 0.37.0，不改既有資料路徑、schema、parser selection、MCP／IPC 識別或 LAN 邊界。


## D058：本機工作台 GUI 採三區工作流設計，先交互動稿

- 日期：2026-09-24。使用者認為 GitHub 專案目前的圖形介面仍不理想，要求先設計新版並推送供審閱。
- 現有 0.35.0 工作台把搜尋、拖曳、Provider、確認、上下文與回答拆成等權卡片，功能入口完整但主流程不清楚。新版設計採左側導覽、中央搜尋／結果與右側上下文三區；選取狀態、臨時文件與容量持續可見。
- Provider、問題、同意與送出延後到「檢查精確上下文」步驟。這是漸進揭露，不放寬既有 loopback token、Host／Origin、防外傳、HMAC preview、20 份與 256 KiB 契約。
- 視覺沿用 Seekah 核准的石墨／暖灰／青綠，減少卡片與高飽和 SaaS 風格；桌面 1120 px 以下改用上下文抽屜，行動版改為底部導覽。
- 本次只新增 [設計說明](design/SEEKAH-WORKBENCH.md) 與 [互動稿](design/seekah-workbench.html)，使用示範資料且不呼叫索引或 Provider。尚未改動 `src/workbench-app.ts`，不代表正式 GUI 已實作、測試或發布，也不提前開始 0.37.0。


## D057：Seekah 品牌、核准 TUI 與固定交接中心

- 日期：2026-09-23。使用者正式選定 Seekah，並核准先前 OpenCode 風格的低噪音 TUI 設計；要求下一版規格及固定位置的 AI handoff。
- 產品／可見標題改名 Seekah，package／新命令 seekah；保留 docsearch 入口。儲存路徑、環境變數、ignore、IPC、MCP URI／註冊與認證 header 保留舊識別，不為品牌搬庫或更動資料格式。
- 0.36.1 納入完整核准 TUI，設計固定 docs/design/SEEKAH-TUI.md 與 seekah-tui.html；HTML 僅示範，新增標題不算 UI 完成。沿用 Node.js／TypeScript，不引進 OpenCode runtime。
- 0.36.1 correctness／profile 範圍不變；0.37.0 watcher／all-terms 依 D055／D056，不能為 UI 偷提前實作或顯示假 daemon 狀態。
- 交接統一 docs/handoff/：README 為永久中心，CURRENT 指向進行中版本，版本檔保留。docs/HANDOFF.md 只作舊連結與歷史，AGENTS 隨之更新。
- 本次不升 package 版本、不發布新版本；GitHub repository slug 仍為 quiet-index，產品更名不聲稱已改遠端網址。新封裝使用 Seekah-VERSION.zip，歷史包不重命名。

## D056：0.37.0 在普通權限下擴充既有 watcher，持久化工作並分批校正

- 日期：2026-09-23。使用者明確確認公司電腦不能有管理員權限，並要求將 watcher 討論寫入規格與交接。本決策取代 D055 的 USN RFC 候選安排；0.37.0 不採 USN／raw volume、Service 或提權。SPEC §46.6～§46.10 定義實作細節。
- watcher 已於 0.31.0 存在，`index` 人工測試走的是完整校正，不能據此判定 watcher 不存在或失效。先驗收現有事件局部更新，再擴充同一引擎；不建立第二套 parser 或同步核心。
- 使用獨立本機 SQLite 工作狀態庫保存有界 queue 與 scope generation；事件落盤後接受，索引提交後 ack。跨庫採至少一次重播與冪等操作，新世代不得被舊 ack 清除。工作庫失效標記未確認，重啟 gap 校正保護尚未落盤的窗口。
- 監看拆為 root 直屬項及子目錄 scopes，handle 有界且可退回粗 scope。只在能證明通知來源時局部補掃；Node 未暴露的 OS overflow 仍靠週期校正兜底，不能宣稱所有遺漏都能即時偵測。
- daemon 啟動／週期校正改為可接續的背景批次，維持 scope-aware deletion 與事件世代檢查；搜尋可讀已提交索引，未確認範圍如實顯示。降低前景等待不代表少做必要檢查，更不代表停機期間免掃描。
- Windows 登入啟動為明確 opt-in 的使用者 Startup 捷徑，預設關閉；不安裝 Service，不改全機設定。公司政策不允許時保留手動 start；此版僅規劃，尚未註冊任何啟動項。
- Paperless 收件匣與 ripgrep 即時文字搜尋只供設計參考，不移動公司原檔、不重做格式 parser。0.36.1 先完成，0.37.0 分階段提交驗證，package 仍為 0.36.0。

## D055：0.37.0 以既有背景局部更新作日常主路徑，USN 先過 RFC 門檻

後續更新：USN 候選與可選 queue 的原規劃已由 D056 取代；以下保留決策歷史，現行行為以 SPEC §46 為準。

- 日期：2026-09-23。公司 0.36.0 已證明未變更文件不再 parse，但每次普通 `index D:/` 仍發現約 30 萬檔並花 2～4 分鐘。這不是 parser regression，而是 `index` 作為完整 reconciliation 必須枚舉 filesystem 的成本；單純把 scan 微幅加速不能宣稱解決日常增量。
- 0.31.0 已有可用基礎：watch／autoupdate 的檔案事件走精確更新，目錄事件走最小可信子樹，未知事件／overflow 才全量校正。0.37.0 先在公司 Windows 驗證、補觀測並把 `autoupdate start` 定義為初次索引後的日常路徑；`index` 保留為立即完整校正，不能改成可能漏失離線變更的假快速模式。
- 背景程序不是 Windows Service，也沒有開機自啟；程序未執行時 `fs.watch` 沒有事件。下次 start 的完整 reconciliation 是目前正確補回方式。已觀察事件可用有界持久 queue 改善 crash recovery，但不能把它描述成 downtime change tracking。
- NTFS USN Change Journal 僅作 RFC 候選。普通使用者權限、公司政策、Node 相容層、volume／journal checkpoint、rename／delete、wrap／reset／gap 及非 NTFS fallback 未逐項證明前不得直接實作，也不得讓管理員權限或 NTFS 成為產品必要條件。
- `--all-terms` 的程式根因另已定位：短詞使文件 Bloom 永遠可能且停用 payload candidates，連帶浪費長詞 pruning。all-terms 可要求所有 Bloom 可表示的必要長詞皆通過以安全淘汰文件；含短詞的剩餘文件仍需全文精確核對，保持結果集合與排序語意，不接受 false negative。

## D054：0.36.1 先修掃描刪除邊界、Windows 系統範圍與真正可操作的 TUI

- 日期：2026-09-23。使用者完成公司 Windows 0.36.0 人工測試，確認舊索引沿用、一次性文字升級只發生一次，且約 299,530 份未變更文件零重解析。這些行為視為已驗證基線，不重新設計 parser selection。
- 現行 scanner 只把 `$RECYCLE.BIN`／`System Volume Information` 當提示；0.36.1 將它們改為 Windows volume root 的精確內建排除，並同步套用於完整 scan 與 live update。程式不修改使用者 `.localdocsearchignore`，相似名稱與巢狀普通同名目錄仍可索引。
- 現行 sync 以整體 `found.errors.length === 0` 決定是否推論刪除，導致一個不可讀系統 subtree 保護整根。改採最小 failed scope：失敗 subtree 保留，正常 sibling 可刪；root 不可讀仍保護整根。這是在維持「掃描錯誤不誤刪」前提下縮小保護範圍，不接受以忽略錯誤或先清索引換取刪除成功。
- TUI 畫 checkbox 卻仍依賴 readline 命令，屬互動模型不一致。0.36.1 引入結果游標與 focus，支援方向鍵、Space、Enter、PgUp／PgDn、Esc／左鍵與 Tab；slash commands 保留 fallback，context 的來源重驗、完整預覽、逐字 `yes` 與上限不變。
- CMD 使用 PowerShell `$env:` 造成 profile 父目錄不存在不是核心 bug；只改善 shell-specific 文件及父目錄錯誤，不自動展開任意變數、不建父目錄、不覆寫輸出。0.36.1 不承諾改善 30 萬檔完整 scan，也不處理公司 parser errors。

實作紀錄（2026-09-23，Codex）：scanner／store／sync 已採最小 protected scope，Windows 系統目錄判定已由完整與局部更新共用；profile 診斷保留 exclusive-create 安全邊界；TUI 已依核准稿重做首頁、三行結果、預覽、選取、context、命令與真實 status 畫面。CLI 使用可處理分段 CSI／單獨 Esc／UTF-8 的 raw input decoder、事件 queue 與集中 terminal cleanup，並保留 slash fallback／context `yes`。本機缺陷回歸、80×24／120×40 fixture 與真實 PTY 通過，package 升至 0.36.1；公司 Windows 人工驗收仍待回報。證據見 `0.36.1-VALIDATION.md`。

## D053：0.36.0 優先恢復索引增量效能與可靠的終端操作

- 日期：2026-09-23。使用者回報 0.35.0 舊索引疑似重做、10 分鐘僅 135 份，以及 TUI 退出與 help 問題，指定下一版為 0.36.0；Codex 負責 SPEC §44／交接，Grok 負責實作。本次不升 package、不改程式、不發佈套件。
- 已在 0.35.0 真實 macOS PTY 重現 Ctrl+C／EOF 未 settle readline question、exit 13 與 alternate screen 未還原；`/quit` 正常。假 IO 測試全綠不足以驗收終端生命週期，必須加入編譯 CLI 的 PTY 回歸與尺寸／中文互動驗證。
- 保留既有資料位置與逐文件解析版本 1。升版或程式目錄變更本身不能要求 rebuild；舊文字必要升級、新格式補解析、error 重試、來源變更與未變更略過須可分辨。解析成功標記與內容原子提交，已完成者重跑不再解析。
- 公司慢速根因尚未量測。先提供階段計時、更新原因、慢檔提示及不含路徑／正文的本機 `index --profile <新檔案>`，並建立大型舊庫替換基線；優先檢查 SQL 外鍵查找、mapping 索引、刪除順序及 prepare 熱點，但不提前認定原因。必要輔助索引採 writer lock 下可重入遷移，唯讀仍可使用舊庫。
- 保持正確性與資料耐久性，不以改排除範圍、關閉外鍵／durability、降低解析期限、略過正文或無界多工換效能。效能門檻包括無關 mapping 放大時的替換成本與無變更增量回歸；不將前 135 份的平均速度外推全庫 ETA。
- TUI 採單一命令登錄、明確 `/help`／退出容錯、Tab 補全、固定輸入／狀態列及可翻頁視圖；保留純 Node 與共用搜尋／context。退出碼定義為 quit／EOF 0、SIGINT 130、SIGTERM 143；全流程清理必須可重入，context 取消不得複製。
- 本機修正與公司 Windows 驗收分開記錄。沒有公司複驗前，最多宣稱已修本機可重現問題／熱點，不宣稱已解決公司全部效能問題；本版優先於 NEXT-TODO 的 Provider 與 Web UI 擴充。

實作紀錄（2026-09-23，Grok）：規劃當下不升 package 的句子仍然有效，指的是規格提交本身。程式完成並通過本機門檻後，package 與 lockfile 才升到 0.36.0。本機已證實 TUI question 未 settle，以及缺 `block_id` 索引時大型無關 mapping 會拖慢單檔替換；公司 10 分鐘／135 份仍不是已證根因。證據與未解項見 `0.36.0-VALIDATION.md`。

## D052：0.35.0 以受保護的 localhost 工作台補足拖曳與 Provider 連線

- 日期：2026-09-23。使用者指出 0.34.0 尚缺拖曳檔案及 AI 帳戶／API 操作面。MCP App sandbox 適合已索引內容，但不應為大型任意檔案新增 base64 MCP 工具；因此另加只綁 `127.0.0.1`、亂數 token、嚴格 Origin／Host 與 CSP 的 `docsearch ui`，和既有 TUI／MCP 並存。
- 拖曳檔案沿用正式 parser，原檔只在權限受限暫存目錄短暫存在，正文只留在程序記憶體且不自動加入永久索引。工作台同時重用 `searchDocuments`／`prepareContextTool`，不建立第二套搜尋語意。
- API Key 可由環境變數或本次 UI 工作階段輸入；都只在 server-side 記憶體使用，不持久化、不回傳。遠端 endpoint 固定為 OpenAI／xAI Responses API，不做任意 proxy。送出前以 HMAC preview id 綁定 provider、model、問題與實際 context，避免使用者確認後內容被悄悄替換。
- 官方帳務文件已確認 ChatGPT 與 OpenAI API 分開，Grok 與 xAI API 也分開。第三方程式沒有可合法重用消費訂閱的通用登入流程，因此本版不做 cookie／密碼代登或假 OAuth；UI 明確說明必須使用各平台 API Key 與 API billing。
- 遠端 AI 是選配；搜尋、拖曳解析、預覽與複製仍可完全離線。只有明確按下確認送出才傳遞預覽中的文字，且公司文件仍受公司政策限制。

## D051：0.34.0 以標準 MCP App 把按鈕化選取接到既有唯讀工具

- 日期：2026-09-23。使用者要求 0.34.0 成為朝最終目的的大版本：AI Host 內可直接搜尋、勾選並把選定片段加入上下文。MCP 與按鈕介面不衝突；MCP 是能力與資料邊界，MCP App resource 是同一能力上的人機操作面。
- 採公開 MCP Apps `ui://` resource、`text/html;profile=mcp-app`、`_meta.ui.resourceUri`、`tools/call`、`ui/update-model-context` 與 `ui/message`。`open_search_app` 只負責展示，三個資料工具保持 headless 可用；Codex、ChatGPT 或其他 Host 若未支援 UI，仍能用 MCP 工具或本機 TUI。
- UI 自足且零外部資源，所有回傳文字以 DOM 安全 API 顯示；最多人工選 20 份。只有明確按鈕才更新 model context，只有另填問題並按送出才產生 `ui/message`，不做整庫自動灌入或背景對話注入。
- 新增 `docsearch setup codex` 作官方 CLI 的安全包裝：先檢查同名設定，相同即冪等，不同則拒絕覆寫；`--dry-run` 供公司電腦先核對。另加唯讀 `doctor`，但不藉診斷建立／升級索引或修改 Host。
- 仍維持本機 stdio，不開 HTTP。ChatGPT 網頁不讀本機 Codex config；遠端 plugin／tunnel 會改變公司文件信任邊界，0.34.0 明確不做。

## D050：0.33.0 以唯讀 stdio MCP 串接 AI，TUI 保留人工選取

- 日期：2026-09-22。使用者確認搜尋核心完成後，下一目標是讓 AI 能接用，同時保留「選擇後才加入上下文」的關鍵操作。MCP 與人選介面不是互斥方案：MCP 定義能力與資料邊界，TUI 或支援 MCP Apps 的 Host 負責人機選取。
- 第一版採本機 stdio，不開 HTTP／localhost port。依官方 MCP TypeScript SDK 的 server package 實作，stdout 僅承載 JSON-RPC。提供 `search_documents`、`prepare_context`、`index_status` 三個唯讀工具；不提供索引寫入、根目錄變更、open／reveal 或任意讀檔。
- `prepare_context` 必須收到 1～20 個明確文件代碼，重用既有 context 的搜尋、來源核對、passage 與 256 KiB 契約。MCP 回傳內容可直接成為該次工具呼叫的模型上下文，但沒有「全選」或整庫自動匯入。
- 0.32.0 TUI 加入選取籃、完整預覽與逐字 `yes` 後複製，作為所有終端都能用的人選介面。MCP Apps 的滑鼠 UI 可沿同一工具契約追加，但不把尚未被所有本機 Host 穩定支援的嵌入 UI 當作 0.33.0 核心依賴。
- 不自動修改 Codex／其他 Host 設定，只提供明確註冊命令與專案設定範例。ChatGPT 網頁不讀本機 Codex stdio 設定，若日後需要網頁端使用，須另案評估遠端部署與公司資料政策，不能把本機 server 暴露出去。

## D049：0.32.0 先交付純 Node 終端互動介面

- 日期：2026-09-22。使用者要求 0.32.0 同版加入類似 Claude Code 的終端互動介面，並允許參考 OpenCode。採用其「CLI 管程序生命週期、TUI 與核心分層、slash commands、鍵盤導向」概念，但不複製元件程式碼。
- 不採 OpenCode 的 Bun／Zig／OpenTUI 技術堆疊，避免破壞既定 Node.js 22、免額外編譯與公司 Windows 可攜方向。以 ANSI alternate screen、Node readline 與既有 `SearchSession` 建立唯一 TUI 實作；索引、搜尋、open／reveal 邏輯仍只有一份。
- 公開入口為 `docsearch tui`，不改無參數顯示 help 或任何既有非互動命令。第一版涵蓋搜尋、全部詞、翻頁、結果內縮小、撤回／重設、open／reveal、status、roots 與 help；context／autoupdate 保留原 CLI，待實際使用證明需要再整合。
- 不開 localhost port、不載入遠端頁面、不送出文件或索引。未來若需要滑鼠、寬表格或文件預覽，才在同一核心上另行規格化本機 Web UI。

## D048：0.32.0 加入 XLSM／ODT／RTF／CSV 正文解析

- 日期：2026-09-22。使用者確認四種格式若尚未支援，就列為 0.32.0。程式盤點證實 `.xlsm`、`.odt`、`.rtf`、`.csv` 尚未登錄正文 parser；MSG 內部的 RTF 還原不能視為獨立 RTF 檔案支援。
- XLSM 共用 XLSX 的 OOXML 試算表解析，不執行或索引 VBA／ActiveX／外部連線；公式只採現有 cached display value。ODT 解析 `content.xml` 的可見文字與安全連結，不載入外部資源。獨立 RTF 抽出 MSG 已用的安全核心，排除 object／pict／metadata。CSV 採逗號與 RFC 4180 相容 quoting，不自動猜 delimiter。
- 四種格式沿用本機處理、100 MiB 上限、增量交易、背景局部更新、嚴格 UTF-8 失敗後 Big5 與檔名備援。舊 unsupported 文件下一次普通 index 或背景完整校正重試，不要求 rebuild。
- 真實 PDF／PPTX／XLS 問題需要公司檔案才能定位，統一放入 `docs/COMPANY-WINDOWS-DIAGNOSTICS.md`，只允許公司電腦上的 Codex 讀取；原檔與內容不得提交或外傳。

## D047：0.31.0 背景自動更新與版本命名

- 日期：2026-09-22。使用者將背景自動更新定為下一版重點，規格見 SPEC §39。0.31.0 起以產品版本號作唯一里程碑名稱，不再新增 M 編號；歷史 M 名稱保留，不回溯改名。Grok 已完成本機實作。
- 提供普通使用者明確啟動的 `autoupdate start|status|stop`。背景 Node.js 程序在原終端關閉後存續，但不安裝 Windows Service、不要求管理員、不做重開機／登入自啟。重開機後誠實回報未執行，下次 start 再完整校正。
- 同一索引只容許一個持續更新實例。以本機 named pipe／Unix socket、隨機 token、instance ID 與獨立 lease 作為健康查詢、身分驗證與單例依據；PID 與狀態檔只是診斷資訊，不可單獨用來停止程序。待機時不持有索引 writer lock。
- 事件只是提示：一般變更做精確檔案或最小可信子樹更新，不再每個事件掃全根目錄；未知檔名、溢位、ignore 變更或無法安全判定刪除時改排完整校正。每根啟動後及預設每 6 小時完整增量校正，以修復 `fs.watch` 可能遺漏。
- 使用者實測 358,102 檔案完整同步約 2 小時 21 分；因此 0.31.0 必須先抽出局部更新服務，不能把現有 watch 的每事件全根 `sync()` 包成背景程序就宣稱完成。但仍保留定期完整校正作為正確性安全網。
- 編碼決策維持 0.30.0：BOM／XML 宣告優先，無訊號時整份嚴格 UTF-8，失敗才整份嚴格 Big5。統計編碼偵測只能給概率且可能誤判，不符合本專案精度優先；也不將目錄編碼設定負擔轉給使用者。

## D046：M27 原始碼文字、Big5 與可觀測性

- 日期：2026-09-22。使用者確認下一版加入 java／sql／js、Big5、簡潔進度及容量觀測，class 不需正文支援；規格見 SPEC §38。Codex 負責規格，Grok 已完成 0.30.0 實作。
- 以遠端 0.29.1 為基線，保留已交付搜尋與根目錄功能。文字採 BOM／XML 宣告優先，缺明確訊號才嚴格 UTF-8 失敗後回退 Big5；明確編碼解碼失敗要回報，不猜測修正。單次讀檔、一次解析與寫入，效能以實測區分解碼和新增正文成本。
- 逐文件解析版本使舊成功但可能亂碼的文字也能普通 index 更新，中斷後接續；僅 unsupported 重試不足以完成升級。錯誤重試與成功未變更略過保持區別。
- 文件處理進度固定兩位小數，分母包含全部已發現文件，修正未變更分支計數；預設節流與彙總，詳細錯誤由 status --issues 查詢。status --types 統計 metadata，容量顯示檔案長度合計，全部唯讀。
- 1113.18 MiB 已獲使用者接受，先觀測新格式影響；不自動 VACUUM，不改系統目錄排除範圍。當時另列的背景自動更新管理現已進入 0.31.0／D047；具體 PDF／PPTX 修復仍為後續待辦。0.29.1 人工成功不等於同步完整或所有文件解析成功。

## D001 — 使用 Node.js 與 TypeScript

- 狀態：已確認
- 決策：以 Node.js 22.17.0 x64 為目標環境，應用程式碼採用嚴格模式 TypeScript。
- 原因：公司電腦可以執行 Node.js，已技術驗證 npm 套件可用，而且沒有可用的 .NET SDK。

## D002 — 文件僅在本機處理

- 狀態：已確認
- 決策：文件解析、建立索引與搜尋都留在使用者電腦。
- 原因：不得假設公司文件可以傳送給外部 AI 或 embedding 服務。

## D003 — 可用 MVP 必須支援多種格式

- 狀態：已確認
- 決策：可用 MVP 包含 Markdown、純文字、DOCX、PPTX、XLSX 與文字型 PDF。
- 原因：只支援 Markdown 無法解決使用者真正的文件搜尋需求。

## D004 — 透過統一模型逐步交付各格式

- 狀態：已確認
- 決策：先以 Markdown／純文字打通完整掃描到搜尋流程，再加入 Office 與 PDF 解析器，且不改寫搜尋核心。
- 原因：這能控制實作風險，同時不會把最終產品縮減成只支援 Markdown。

## D005 — 優先使用已在公司環境測試的套件

- 狀態：已確認，但保留公司政策限制
- 決策：規劃使用 `fflate`、`fast-xml-parser` 與 `pdfjs-dist`；可行時採用 Node.js 內建 SQLite。
- 原因：這些套件已在公司電腦成功載入，但技術上能執行不等於公司已正式核准。

## D006 — 專案文件統一使用繁體中文

- 狀態：已確認
- 決策：所有說明文件、SPEC、狀態、交接與決策紀錄使用繁體中文；程式識別字、命令與通用技術名稱保留英文。
- 原因：使用者需要直接審閱、驗收並將文件整理成書審與面試材料。

## D007 — M1 索引位置與搜尋新鮮度

- 狀態：已確認
- 決策：Windows 預設將 SQLite 索引放在 `%LOCALAPPDATA%\LocalDocSearch`；`search` 只查既有索引，文件變更後由使用者再次執行 `index`。
- 原因：使用者選定此行為；索引不會混入可攜式程式目錄，搜尋延遲也不包含掃描時間。

## D008 — 單檔大小上限

- 狀態：已確認
- 決策：M1 單檔大小上限為 100 MB；超限文件保留基本資訊與可搜尋檔名，狀態為 `too_large`。
- 原因：限制大型文件讀取造成的記憶體負擔，並保留基本查找能力。

## D009 — M2 Office 格式透過 ZIP／XML 解析器接入

- 狀態：已隨 M4 由使用者於 2026-09-16 回報驗收完成
- 決策：使用 `fflate@0.8.3` 讀取 Office ZIP，使用 `fast-xml-parser@5.11.1` 擷取 XML，將 DOCX、PPTX、XLSX 內容轉成既有文字區塊模型；不將文件內容傳出本機。
- 原因：沿用已技術驗證的純 JavaScript 套件與 M1 搜尋核心。ZIP 中需要解壓的 XML／關聯資料合計限制為 200 MB，以降低異常壓縮檔造成的記憶體風險。
- 限制：XLSX 的常見數字與日期格式可轉成可讀文字；複雜自訂格式可能與 Excel 畫面不同，需以實際文件驗收與後續修正。
- 超連結：DOCX 解析正文的一般 hyperlink、欄位型 HYPERLINK，以及 `word/` 下各部件的 hyperlink relationship；圖形或頁首頁尾等無法對應正文位置的網址另存文字區塊並標示來源部件，拆成多個 run 的欄位指令合併解析。XLSX 解析各工作表的 relationship、hyperlink 節點、文件內位置與提示。沿用既有搜尋核心。

## D010 — M3 PDF 文字層解析

- 狀態：已完成並通過公司 Windows 實際文件驗收
- 決策：使用 `pdfjs-dist@6.3.289` 從本機 PDF 位元組擷取每頁文字；CMap 與標準字型資料從安裝在本機的套件目錄載入。加密 PDF 記錄為 `encrypted`，沒有文字層記錄為 `no_text`，損壞 PDF 記錄為 `error`。
- 原因：沿用先前技術驗證的套件，保留頁碼並支援中文文字層；不發送文件內容至外部服務。掃描影像的 OCR 不屬於 MVP。
- Windows 修正：PDF.js 要求 `cMapUrl` 與 `standardFontDataUrl` 以正斜線結尾；資源路徑統一轉為可供 Windows `fs` 讀取的正斜線形式，避免原生反斜線觸發 `Invalid factory url`。
- 重試政策：增量索引會重新解析狀態為 `error` 的未變更文件，使解析器修正生效時不必由使用者刪除索引；已成功、`no_text`、`encrypted` 與 `too_large` 的未變更文件仍會略過。
- 驗收：使用者於 2026-09-15 回報 PDF Windows 資源路徑修正版成功解析實際文件。

## D011 — M4 重建、排除與同步狀態

- 狀態：已完成；使用者於 2026-09-16 回報 M4 驗收完成
- 決策：單一根目錄使用 `.localdocsearchignore` 保存排除規則，採用不依賴額外套件的有限 glob 語法；`rebuild` 使用資料庫 transaction 清空衍生文件資料後，重新索引目前根目錄。
- 決策：同步紀錄分為「最後嘗試」與「最後完整同步」。掃描或讀檔不完整時保留既有索引中的未確認路徑，並在 `status` 保存最近錯誤；文件解析錯誤則保存文件基本資訊並於後續索引重試。
- 原因：排除設定需跟著來源目錄並供重建沿用；保守刪除可避免權限或暫時讀取錯誤被誤判成來源文件刪除。所有清除操作只作用於明確開啟的 SQLite 索引，不刪除來源文件或寬泛路徑。
- 限制：初版 glob 不支援 `!` 重新納入；多根目錄與全機模式留待單一根目錄可靠性驗收後擴充。

## D012 — M5 借鑑開源專案完善品質與交付

- 日期：2026-09-16
- 狀態：規格已確認；使用者於 2026-09-16 回報 M4 驗收完成並要求開始 M5 實作與測試。
- 參考：[Paperless-ngx](https://docs.paperless-ngx.com/usage/#searching) 的欄位搜尋與相關性排序、[sist2](https://github.com/sist2app/sist2/blob/master/docs/USAGE.md) 的增量掃描與診斷、[ripgrep](https://github.com/BurntSushi/ripgrep) 的類型篩選與效能比較方法。採用範圍與完整驗收條件見 `SPEC.md` 第 15 節。
- 決策：新增搜尋 `--type`，先篩選再排序與限制結果數；維持整段子字串查詢，沿用檔名／標題／內容優先序。同分再依修改時間與固定路徑字串順序排列，每份文件一筆結果。
- 決策：明列 NFKC 與不依系統語系的小寫轉換；命中片段對回原文，來源位置與代表區塊一致。只有檔名命中時清楚標示，不展示無關片段。`--verbose` 解釋排序依據。
- 決策：補齊索引摘要、略過分類、耗時與歷史摘要保存；新增 `index`／`rebuild` 的 `--verbose`。不自動套用 `.gitignore` 或排除所有隱藏檔，不追蹤掃描中遇到的符號連結／junction。
- 決策：以固定合成資料集量測端到端 CLI 延遲、首次／增量索引、峰值 RSS 與索引大小，明確區分暖機與正式樣本，並驗證結果正確性及無變更時零解析。Windows 驗收與乾淨目錄交付驗證列為完成條件。
- 原因：既有 M5 僅概述排序、效能與交付，缺少可實作及可驗收的定義；本次把設計參考轉為符合公司 Windows 使用情境的具體要求。
- 範圍：保持 Node.js／TypeScript、SQLite、純本機、單根目錄與六種格式；進階查詢、多根目錄、全機模式、watch、OCR、GUI、AI 與外部搜尋服務另行規格化。


## D013 — M5 搜尋定位、診斷與交付實作

- 日期：2026-09-16
- 狀態：本機實作與測試完成，等待公司 Windows 的 M5 驗收。
- 決策：保留 SQLite 原文，搜尋時 NFKC／`toLowerCase()` 比對；僅對最後回傳結果建立 grapheme 原文範圍映射，必要時用前綴正規化處理跨 grapheme 組合。片段上限與截短註記由命中原文範圍決定。
- 決策：格式篩選在 SQLite 候選文件查詢套用；搜尋維持整段子字串與原有四級排序，CLI 僅在索引／重建時載入解析器，避免搜尋啟動時載入 Office／PDF。
- 決策：同步摘要與診斷沿用 metadata transaction 保存，不要求重建舊索引；根目錄切換時清除上個根目錄的最後完整同步時間。讀檔錯誤使同步不完整，格式解析失敗另列文件狀態。
- 決策：CLI 使用固定診斷訊息、階段、路徑與代碼，避免解析器原始例外帶出正文。略過目錄只算已遇到的項目，不遍歷其內部來累計數量。
- 決策：發布 0.5.0 原始碼／編譯產物包，依 package-lock 在目標平台安裝依賴，不打包 macOS 的 node_modules。效能腳本測量獨立 CLI，核對完整結果及增量內容，紀錄來源雜湊與平台；本機數據不推論 Windows 達標。
- 驗證：34 項自動測試、乾淨目錄安裝／測試／Demo 與 1,000 文件基準通過；詳細證據及資料集限制見 `M5-VALIDATION.md`。

## D014 — 後續格式優先序先依本機盤點決定

- 日期：2026-09-16
- 狀態：盤點已收到，由 D015 與 SPEC 第 16 節接續；M5 歷史基線不變。
- 背景：使用者確認公司 Windows 上無法搜尋內容的檔案為舊版 `.doc`；這是目前 SPEC 明列不支援的格式，非 `.docx` 解析缺陷。
- 決策：將 `.doc` 列為下次優化候選。先用 Windows 內建命令在本機彙總可讀檔案的副檔名與數量，再依盤點結果、格式解析可行性及實際需求決定優先序。
- 隱私：只需彙總數字，不需收集檔名、完整路徑或文件內容；不將公司文件上傳外部服務。


## D015 — 依使用者盤點啟動 M6-A

- 日期：2026-09-16
- 狀態：使用者已明確要求依缺口規劃並執行，M6-A 本機實作完成，Windows 驗收待回報；目前里程碑見 STATUS。
- 決策：本批加入 DOC、XLS、MHT／MHTML、HTML／HTM／XHTML、AsciiDoc；MSG 下一批、VSD 先做部署可行性驗證，其他候選見 SPEC 第 16 節。
- 決策：維持 Node.js／TypeScript 及本機處理，新增純 JavaScript 解析依賴，不要求 Office、COM 或外部轉檔程式。SheetJS 使用官方新版 tarball 並存於 vendor，避免 npm 舊版本及官方下載端點影響重現安裝。
- 參考：[word-extractor](https://github.com/morungos/node-word-extractor)、[SheetJS Node.js 安裝](https://docs.sheetjs.com/docs/getting-started/installation/nodejs/)、[postal-mime](https://github.com/postalsys/postal-mime)、[htmlparser2](https://github.com/fb55/htmlparser2)。
- 範圍：本次明確授權解除 DOC／XLS 的舊版 Office 開發限制；不是開啟全機掃描、OCR 或 AI。M5 Windows 未驗收部分保留，不阻擋本次授權的開發。

- 實作：新增依賴鎖定 `word-extractor@1.0.4`（MIT）、`xlsx@0.20.3`（Apache-2.0）、`postal-mime@3.0.0`（MIT-0）、`htmlparser2@12.0.0`（MIT）；來源說明見 `vendor/README.md`。
- 可靠性：DOC／XLS 二進位解析放入可終止 worker，30 秒期限及 512 MiB V8 old-generation heap 上限；逾時不留下半份文字，保留檔名並記為 error。對外診斷使用固定代碼，不輸出可能含正文的原始例外。
- 驗證：2026-09-16 macOS／Node.js 26.7.0 的 42 項自動測試通過；新增案例含合成 DOC／XLS、中文與 Big5、MIME、加密、失敗備援、worker 期限及跨程序 CLI。公司 Windows／實際文件尚待驗收。


## D016 — M6-B 本機 MSG 郵件內容搜尋

- 日期：2026-09-16；狀態：使用者已授權接續下一版，規格見 SPEC 16.4。
- 決策：新版本 0.7.0 支援郵件主旨、通訊欄位與一種正文表示（HTML、純文字、RTF 依序）；不展開附件或連線 Outlook。不改動既有排序與 SQLite 結構。
- 決策：使用純 JavaScript MSG／RTF 套件與既有 HTML 文字擷取，複用 worker 期限機制，避免損壞 OLE 或 RTF 讓整批索引卡住。只把郵件根層及收件者必要欄位交給 MSG 解析器，不遞迴解析附件郵件。
- 參考：[msgreader](https://github.com/HiraokaHyperTools/msgreader)、[rtf-stream-parser](https://github.com/mazira/rtf-stream-parser)。版本、限制及驗證結果將記錄於本批交付文件。
- 驗收界線：前版本機通過不等於 Windows 已驗收，本次繼續開發也不把前版驗收自動標記完成。VSD 留待下一里程碑。

- 依賴：`@kenjiuno/msgreader@1.28.0`（Apache-2.0）、`@kenjiuno/decompressrtf@0.1.4`（BSD-2-Clause）、`iconv-lite@0.6.3`（MIT）、`rtf-stream-parser@3.8.1`（MIT）。4.0.0 實際下載包缺少 package.json 指定的 dist 入口，故鎖定可載入的 3.8.1；解析前限制 RTF 輸入／解壓／輸出長度與 bin 參數，並在 worker 隔離執行。
- RTF：驗證 LZFu CRC 及長度。一般 RTF 加入文字模式標記後沿用 Unicode／字碼頁處理；使用版本鎖定的 feature hook 排除 pict／object／info 等非正文資料，並以回歸測試約束此行為。RTF 特殊欄位與版式不保證完整還原。
- S/MIME：依 [Microsoft 訊息辨識規格](https://learn.microsoft.com/en-us/openspecs/exchange_server_protocols/ms-oxosmime/e6f63b02-c679-4752-9302-9c4641749e95)，類別可能代表簽章或加密；不單憑類別回報 encrypted。本版以 MSG_SMIME_UNSUPPORTED 錯誤保留檔名。
- 驗證：macOS Node.js 26.7.0／22.17.0 全部 53 項測試通過；乾淨目錄 Node.js 22.17.0 的鎖檔安裝、測試與郵件 Demo 通過。92 項發佈內容核對並提供 SHA-256；公司 Windows 及實際 MSG 驗收尚待回報。

## D017：M6-C 先交付 VSD 檔名搜尋，保留內容解析缺口

- 日期：2026-09-16
- 使用者要求繼續實作，接續盤點中 143 份 VSD。0.8.0 先納入檔名與格式篩選，使用既有 unsupported 狀態與 VSD_CONTENT_UNSUPPORTED，與未掃描的未知格式區分。不將 unsupported 視為暫時解析故障重試。
- 審查 npm `@mdgate/visio@0.6.25` 的實際發佈內容：二進位 OLE 分支僅列舉 root streams 並掃描 UTF-16／UTF-8 可列印字串，未解析 VSD 圖形文字結構與壓縮；不採用其字串結果作為可靠內容。未安裝此候選套件。來源：https://github.com/mdgate/converters/tree/main/packages/visio 。
- LibreOffice libvisio 為原生解析器；本批未完成可攜式 Windows 整合、授權隨附及中文案例驗證，不自行引入 Visio／Python 或外部服務。不是宣稱所有 VSD 本機解析皆不可行。
- metadata-only 分支只 stat，不 readFile，沒有文件內容解析、損壞或加密判定；沿用單檔大小政策及增量生命週期。未來正式加入內容解析時，需讓原 unsupported 文件重新處理，不能只新增 parser 後沿用未變更略過。
- M6-C 內容擷取仍未完成；本次交付不代表全文支援或公司 Windows 驗收通過。

## D018：M6-C 以 TypeScript 解析 VSD v11 的直接圖形文字

- 日期：2026-09-17；使用者要求繼續 VSD 實作，本決策擴充 D017 的檔名限定。
- `visio-viewer-extension` 現行純 JS 版明列不支援二進位 VSD；未採用。改以 LibreOffice/libvisio 的 MPL-2.0 指標、chunk 及解壓邏輯為參考，移植所需部分至 TypeScript。固定來源 commit、授權及修改範圍見 vendor/README.md；改寫檔案保留 MPL-2.0，原始碼與授權隨包交付。
- 沿用 SheetJS CFB 容器及既有 worker，不加入 Python、原生模組、Visio 或網路服務。VSD v11 的直接 UTF-16 文字依紀錄邊界擷取，不採字串掃描；不渲染圖形，也不把未使用 master 或附件納入內容。
- 限制：未展開 master 繼承、動態欄位、頁名、超連結及 OCR。來源位置使用真實頁面／圖形 ID，不冒充畫面頁碼；沒有直接文字的 no_text 不代表圖形視覺上空白。
- 嚴格檢查長度、Unicode、循環、指標順序及總資源預算。任何解析失敗清空本次區塊，僅保留檔名。未知版本或必要結構回報 unsupported，損壞回報 error。
- 增量例外：unsupported VSD 即使未變更也重試，使 0.8.0 索引可直接升級並容納後續版本擴充。成功／no_text 仍零解析略過，未修改其他格式的重試規則。

## D019：以日常找檔閉環排序後續開發

- 日期：2026-09-17。依使用者收斂目標，成功標準為無管理員、有權限目錄中的本機內文搜尋與開啟。作品集為加值，不追開源星數或參考專案功能清單。
- M6-C 本批後，新增格式依真實失敗案例設停損，下一階段先規格化開啟文件／顯示資料夾，再多根目錄。完整順序、驗證缺口與可選 AI 人選上下文模式見 ROADMAP.md；不自動啟用 OCR、GUI 或整庫 RAG。

## D020：M7 以固定文件代碼連接搜尋與開啟

- 日期：2026-09-17。依 ROADMAP 進入 M7，版本 0.10.0；M5～M6 Windows 驗收仍保留。
- 選擇 ID＋路徑雜湊代碼而非上一輪搜尋排名，無需保存全域「最後搜尋」，不同終端互不覆寫；重用 ID 到不同路徑不能誤開舊結果。代碼只是選擇工具，不是授權憑證。
- 開啟前查目前索引、根目錄與來源檔案；拒絕子路徑連結、已刪除、非一般檔案及非支援格式。大小／mtime 改變時提示但不強迫重新解析。
- Windows 以固定 PowerShell 程式呼叫 ProcessStartInfo.UseShellExecute（open）或 Explorer /select（reveal）。文件路徑透過環境變數，不拼接 PowerShell 程式；不使用 cmd/start，不變更 ExecutionPolicy。10 秒期限並將啟動問題轉成固定代碼。
- 參考：https://learn.microsoft.com/en-us/dotnet/api/system.diagnostics.processstartinfo.useshellexecute ；此機制只送出作業系統開啟請求，應用程式顯示及公司政策需要 Windows 實測。
- macOS 的 open／-R 僅供本機開發；自動測試使用 dry-run 或注入啟動函式，不自動開啟桌面應用程式。Windows 命令組裝測試不能冒稱 Windows UI 驗證。

## D021：M8 多根目錄隔離與集中驗收

- 日期：2026-09-17。使用者明確表示無時間逐版確認，授權持續開發；各版保留本機證據，整合後提供一份 Windows 清單，不以未回報驗收冒稱成功。
- 新增 roots 與 document_roots，歸屬及文件更新在同一 transaction；舊 root metadata 與全部文件一次原子遷移，保留文件 ID、文字及原同步時間。不依賴來源可讀，離線也可完成資料庫升級。
- 新增 index 位置不再清空其他位置。刪除、排除、重建均以歸屬限制；根目錄移除只刪衍生資料。根目錄各自保存同步摘要與最後完整時間，CLI 不以最新一次同步代表整體。
- 父子重疊先明確拒絕，避免同份文件兩套排除政策；實際相同位置的別名沿用既有根目錄。搜尋 --root 依已登錄路徑查索引，不重新存取來源。
- 批次同步根目錄失敗仍繼續其他位置，保存失敗紀錄並回傳 3。掃描不完整的重建保留未確認舊資料，已可讀的文件仍強制重解析。M7 開啟動作驗證文件自己的歸屬。


## D022：M9 人選上下文只匯出確認過的搜尋片段

- 日期：2026-09-17。依 ROADMAP／SPEC §19 進入 M9，版本 0.12.0；Windows 仍採 INTEGRATED-ACCEPTANCE 集中驗收。
- 決策：提供 `context` 互動命令，沿用既有關鍵字搜尋與文件代碼，不呼叫模型、不改寫查詢、不自動灌整庫。候選預設 100、每頁 10、最多選 20；匯出前完整預覽且必須輸入 `yes`。
- 決策：輸出為新 UTF-8 JSON（exclusive create），只含選取文件的路徑、代碼、狀態、位置、≤160 code point 片段與同步資訊；禁止覆寫；超過 256 KiB 拒絕。確認前後重新核對搜尋快照與來源 mtime／存在性，變更即拒絕靜默帶入舊預覽。
- 決策：非 TTY／EOF／取消不建立檔案。附 `docsearch.cmd` 僅方便呼叫，不改索引位置或 PATH。尚未連接 AI／IDE／MCP；BU 聊天專用匯入另定規格。
- 驗證：macOS Node.js 26.7.0 的 88 項測試通過、1 項 Windows cmd 略過；公司互動終端與 cmd 入口待集中驗收。

## D023：M10 以多段命中與 Markdown 服務「可貼上的精準上下文」

- 日期：2026-09-17。使用者明確要求繼續開發，不要把時間花在代理人自行驗收。
- 決策：在不接模型的前提下，讓 `context` 匯出更適合手動貼進允許通道：每份文件可帶多個命中區塊，並提供 Markdown 格式。
- 決策：JSON 升 schemaVersion 2，保留 M9 欄位以相容；新增 `passages`。預設 passages=3，上限 10，避免一次貼上過長。
- 決策：仍禁止自動外傳／自動同意／覆寫；OCR／GUI／向量 RAG 不在本版。

## D024：M11 用 Node fs.watch 做可選前台監看，不做系統服務

- 日期：2026-09-17。使用者選擇「監看目錄自動增量 index」。
- 決策：新增前台 `watch` 命令，依賴 Node 內建 `fs.watch({ recursive: true })` 與既有 `sync` 增量，不引入 chokidar／原生模組，不安裝 Windows 服務。
- 決策：防抖合併事件，避免存檔連打造成重複全量掃描壓力；啟動時先 sync 一次以對齊現況。
- 決策：只能監看已登錄根目錄，避免 watch 偷偷擴大索引範圍。

## D022：M9 先提供人選上下文檔，不自動接模型

- 日期：2026-09-17。沿用使用者要求的精準上下文方向，透過 CLI 互動清單實作模式 A 的預選代碼與模式 B 的查詢輸入，共用分頁、選取、完整預覽及確認。
- 僅匯出已選結果的原文命中片段與來源資訊，JSON 方便手動帶入或未來整合；不讀取整份正文、不匯出未選結果，不操作剪貼簿或任何 AI／聊天連線。檔名命中保留明確標示。
- 確認不接受管線或 --yes，避免非互動批次把整批結果自動帶走；產品中的人選是本功能本身，不影響使用者已授權持續開發。
- 預覽後核對原結果與當前索引，並檢查來源可讀性、大小與修改時間；偵測改變就拒絕，不靜默更換內容。這不是來源文件內容雜湊驗證，不承諾偵測刻意保持大小與 mtime 的變更。
- 輸出採 exclusive create 防止覆寫，最多 256 KiB。控制字元在終端跳脫顯示，JSON 正確保存原始值；來源文字標註為資料而非操作指令。選取功能不代表外傳公司文件已獲許可。
- 附加 docsearch.cmd，使用相對於腳本的 CLI 入口並傳回結束碼，不安裝服務或修改 PATH。Windows 實際批次檔測試在 macOS 明確略過，保留集中驗收。

## D025：M11 監看生命週期修正（0.14.1）

- 先建立監看再初次同步，避免初始化期間的事件空窗；同步中的事件僅標髒，完成後再防抖補跑。
- 停止時先關閉事件來源與計時器，再等待進行中的同步，最後由 CLI 關閉 SQLite。失效監看器不可繼續宣稱監看中；全部失效自動退出 3。
- 沿用 M11 範圍，不新增服務或外部依賴。更正套件版本與既有 M10／M11 文件不一致。

## D026：M12 以定期增量校正補償監看遺漏

- 依使用者持續開發授權，補足 FR-11 的事件僅作提示原則。預設每次同步完成後 5 分鐘再校正，可用 --rescan 調整或以 0 關閉。
- 沿用純 Node、增量比對與原索引範圍。監看失效降級為定期掃描並重試；離線保留索引，恢復重新同步。非背景服務。
- 測試注入計時器和監看器，使用真實暫存文件驗證漏事件修改／刪除、離線恢復與退出清理。

## D027：M13 獨立 SQLite 交易作寫入互斥

- 用主索引實際路徑旁的 .writer.sqlite 協調檔，以 BEGIN IMMEDIATE 持有跨程序單一寫入交易；不把漫長解析包在主索引交易，不用移除過期 PID 檔。檔案保留，關閉交易即釋放鎖。
- [SQLite 交易文件](https://www.sqlite.org/lang_transaction.html) 說明 IMMEDIATE 的互斥與 SQLITE_BUSY。本版另用獨立程序被終止測試恢復；不冒稱 Windows 已驗收。
- 忙碌不改主索引報告；watch 防抖後重試。鎖內再驗證登錄範圍，避免移除與掃描交錯復活資料。

### M13 證據補充（2026-09-17）

逐項盤點目標與現況，新增 GOAL-AUDIT.md；用現版重跑既有合成基準，另存 benchmark-m13-node22.json／M13-PERFORMANCE.md，保留 M5 歷史結果。不同 Node 版本不作速度優劣對比，macOS 數據不代替 Windows 驗收。不因持續開發授權而自動擴大 GUI／AI 範圍。

## D028：M14 跨查詢累積人選上下文

- 使用者將目前 macOS 電腦改為優先執行環境，Windows 驗收延後且不再阻擋版本迭代；仍維持 Node.js／TypeScript、純本機與不自動外傳。
- `context` 工作階段可用 `s <查詢>` 切換候選並保留已選文件；用 `b` 檢視跨查詢清單、`r <編號>` 移除。最多仍為 20 份文件，同一路徑只出現一次並保留首次選取時的查詢依據。
- JSON 升為 schemaVersion 3，頂層列出 `queries`，每份文件與每段命中記錄所屬 `query`。保留頂層 `query` 與文件既有欄位，讓既有讀取端有明確主要查詢可用。
- 切換查詢不呼叫模型、不改寫關鍵字、不掃描來源；只查本機索引。匯出前後分別以各文件的選取查詢重新驗證索引與來源。

## D029：M14 Windows 實測失敗以 0.17.1 修正

- 日期：2026-09-18。使用者在公司 Windows 執行 0.17.0 `npm test`，M13 寫入鎖競爭案例在 10 秒後逾時且整體約 65 秒，M9 從任意工作目錄啟動 `docsearch.cmd` 時被 `cmd.exe` 錯誤解析；OEM code page 錯誤文字又被測試當作 UTF-8 顯示成亂碼。
- 寫入協調仍採獨立 SQLite 交易。將 `PRAGMA busy_timeout = 0` 與 `BEGIN IMMEDIATE` 分為兩次呼叫，確保先安裝零等待 busy handler；同時辨識 SQLite extended BUSY／LOCKED code。測試直接斷言競爭在一秒內回報，CLI 子程序各有五秒期限，避免同步 API 卡住後掩蓋真正位置。
- cmd 測試不再自行組合首尾巢狀引號。批次檔絕對路徑放入測試專用環境變數，再以 `cmd.exe /d /c call` 啟動；失敗訊息只列結束碼、signal 與 Node error，不顯示可能採 OEM code page 的 cmd 錯誤位元組。
- 這些變更修正 Windows 入口與鎖競爭契約，不改產品索引資料、搜尋或 context schema。macOS Node.js 22.17.0／26.7.0 回歸通過；Windows 必須以 0.17.1 再跑後才可標示通過。

## D030：M15 以明確選用的本機剪貼簿降低交付摩擦

- 日期：2026-09-18。使用者回報 0.17.1 公司 Windows 驗證通過並詢問下一步；依 STATUS 已排定的方向，先縮短已選上下文帶入討論的操作，不直接連接特定 AI、IDE 或聊天帳號。
- `--clipboard` 與 `--out` 二選一，完整預覽和逐字 `yes` 不變。剪貼簿模式預設 Markdown，適合貼入討論；不提供非互動同意或自動傳送。
- 文件內容只經子程序 stdin 傳給 macOS `pbcopy` 或固定 Windows PowerShell `Set-Clipboard`，不放入 argv、環境變數、stderr 或 shell。仍受作業系統剪貼簿歷程、同步設定及其他本機程式影響，因此預覽時明示此界線。
- 測試以注入寫入器驗證內容、時序、取消與錯誤，不碰真實剪貼簿；平台啟動計畫另測 Unicode 輸入設定與無 shell 插值。

## D031：M16 以顯式 all-terms 補足片語搜尋缺口

- 日期：2026-09-18。使用者要求略過 M15 人工測試並繼續下一版。現有搜尋將整段查詢視為連續子字串，對日常用數個記得的詞找文件不方便；新增 `--all-terms`，不改預設語意。
- 詞以 Unicode 空白切分，不加入引號、布林、模糊、同義詞或中文斷詞語法。全部詞可分散於同一文件的檔名、標題和內容區塊，避免要求使用者記得原句與詞序。
- 仍使用線性掃描既有本機索引與可解釋排序，不新增 FTS schema、embedding 或外部服務。代表片段依詞涵蓋數、標題優先及 ordinal 決定；context 的重搜驗證必須保留相同模式。
- context JSON 升 schemaVersion 4 並記錄 `matchMode`，Markdown 同樣標示，避免相同查詢文字在日後無法分辨是片語或全部關鍵字。

## D032：M17 將掃描範圍升級為完整檔案清冊

- 日期：2026-09-19。使用者指出遞迴掃描即使遇到尚未支援的格式，也應知道檔案存在；因此所有未被排除的一般檔案都進 `documents`，而不是只保留內容解析器支援的格式。
- 支援格式維持全文解析。其他副檔名與無副檔名檔案採 metadata-only：只 `stat` 並保存路徑、檔名、類型、大小和修改時間，狀態為 `unsupported`，不讀正文、不建立 blocks，也不製造逐檔錯誤訊息。
- `--type` 改為接受安全的任意副檔名，open／reveal 以「已索引且仍位於所屬根目錄」作安全邊界，不再以解析器格式白名單拒絕。排除規則與連結政策不變。
- 未來加入新解析器時，既有同格式 `unsupported` 文件必須在下一次增量索引重試。這一版只修清冊完整性；壓縮內容與候選索引仍依獨立實驗決定，避免把正確性修正和儲存後端改造混在同一版。

## D033：索引瘦身先拆成串流、壓縮與候選三階段

- 日期：2026-09-19。使用「測試用資料」比較現況、逐列串流、每文件 Brotli、64 KiB Brotli、FTS5 trigram 與 Bloom trigram；12 組完整命中集合全部一致。
- 現況資料表只改逐列搜尋，峰值 RSS 即由 477.6 MiB 降至 104.7 MiB，證明 RAM 問題主要來自 `candidates()` 一次具體化整庫。下一版先修這個讀取路徑，不等待 schema 遷移。
- 儲存方向選 64 KiB 左右的獨立 Brotli 塊：4.46 MiB，為現況 25.2%；不採更小的每文件單塊，因為大型文件需整份解壓。這是原型方向，正式 chunk 邊界仍須保證片段、位置與更新原子性。
- FTS5 方案為 12.16 MiB，候選效果與 6.02 MiB 的 Bloom 接近，因此不列為首選。Bloom 保留為壓縮後的第二階段實驗，不能先於精確串流核對器；一、二字仍必須退回掃描。
- 原型沒有取代產品後端；正式行為變更必須另開里程碑、更新 SPEC 並補增量、崩潰恢復、排序、片段與遷移測試。

## D034：M18 先以 SQLite 串流讀取移除整庫 JavaScript 載入

- 日期：2026-09-19。依使用者要求開始改動，先實作 D033 風險最低的一步。SQLite schema、內容、查詢語意與 CLI 均維持不變；只替換讀取迴圈。
- Store 提供文件列與單一文件區塊的 iterator。搜尋掃完目前文件再前進，檔名命中不讀 blocks；context passages 直接定位單一文件。
- 搜尋結果仍需要保存命中的文件以排序和套用 limit，這是有界於文件數的必要資料；不得保存所有文字區塊或所有正規化全文。

## D035：M19 片段採區段定位與有界前後文

- 日期：2026-09-19。M18 移除 SQLite 整庫載入後，正式連續搜尋仍出現高 RSS；量測定位到 `makeSnippet()` 對超大命中區塊建立完整 Unicode 來源範圍與前後文陣列。這是顯示層暫存，而非索引或 SQLite 快取。
- 正常路徑以 code point 邊界分段核對完整 NFKC／小寫結果，並逐 code point 直接定位命中來源；前後文以有限收集器產生。組合字或語境大小寫無法逐點證明等價時，才只為命中小區段建立保留 grapheme 的來源範圍。避免把 `Intl.Segmenter` 套用於整份多 MB 原文，讓一般文字的額外配置量受片段上限約束。
- Unicode 的跨區段正規化或大小寫語境若使分段結果與完整結果不一致，立即使用既有完整映射作保守回退。回退罕見但可能耗用較多記憶體；不可為了節省記憶體而犧牲命中位置正確性。
- 本版只消除已量測的摘要熱點，不開始 Brotli schema 遷移。壓縮塊仍是下一個資料儲存里程碑，需另行處理遷移、transaction、一致性與實測。

## D036：M20 以 SQLite 關聯的獨立 Brotli payload 保存正文

- 日期：2026-09-19。M19 證實片段暫存不是 RAM 的唯一來源，且原始實驗顯示 64 KiB Brotli 分塊的總儲存量顯著低於現況。因此先改內容層，不先加入可能膨脹索引的 FTS 或 Bloom。
- 區塊 metadata 保留在 `blocks`；正文存入外鍵相連、每塊可獨立解壓的 payload 表。這讓更新與刪除能受既有 SQLite transaction 和 cascade 保護，也讓未來候選索引可只指向 payload，而不複製正文。
- 遷移採「先寫 payload，再確認寫入，最後清除舊正文」的單一 transaction。讀取時暫容忍舊正文，以利從舊版資料庫無中斷升級；任何資料不完整都視為索引錯誤，不靜默回傳漏字結果。
- 初步先由讀取層重組單一 text block，優先保住精確搜尋結果；後續再將搜尋核對下推至 payload 串流並加入候選過濾。不可將完成壓縮儲存誤稱為已完成最終 RAM 最佳化。
- 實作量測修正：真實資料有 115,618 個小文字區塊；每 block 一個 Brotli blob 使 SQLite 列與 frame 開銷反而將資料庫推至 19.31 MiB，較 17.70 MiB 現況更大。因此正式 payload 必須至少以文件為單位合併小 block 至約 64 KiB，並另存 block 對 payload 的範圍；不得交付一 blob 一 block 的中間設計。

## D037：M21 搜尋從文件批次 payload 逐段產生 block

- 日期：2026-09-19。M20 已壓縮正文，但若 `streamCandidates()` 先解壓並建成整份文件 blocks 陣列，仍會放大大型文件搜尋的短暫記憶體。搜尋主路徑改接 generator。
- payload 中的 `[blockId, contentFragment]` 保持原始 block 順序；讀取器只暫存當前 block 的跨 payload fragment，遇到下一 block 即交給搜尋。這保證跨 payload 的同 block 查詢不漏，而不同段落不會因串接誤命中。

## D038：M22 以文件級 trigram Bloom 作純排除候選

- 日期：2026-09-20。M21 仍對每份文件解壓與正規化；採固定大小 Bloom 可用極小空間跳過罕見三字以上查詢的不可能文件。
- Bloom 不儲存正文、不能作搜尋結果依據，且可能誤判為候選；只有「缺少某個必要 trigram」才能跳過文件。短詞與舊資料庫一律回退完整核對，正確性優先。

## D039：M23 以 payload 級 Bloom 縮小解壓範圍

- 日期：2026-09-21。M22 已能略過整份不可能文件，但常見詞仍使大型文件的全部 payload 解壓。保留文件級 Bloom 作第一層，再為每個 Brotli payload 保存固定 1 KiB 摘要及 payload／block 對應。
- payload Bloom 只尋找「至少一個可能 trigram」，不能要求整條長片語的全部 trigram 都在同一 payload；否則跨 payload 文字會被錯誤排除。選中的 payload 會回讀其完整 block fragments，最後仍由原精確核對決定命中。沒有 payload 候選但文件級摘要可能命中時回退整份文件，優先避免邊界漏搜。
- 代表片段回讀改依 block mapping 限縮至目標 block，避免排序後又解壓無關 payload。新 mapping／摘要遷移受單一 transaction 保護；缺資料一律走既有完整讀取，而非靜默省略。

## D040：M23 修正版將遷移移出開庫，逐文件接續且不重壓縮

- 日期：2026-09-21；0.26.1 已依 SPEC §34 實作。取代 D039 的全庫單一遷移交易及 D036 在共用開庫時自動遷移的做法；單份文件更新的原子性仍保留。
- 公司診斷副本顯示 610 文件、219,518 區塊且缺 payload_bloom_version；共用初始化因此對 index／status 都執行全庫遷移。已定位路徑，尚未量測各熱點成本，不能歸因於解析逾時。
- 唯讀操作不建表、不遷移、不回復 hot journal；明確回報需要升級、忙碌或 INDEX_RECOVERY_REQUIRED。回復與遷移放在持有跨程序寫入鎖的明確寫入流程，先顯示階段。
- 已是內容格式 2 的資料只逐 payload 建立摘要及對應，保留原壓縮 bytes；使用 ID／Map 查找，消除 O(B²) 掃描。每文件的衍生資料及完成標記原子提交，全部完成才寫全庫版本，中斷後接續。
- 搜尋對未完成摘要採完整核對；即時進度及取消能力涵蓋升級與索引各階段。610 文件／219,518 區塊合成量測在目前 Mac 的 Node 26.7.0／22.13.1 均約一秒且 payload bytes 不變；仍需公司 Windows／Node 22.17.0 複驗。本次不調整解析期限、不改產品搜尋語意。

## D041：Windows 鎖等待必須在 DatabaseSync 開庫時設為零

2026-09-22 更正：當時將開庫 timeout 當作逾時根因的推論未獲證實。公司 0.26.2 逐檔測試通過、並行全套仍逾時；保留零等待設定，但不能稱為已驗證的效能修正。

- 日期：2026-09-21。公司 Windows／Node.js 22.17.0 執行 0.26.1 全套測試得到 142 通過、4 失敗、2 略過；M13 一項及 M24 兩項都在 CLI 子程序的五秒期限耗盡，M9 則在含空白與括號的下載路徑經 `cmd.exe /c` 呼叫失敗。
- Node.js 22.16.0 已加入 `DatabaseSync` 的 `timeout` 建構選項，目標 22.17.0 可用。主索引唯讀／寫入連線與 writer 協調連線均在建構時傳入 `timeout: 0`，再保留分開的 PRAGMA；這讓 busy handler 在任何 schema／狀態查詢或 `BEGIN IMMEDIATE` 前生效。
- 不放寬產品或測試的五秒期限。M9 測試改由暫存批次檔呼叫含特殊字元的 launcher 路徑，避開 Node argv 到 `cmd /c` 的額外引號解析，同時保留不同 cwd 的驗證目的。
- GitHub 原始碼壓縮檔不含編譯產物；加入 npm `prepare`，使 `npm ci` 直接建立 `dist`。這是安裝流程修正，不改搜尋、索引資料或文件內容。

## D042：以固定 SQL 參數傳遞候選集合

- 日期：2026-09-22。公司搜尋與本機 40,000 區塊回歸均證實 SQL 綁定參數超限。以 json_each(?) 展開候選 payload／block 數字陣列，兩階段查詢分別固定為 2／3 個參數；維持唯讀、不建立暫存表、不修改索引格式。
- 公司獨立測試通過而全套並行逾時，預設測試改為逐檔，保留內部真正的跨程序鎖競爭及原期限。watch 靜態引用 sync 會連帶載入所有 parser，改為 runWatch 時才動態載入。

## D043：搜尋採穩定結果集分頁，XML 採安全原文解碼

- 日期：2026-09-22。使用者實測常見字 `APPLICATION` 時，前 20 筆高順位檔名命中遮住後方正文，且舊輸出沒有總數，容易被誤認為只有 20 筆。搜尋因此改成一次收集排序 metadata、按頁回讀片段；互動 TTY 翻頁，非互動以明確頁碼操作，舊 `--limit` 僅作相容單次輸出。
- 不採資料庫 offset 重新執行每一頁，因現有排名需全文精確核對且翻頁期間索引可能改變。工作階段保留輕量命中 metadata，不保留 SQLite iterator；以 `PRAGMA data_version` 偵測外部提交，變更時要求重搜。
- `.xml` 不套用 HTML 的文字抽取，也不建立 XML DOM。產品需求包含 `<User>dbla</User>`、設定標籤與屬性，因此保存逐行原文最符合可預期搜尋；只做本機字元解碼，不處理 DTD／entity，避免外部資源與實體展開風險。
- XML 解碼以標準訊號決定編碼並採嚴格失敗；無法解碼時保留錯誤 metadata，不能以替代字元靜默污染索引。既有 unsupported XML 沿用增量同步的「新支援格式重試」機制，一次普通 index 即可升級。

## D044：以文件級 AND 逐層縮小完整搜尋結果

- 日期：2026-09-22。使用者回報 0.27.0 人工驗收成功後，確認需要結果內搜尋，並要求加入規劃；0.28.0 已依 SPEC §36 實作。
- `/ 關鍵字` 只在目前完整候選集合追加條件，各層為文件級 AND；必須核對完整已索引內容，包含未顯示頁面與片段以外的內容。原查詢模式、格式與根目錄限制延續。
- back／reset 讓縮小過程可逆；顯示條件鏈與目前／最初總數，單頁或零結果仍可操作。保留最初相對排序，片段展示最新條件的命中，幫助使用者理解文件為何留下。
- 實作依 SPEC §36 先建立搜尋工作階段及候選範圍，再接 CLI 與回歸；維持純本機唯讀，索引變更時要求重搜。

## D045：擴大根目錄以原子歸屬轉移整併既有子根

- 日期：2026-09-22。使用者要求把 `D:\備份` 擴大到 `D:\` 的支援架構加入 SPEC。§37 取代父子根一律拒絕的預定行為；0.29.0 已依規格實作。
- 保留單一文件歸屬，新增根目錄操作計畫及短交易轉移，不以刪除原根再重新索引實作合併。文件 ID、payload 與既有搜尋代碼均保留；長掃描在合併提交後進行，中斷仍有可讀的舊成果。
- 排除作用域存於 `root_ignore_scopes`，合併歷史存於 `root_merge_history`，schema 標記 `root_merge_version=1`。上層規則與適用子根規則共同約束。已涵蓋子樹可單獨增量同步，但不得宣稱上層已完整同步。
- 同步、搜尋篩選、監看與根移除共同理解合併後的歸屬；不得呼叫會刪文件的 removeRoot 來合併。
- 2026-09-22 補：Windows 命令列把 `"D:\"` 的尾端反斜線當成跳脫，argv 變成 `D:`；全形 `＼` 也不是路徑分隔符。輸入層將僅磁碟代號或全形分隔符正規化為 `D:\`，涵蓋判斷仍以路徑元件進行，不以字串 `D:` 當前綴。磁碟根目錄請優先寫 `D:/`。

## D076：以 FTS5 unigram／trigram postings 取代全文件候選掃描

- 日期：2026-09-26。依新搜尋需求加入兩個 contentless FTS5 虛擬表：`search_unigrams` 將正規化 Unicode code point 編成 token，供一、二字查詢；`search_trigrams` 保存正規化全文，供三字以上查詢。每個文件各有一列，`rowid` 綁定 `documents.id`，正文仍只存在既有 64 KiB Brotli payload。
- FTS postings 是候選文件的第一來源；phrase 與 all-terms 先在 postings 取交集，再沿既有 Bloom／payload pruning 讀取必要 payload，最後保留原有全文核對、檔名層、排序、snippet、reference。FTS 只可排除不可能文件，不能直接作最終命中判定。
- `ngram_index_version=1` 與每文件 `ngram_1` marker 使遷移可中斷後接續；每份文件的 postings、marker 單一交易提交，payload bytes 不重壓縮。舊 content payload 遷移同樣逐文件提交並檢查取消訊號。唯讀 CLI、status、MCP 只回報未完成並使用保守 fallback，不建表、不遷移、不寫 marker。
- upsert、remove、root cleanup 在同一寫入交易清掉舊 postings；replace 不改文件 ID，避免 stable reference 變動。FTS5 需要 `contentless_delete=1`，以支援明確 rowid 清理。
- Workbench 遇到 `format.needsUpgrade` 回 `202 pendingUpgrade`，背景 writer 執行 upgrade；前端輪詢狀態後重新送出原查詢。新增 benchmark 比較停用 FTS fallback 與 FTS postings 的 index time、SQLite bytes、RSS 及 rare/common/two-character/three-character/long-phrase 查詢。

## D077：每次搜尋使用同一份 structured Diagnostics／Performance Trace

- 日期：2026-09-26。搜尋問題需要知道總耗時、實際 phase、候選來源、文件／payload 數量、exact verification、結果數與瓶頸；trace 另外以 `bottleneck` 指出 phase 中耗時最高者。沿用既有 `performance.now()` profile／phase timing pattern，新增單一 `SearchTraceRecorder`，不引入第二套 logging framework。
- trace 在 query normalization、FTS postings／restricted ids、document enumeration、document／payload Bloom、payload lookup／Brotli decompression、exact verification、ranking 與 snippet materialization 的實際 code path 累計量測。Bloom 已排除的文件在 trace 中可見，但不得進 exact verification；`candidateStrategy` 由實際來源推導。
- 無 index 的 Workbench 搜尋仍回 schema-complete trace，以空 `candidateSources`／`candidateStrategy=none` 表示沒有候選管線；這與已建立索引但零命中的 `postings` trace 分開，避免診斷混淆。
- 可見性同時提供程序內與有界持久化：`SearchResultSet.trace`、`SearchSession.trace`、`IndexStore.lastSearchTrace()`、MCP／Workbench `trace` 欄位、CLI `--verbose` 的 `SEARCH_TRACE <JSON>` 與 `/traces` UI。trace 不寫 SQLite／profile；完成事件寫入本機 `trace.log` JSONL，保留 query／question 但不保存文件內容。
- `/api/ask` 另用同一 instrumentation pattern 的 `AnswerTraceRecorder` 記錄 context build、preview validation、provider request、response parsing 與 fallback attempt；response、`WorkbenchHandle.lastAnswerTrace()` 與本機 JSONL log 提供 schema version 2。只記 question、route、phase、bytes／counts，不記 key、context 或 answer 正文。
- SearchSession 會暫停 recorder 以排除使用者停留時間；page／passage 物化仍記錄實際 payload reread、decompression 與 snippet，讓長期診斷能區分候選、I/O、解壓與展示階段。traceId 與 status/errorCode 讓 UI／log 可把成功、失敗與同一事件對回。

## D078：Trace 必須有獨立 UI 與有界 JSONL 持久化

- 日期：2026-09-26。僅把 trace 放在 response、stderr 或程序記憶體不足以追查長時間／間歇性問題；新增獨立 Workbench `/traces#<token>` 頁面與 token-protected `GET /api/traces`，可查看最近 search／answer、篩選類型／狀態、phase bars、counts、bottleneck、錯誤碼與 raw JSON。
- 每次完成的 search／answer trace 追加至索引資料目錄的 `trace.log` UTF-8 JSONL；每檔 2 MiB、目前檔加 4 個輪替檔，避免無界成長。Windows 預設為 `%LOCALAPPDATA%\LocalDocSearch\trace.log`，`LOCALDOCSEARCH_DATA_DIR` 仍沿用既有資料目錄選擇。
- logger 失敗不得破壞搜尋、answer 或唯讀索引結果；log 只保存 trace metadata，絕不保存 API Key、文件正文、context 正文、snippet 或 answer 正文。query／question 會保留在本機 log，因為沒有它們無法把慢查詢與特定 answer 事件對回來源。
- 不把 trace 寫入 SQLite 或 `--profile`，不新增第二套通用 logging framework；`trace-log.ts` 只負責有界 JSONL append／rotate／read，沿用既有 autoupdate log 的輪替邊界。
