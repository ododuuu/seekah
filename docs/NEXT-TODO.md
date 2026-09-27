# Seekah 後續優化清單

- [x] 產品更名 Seekah；新舊 CLI 入口共用同一索引與設定，保留儲存／協定識別。
- [x] 核准 TUI 規格與互動稿存入 [design/](design/SEEKAH-TUI.md)，交接集中 [handoff/CURRENT.md](handoff/CURRENT.md)。
- [x] 在 0.36.1 落地核准的整體排版與完整焦點／鍵盤操作，不只增加 /select 或 /next；已以 80×24、120×40 render fixture 與真實 PTY 終端轉錄驗收。

更新：2026-09-26。程式基線為 0.36.2；0.37.0 已開工。階段 7、階段 1～6（日常局部更新、持久 queue、有界 scopes、可接續分批校正、登入啟動、all-terms pruning）已完成；本批另完成 FTS5 unigram／trigram postings 後端，package 尚未升版。公司 Windows 未驗項保留。

## 研究：搜尋架構 prototype（2026-09-27，ADR 前）

- [x] A／B／C1／C2／D 在真實 store snapshot 上建置、2,000 查詢差分、延遲、成本模型與 migration 等價；見 [PROTOTYPE-RESULTS.md](research/search-architecture-2026-09-27/PROTOTYPE-RESULTS.md)。
- [x] 0.38.0 已依 D081 實作 C2-hybrid（SPEC §50），並修正 U+0000 查詢錯誤。
- [x] 0.38.1 已依 D082 修正大量刪除效能（SPEC §51）。
- [ ] 另案：遷移遇到 SQLITE_BUSY 直接失敗（`database is locked`），應可重試或等待。
- [ ] 0.38.0 公司 Windows 驗收：舊 index 遷移時間、索引大小、`SPEC.md`／`測試`／常見詞延遲、Workbench 202→自動重送。
- [ ] 仍待處理（原 ADR 前補證清單）：公司 Windows 實機；all-terms／`field`／`sort`／type／root／subtree 等價；top-K／total count 語意（`e` 156,218 筆約 3.3 s）；C2 大小縮減（optimize、columnsize、token 設計）；巨大 block 的 offset snippet；建置串流 tokenizer（峰值 RSS 約 2 GiB）；大型 xlsx 的每文件 upsert 延遲。
- [ ] 所有使用中的 index 都遷移後，移除遷移期舊搜尋路徑（Bloom／文件級 postings）程式碼。

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
