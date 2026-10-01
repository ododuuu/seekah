# Seekah 後續優化清單

- [x] 產品更名 Seekah；新舊 CLI 入口共用同一索引與設定，保留儲存／協定識別。
- [x] 核准 TUI 規格與互動稿存入 [design/](design/SEEKAH-TUI.md)，交接集中 [handoff/CURRENT.md](handoff/CURRENT.md)。
- [x] 在 0.36.1 落地核准的整體排版與完整焦點／鍵盤操作，不只增加 /select 或 /next；已以 80×24、120×40 render fixture 與真實 PTY 終端轉錄驗收。

更新：2026-10-01。程式基線為 0.45.0（搜尋結果可複製、Toggle 開關、多段落結果、開啟工作台補更新提醒）。公司 Windows 未驗項保留。

## 研究：搜尋架構 prototype（2026-09-27，ADR 前）

- [x] A／B／C1／C2／D 在真實 store snapshot 上建置、2,000 查詢差分、延遲、成本模型與 migration 等價；見 [PROTOTYPE-RESULTS.md](research/search-architecture-2026-09-27/PROTOTYPE-RESULTS.md)。
- [x] 0.38.0 已依 D081 實作 C2-hybrid（SPEC §50），並修正 U+0000 查詢錯誤。
- [x] 0.39.0 已依 D083 改用區段儲存、不記位置索引與提前停止（SPEC §52）。
- [x] 0.39.1 已依 D084 讓背景自動更新不監看、不處理被排除資料夾的事件，並為防抖設上限（SPEC §53）。
- [x] 0.39.2 已依 D085 讓局部更新分批、每批只等一次穩定時間（SPEC §54）。
- [x] 0.39.3 已依 D086 忽略資料夾修改事件並輪替局部更新待辦（SPEC §55）。
- [ ] 0.39.3 真實環境：Codex／Grok 大量寫入期間，status 的局部更新持續前進、不再長時間停在單一子樹掃描。
- [x] 0.39.4 已依 D087 把新資料夾分批展開成逐檔待辦（SPEC §56）。
- [x] 0.40.0 已依 D088 把工作台搜尋結果改為搜尋引擎式列表（SPEC §57）。
- [ ] 工作台結果列加上同一份文件的第二段片段（需伺服器產生；先看 0.40.0 列表再決定）。
- [ ] MCP 改為傳檔案路徑讓 Codex 自己讀檔（使用者 2026-09-29 表態，明確表示之後再處理；需另寫 SPEC）。
- [ ] 以檔名命中為代表的結果，內文也有命中時顯示內文片段（目前只顯示「檔名符合」）。
- [ ] 逐檔處理的穩定等待佔每輪約四分之一：移入大量檔案時整體處理完比整棵同步慢約 1.8 倍，可研究讓等待與處理重疊。
- [ ] 0.39.2 真實環境：重啟 `autoupdate` 後，Codex／Claude 大量寫入期間新建檔案可在數十秒內搜尋。
- [x] 0.41.0 已依 D091 將「失敗scope」拆成「讀取失敗」與「延後核對」（SPEC §60）。
- [ ] 0.39.1 真實環境：以新版重新啟動 `autoupdate`，確認 `C:\Users\mains` 為 split、`AppData` 無 watcher、CPU 回落、背景校正「剩餘範圍」會前進到完成。
- [ ] 0.39.0 公司 Windows 驗收：舊 index 遷移時間與壓縮後大小、常見詞第一頁延遲、精確總數、Workbench 202→自動重送與總筆數設定。
- [x] 0.38.1 已依 D082 修正大量刪除效能（SPEC §51）。
- [x] 0.41.0 已依 D090 讓遷移交易遇到 SQLITE_BUSY 時有限重試（SPEC §59）；開啟資料庫的初始化仍不重試。
- [x] 0.43.0 已依 D097～D099 處理背景更新主庫 SQLITE_BUSY、主索引 WAL 與有上限等待、入口不再顯示 SQLite 原文（SPEC §65～§67）。
- [ ] 0.38.0 公司 Windows 驗收：舊 index 遷移時間、索引大小、`SPEC.md`／`測試`／常見詞延遲、Workbench 202→自動重送。
- [ ] 仍待處理（原 ADR 前補證清單）：公司 Windows 實機；all-terms／`field`／`sort`／type／root／subtree 等價；top-K／total count 語意（`e` 156,218 筆約 3.3 s）；C2 大小縮減（optimize、columnsize、token 設計）；巨大 block 的 offset snippet；建置串流 tokenizer（峰值 RSS 約 2 GiB）；大型 xlsx 的每文件 upsert 延遲。
- [ ] 所有使用中的 index 都遷移後，移除遷移期舊搜尋路徑（Bloom／文件級 postings）程式碼。


## 2026-09-30 背景更新修正後續（第二階段之後）

- [x] 整顆磁碟根目錄預設排除（§71／D103）、排除可見性（§74／D106）、手動重新檢查資料夾（§75／D107）、積壓順序（§73／D105）已在 integrate/queue-fixes 完成。
- [ ] **仍未解決：監看漏事件**。`fs.watch` 在約 300 events/s 下有時不交付目標檔名（產品實測約 1/3，失敗那次目標事件 0、空檔名 168）。**0.44.1 研究結論**：獨立重現器（`scripts/watcher-loss-repro.mjs`，獨立 writer 程序、140 個頂層資料夾、50／150／300／600 writes/s、持續 60 秒）**重現不出目標遺失（0／3，各拓撲）**；空檔名事件在約 300 writes/s 以上出現、隨速率與時間增加，但**不能證實是 `ReadDirectoryChangesW` 緩衝溢位**；只監看 `Users`（雜訊資料夾不在監看範圍內）時空檔名為 0；Node 22／libuv 1.51.0 沒有可調緩衝的公開選項。**預測**：使用者 `C:\` 在 0.44.x 預設排除後，14 個頂層資料夾有 7 個被排除、7 個可監看，應改為逐資料夾監看，待部署後用 `autoupdate status` 確認並觀察是否仍漏事件。**已否決的做法（實測反證，勿重試）**：(1) 按子目錄 mtime 優先走訪；(2) 校正遇到近期檔案改走局部佇列。**尚未試**：空檔名事件視為「watcher 不確定」，以事件來源資料夾（非 mtime）作為熱目錄提示，優先做有界 shallow rescan；需另寫 SPEC。
- [x] 工作台前端瀏覽器煙霧測試（`scripts/ui-smoke.mjs`，30 項，1440×900 與 1180×800，含零結果提示與檢查欄、explain、加入資料夾與整顆磁碟預覽、重新檢查資料夾）；**發版前必跑**。尚未涵蓋：搜尋取消／進度、索引進行中的輪詢畫面、垃圾桶還原、設定頁各開關的實際操作。
- [ ] 工作台搜尋沒有取消與進度：新搜尋不會中止舊搜尋（前端只有 `searchSeq` 忽略舊回應，`fetch` 沒有 `AbortSignal`，伺服器端沒有逾時／取消）；慢搜尋期間畫面只有「讀取中」。
- [ ] `GET /api/index-status` 縮小 payload（5.4 MB → 19.6 KB）後仍約 2 秒，剩餘時間未查明（資料庫讀取各段加總不到 1 秒）；索引進行中畫面每 0.75 秒輪詢一次。
- [ ] 長數字無結果搜尋連續 10 輪 p95 約 4.05 秒（目標 2 秒），熱點是重複 zstd 解壓與 GC；極端壓力（20 萬 chunk 命中）RSS 峰值比舊版高約 47%。是否值得再優化（例如保留已解壓內容的有界快取）待使用者決定。
- [ ] 搜尋差分測試腳本（scratchpad 的 `search-diff.mjs`）不在 repo；下次改搜尋程式前需重建等價的新舊比對，或把它整理進 `scripts/`。
- [ ] xAI（Grok）額度用完（403 spending-limit），`grok` 手下不可用，需使用者充值才能恢復。
- [ ] 多段落結果：(1) 目前取各詞「第一次出現」，可改為挑最靠近另一個詞的那一次；(2) 位置標籤欄偏寬、離片段有距離；(3) 長文件一頁約 2 倍處理時間（當頁每份文件完整讀回 blocks）；(4) 使用一陣子後再評估是否需要硬性「N 行內」鄰近搜尋（有序／無序、非程式碼檔以段落計）；不做正規表示式（五十萬筆規模太慢且不易用）。
- [ ] 開啟提醒與開機補捉：真實登入流程與登入啟動捷徑、整顆 `C:\` 上「補上遺漏」的實際耗時與資源只有本機模擬；TUI／CLI 沒有同樣提醒（只可用 `--startup-catchup`）。
- [ ] 設定頁其餘非開關型控制（下拉選單等）是否也要統一風格，待使用者回饋。
- [ ] 已知限制：8.3 短檔名（`PROGRA~1`）不會被預設排除；`subst` 的磁碟會被當成磁碟根；MCP `explain_path` 沒有工作台 token，任何本機 MCP 客戶可查已登錄根內路徑的索引狀態（根外已不回報存在與否）。
- [ ] `status` 輸出新增「逐規則略過」「既有索引排除清理」「排除摘要」等行；依行號或固定前綴解析 `status` 的外部腳本可能位移。
- [ ] 公平輪替（§68）與 §73 的整合在磁碟根規模下沒有實測；校正與局部更新交錯、待辦上千筆時的行為只有單元測試。
- [ ] `LiveUpdateEngine` 建構時 `cleanupOrphanRoots` 無 try/catch；工作庫損壞或鎖住時 engine 可能起不來（推測實害低，雙程序已有 lease）。
- [ ] 使用者現有索引若曾在佇列安靜時跑過舊版背景校正（§70 修正前），可能有被誤移除的文件；重新 `index` 可補回（來源檔未被刪）。
- [ ] 使用者若需要索引被預設排除的位置：目前只能移除父磁碟根、改登錄窄根目錄（父根存在時窄根不能 override）。若這不夠用，需另立提案設計每根的明確 opt-in。
- [ ] 公司 Windows 人工驗收（含預設排除對真實 `C:\` 的效果、既有索引清理耗時、工作台畫面）尚未回報。

## 0.43.0 後續

- [ ] `compact` 仍在 `cli.ts` `main` 的 try／catch 外；SQLITE_BUSY 可能未轉成 INDEX_BUSY。
- [ ] `live-update.ts` 的 `rememberError` 尚未對 776／1288／1294 分類；recovery 類仍可能記成 `LIVE_UPDATE_FAILED` 加 SQLite 原文。`autoupdate.ts` `formatLiveStatus` 只把含 `database is locked` 的舊項目換成固定句，是治標。
- [ ] 寬查詢 soak（含寫入者）HandleCount 675→724 來源未查明：只有讀取者的對照（main 舊版與 WAL 版皆 220／224 固定）未重現，懷疑在寫入者或 checkpoint 嘗試。讀取者 RSS 緩升在 main 舊版同樣存在（約 100→145 MiB），推測為 SQLite 原生快取與 mmap（`cache_size` 64 MiB、`mmap_size` 1 GiB），非 JS 洩漏，未用 handle 工具證實；可評估降低唯讀連線的 `cache_size`／`mmap_size`。
- [ ] 正常關閉後 `-wal` 仍可能殘留（窄查詢約 1.0 MiB、寬 10 分鐘 28.1 MiB、寬 20 分鐘 11.5 MiB）。推測因最後關閉者為唯讀連線、未做可寫 checkpoint；可寫重開後可清除。未確認所有關閉順序。
- [ ] 方案 B（單一擁有者程序）與 C（不可變區段＋原子切換）仍為長期選項，0.43.0 未採用。理由：WAL＋有界等待已消主路徑讀擋寫，換引擎或單程序會大幅重寫 FTS／多入口（CLI、工作台、MCP、autoupdate）。觸發條件：WAL 在真實寬查詢下不可接受地成長、或公司環境禁止 WAL sidecar。
- [ ] `.writer.sqlite`、`.live.sqlite`、`.work.sqlite` 是否也該 WAL 未定；目前仍零等待 rollback／既有 live-queue WAL，與主庫策略不同。
- [ ] **背景更新進行中搜尋變慢**：安靜環境重測整合版 p50 約 3.9 秒，main／補丁約 2.4～3.2 秒（靜止時相同）。候選原因：唯讀連線每次新開需讀 wal-index、autocheckpoint 與 4 路並行交互、寫入者與讀取者搶 CPU（機器 CPU 最大僅約 40%）。建議：用 `node --cpu-prof` 與逐階段計時對照 rollback／WAL，並試 `wal_autocheckpoint`、唯讀連線 `mmap_size` 的影響；確認在真實資料量下是否重現。
- [ ] 工作台 `/api/index-status` 沒有儲存容量欄位，不會列出 `-wal`／`-shm`（只有命令列 `status` 會）；實測資料目錄穩態約主庫 2 MB、`-wal` 4 MiB、`.work.sqlite-wal` 約 4 MiB。
- [ ] INDEX_BUSY 固定訊息已集中到 `index-errors.ts`（工作台、worker、MCP、TUI、autoupdate 出口）。剩餘：CLI `compact` 未走同一 catch；`rememberError` 未分類 recovery。

## 已完成：0.36.2 GUI

- [x] 使用者核准工作台設計；SPEC §47、D059 與固定交接完成。
- [x] 正式三區 GUI、搜尋／分頁／選取、命中預覽、臨時文件與真實唯讀狀態。
- [x] 精確上下文只供本機預覽／複製（D066）；GUI 不提供 Provider、送出或 AI 回答。
- [x] 本機瀏覽器操作、聚焦回歸、package 升至 0.36.2 並推送 GitHub；詳見 handoff/0.36.2.md。公司 Windows 實機複驗仍屬 P0。

## 已完成：0.36.1 correctness／UX

- [x] 完整 scan、watch／local update 共用 exact Windows volume-root exclusions；相似名稱與巢狀普通目錄不誤排除。
- [x] scan 回報最小失敗 scope；不可讀 subtree 保留，正常 sibling 已刪文件移除；root failure 與 rebuild 保留既有資料。
- [x] `--profile` 保留 exclusive create／不建父目錄，錯誤提供安全 parent、code 與 CMD／PowerShell 範例。
- [x] TUI 建立 focus／cursor／key event 層，支援方向鍵、選取、預覽、翻頁、返回、focus 切換、q、Ctrl+C／EOF；slash fallback 與 context `yes` 保留。
- [x] README、STATUS、DECISIONS、HANDOFF 與 `0.36.1-VALIDATION.md` 已更新；package／lockfile 升至 0.36.1。
- [ ] 公司 Windows 以無機密測試樹驗證 sibling 權限失敗、系統目錄排除及 80×24／120×40 TUI；不得以本機 PTY 代替。

## 進行中：0.37.0 performance／daily incremental／GUI 加入根目錄

- [x] 0.37.0 版本契約寫入 SPEC §46.0～§46.11（含 GUI 加入根目錄畫面、忙碌拒絕與驗收）。
- [x] **實作工作台加入新資料夾**（SPEC §46.11／D068／D072）：已有索引時，索引狀態頁按「選擇資料夾」開啟本機資料夾選擇器，選完後按「確認並建立索引」才開始；重用 `POST /api/index`；進行中可見拒絕 409，取消或未確認不送出。無效路徑既有根不變；臨時文件仍不入永久索引。公司 Windows 人工選取真實資料夾待驗。
- [x] **實作工作台根目錄刪除與垃圾桶**（SPEC §46.11.6／D073）：已索引根目錄可勾選／全選後移除至垃圾桶；預設確認對話框支援「下次不再提醒」，設定可重新開啟；來源不刪除；垃圾桶可重新索引還原或永久刪除 metadata。聚焦工作台測試與 Chromium UI smoke 已完成。
- [x] **階段 1 基線（2026-09-25）**：`--profile` 寫入 enumerate／stat／parse／compress／bloom／write／commit；本機合成資料三次量測。檔案事件走 `applyPathChange`／局部更新，status 顯示事件／局部更新／根目錄掃描與下次完整校正。公司大型庫 profile 仍待實機。
- [x] 驗證既有 `autoupdate`：啟動校正完成後，單檔新增／修改／刪除走事件路徑；20 次 add／modify／delete 的 fake watcher 基線 root scan 為 0，搜尋可見延遲 < 15 秒。未知 filename 仍校正整根。status 含最後事件、局部更新、上次／下次完整校正。
- [x] 文件化：`index` 是立即完整校正；`autoupdate start` 是已初次索引使用者的日常路徑。USER-GUIDE／CLI help／README 已更新。
- [x] 持久事件 queue（階段 2）：獨立 `.work.sqlite`、世代 ack、downtime gap、10,000 路徑 dirty scope、落盤失敗降級。停止期間未落盤的變更仍靠下次啟動校正補回。
- [x] mixed long＋short `--all-terms`：以所有不在檔名中的必要長詞安全排除文件候選；混合短詞仍全文精確核對。覆蓋中英文字、檔名命中、跨 block／payload、舊／缺 Bloom、全部短詞與結果集合等價；固定資料 benchmark 證據仍補於驗證文件。
- [x] 按 SPEC §46.7 前半建獨立本機工作狀態庫：queue 世代、commit 後 ack、冪等重播、10,000 路徑上限與 dirty scope；測 crash、落盤失敗、新事件與舊 ack 競態、根隔離。
- [x] 拆分 root 直屬與子目錄 watcher scopes，handle 上限 128 與 coarse fallback；可定位的未知事件只補掃該子樹。
- [x] 按 §46.8 實作 directory frontier／generation、可中斷分批校正、事件優先與公平排程，釋放批次間 writer lock；測掃描與事件交錯的安全刪除、離線 gap、重啟與失敗 sibling。
- [x] `autoupdate startup enable|disable|status`：Windows 目前使用者 Startup 捷徑，冪等／擁有權／路徑安全／政策拒絕；不得提權或安裝 Service。公司 Windows 真正登出登入仍待實機。
- [x] 更新 README、USER-GUIDE、0.37.0 驗證文件與交接狀態；[ ] 公司 Windows 普通帳號驗收流程仍待實機。USN 已依 D056 移出本版，勿再研究或要求管理員。parser 分流不重做，Paperless managed library 不納入。

- [x] **FTS5 ngram postings 搜尋後端（本批，SPEC §48／D076）**：unigram／trigram postings 作第一候選來源；exact／phrase／all-terms／檔名／snippet／stable reference、64 KiB payload 邊界與既有 pruning 保留。upsert／replace／delete 清理 postings；舊索引逐文件可取消／接續 migration；Workbench 對待升級 index 回 202 並自動重送。`m38`、既有 payload／Workbench focused tests、Chromium 202→resubmit smoke 與 baseline benchmark 已完成；最終 `npm test` 298 項為 293 通過、2 既有 win32 環境失敗、3 略過。
- [x] **搜尋與 answer Diagnostics／Performance Trace（SPEC §49／D077-D078-D080）**：沿用既有 trace/log 契約；搜尋完整接入 postings／restricted ids、document／payload Bloom、payload lookup／decompression、exact verification、ranking、snippet 與 passage lookup；answer 接入 context／preview validation、provider／fallback、response parsing。search schema 3 提供 `phasesMs` inclusive、`phaseSelfMs` self、self／inclusive bottleneck、`payloadReadPasses`、`postingPayloadHits`、`expandedPayloads`、`fullDocumentFallbacks`、`filenameOnlyFallbacks`、`blockExpansionRatio`；實證 postings 只傳 document IDs，block reconstruction 不是每 payload N+1，page reread 會使 `payloadsRead` 與 `payloadsConsidered` 分離。程式內、MCP／Workbench response、`WorkbenchHandle.lastAnswerTrace()`、CLI `search --verbose`、獨立 `/traces` UI 與 `/api/traces` 可見；m38／m39 focused regression、logger rotation、Trace UI Chromium smoke 與編譯 CLI 實際 smoke 成功；公司 Windows 大型庫仍待。
- [x] **Workbench 索引可回應／可恢復（SPEC §47.6／D079）**：手動索引由 worker thread 執行，`indexing.json` 原子保存狀態與進度；dead PID 重開顯示中斷並保留已提交文件；UI 每 750 ms 輪詢且保留 busy／locked 前次狀態。`m35`／`m37` 18 項與 1,200 份 Chromium smoke 通過；公司大型格式／30 萬檔 profile 仍待。

## P0：外部環境與真實資料證據

- [ ] 保留 0.36.0 已確認事實：舊索引沿用、文字升級只一次、約 299,530 未變更零 parse。後續回歸若破壞任一項即阻擋交付。
- [ ] 公司 Windows 驗證 0.31.0 背景更新、0.34.0 MCP App、0.35.0 localhost UI／拖曳／清理；不得以 macOS 測試代替。
- [ ] PDF／PPTX／XLS 真實錯誤只在公司電腦依 `COMPANY-WINDOWS-DIAGNOSTICS.md` 診斷，建立無機密最小重現後再修 parser。
- [ ] MSG_FORMAT_ERROR、OFFICE_MISSING_PART、PDF_CORRUPT、PDF_PARSE_ERROR、RTF_INVALID、TEXT_DECODE_ERROR、XLS_FORMAT_ERROR、XML_DECODE_ERROR、FILE_READ_FAILED 與固定 error retry policy 暫不併入 0.36.1／0.37.0。
- [ ] 若公司政策允許，用無機密合成文字實測 OpenAI／xAI API 的 model 權限、代理、速率限制、錯誤訊息與帳務；目前只有假 fetch 自動測試。

## P1：工作台實用性

- [ ] 若使用者未來明確要求聊天助手，先另定 Provider、帳務、確認、Key 與外傳資料邊界；目前 GUI 不提供這項功能。
- [ ] 拖曳文件的段落／頁面／工作表細選、單檔文字預覽與去重，而不是只按文件整份依 256 KiB 截短。
- [ ] UI 增加副檔名／根目錄篩選、已選籃排序、鍵盤快速鍵、窄螢幕與螢幕閱讀器實機驗證。
- [ ] token／context 預估與上限提示；byte 上限仍是安全硬限制，不以估算取代。

## P2：隱私與部署選配

- [ ] 本機模型 provider（例如經核准的 Ollama／llama.cpp endpoint）需另定版本、健康檢查、模型能力與任意 URL／SSRF 邊界；不可直接開放自訂 URL。
- [ ] 若官方未來提供適合第三方桌面程式的 OpenAI／xAI OAuth，再另案實作 PKCE、callback、token storage 與撤銷；目前不做 cookie、密碼代登或假「訂閱登入」。
- [ ] Windows 全套安裝器與一般應用捷徑仍屬後續部署選配；目前使用者的可選登入啟動已納入 0.37.0 §46.9，不由 Web UI 自行註冊。
- [ ] OCR、圖片、資料夾拖曳與舊版 Office 新格式仍未納入；只有真實需求與安全 parser 方案明確時才排入，不無限擴格式。
## P3：最後處理的 TUI 易用性

- [ ] 使用者已回報 TUI 互動不直覺；在 GUI 索引、搜尋與複製工作流穩定後，最後再依實際痛點重做，不在目前批次變更 TUI。


## 明確不是缺陷

- ChatGPT Plus／Pro 與 OpenAI API 分開計費；SuperGrok／X Premium 與 xAI API 也分開。無法用消費訂閱額度不應以抓 cookie 或模擬登入規避。
- 工作台不保存對話、API Key 或拖曳內容是刻意的隱私設計；若日後要保存，必須先定義加密、刪除與公司資料治理。
- 0.35.0 不把本機 server 暴露至 LAN／Internet，也不讓任意 endpoint 代理請求；遠端 ChatGPT 網頁仍不會直接讀本機索引。
