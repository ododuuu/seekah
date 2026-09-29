# 目前交接：Seekah 0.42.0（搜尋候選延遲載入、局部更新鎖外準備、背景校正批次寫入進度）

更新：2026-09-29。

**package 為 0.42.0。效能審查前三項：搜尋候選由 SQL 串流排序並延遲載入（SPEC §62／D094）、局部更新在 writer lock 外準備並有界群組提交（§63／D095）、背景校正進度批次提交（§64／D096）。純效能、行為不變。公司電腦 0.41.0 升級時的 database is locked 仍在收集資料。公司 Windows 人工驗收尚未回報。**

- 從 [0.42.0.md](0.42.0.md) 開始：範圍、已完成、審查紀錄、限制與下一步。
- [0.42.0 驗證](../0.42.0-VALIDATION.md)：測試、反向驗證與量測。
- 本批已檢視使用手冊：無使用者可見操作變更，未修改。

## 0.41.1 交接

**package 0.41.1 時的狀態：背景自動更新每批局部更新只載入一次排除規則（SPEC §61／D092），純效能、排除結果不變；規則檔錯誤時維持原本逐檔載入並失敗。公司 Windows 人工驗收尚未回報。**

- 從 [0.41.1.md](0.41.1.md) 開始：範圍、已完成、審查紀錄、限制與下一步。
- [0.41.1 驗證](../0.41.1-VALIDATION.md)：測試與反向驗證。
- 本批已檢視使用手冊：無使用者可見變更，未修改。

## 0.41.0 交接

**package 0.41.0 時的狀態：工作台設定頁可開關登入啟動、查看背景自動更新健康摘要、調整變更等待與完整校正間隔（SPEC §58／D089）；遷移遇到 SQLITE_BUSY 時有限重試（§59／D090）；背景校正區分讀取失敗與延後核對（§60／D091）。本版首次以平行分支開發並由審查者合併（D093）。公司 Windows 人工驗收尚未回報。**

- 從 [0.41.0.md](0.41.0.md) 開始：範圍、已完成、限制與下一步。
- [0.41.0 驗證](../0.41.0-VALIDATION.md)：各分支與合併後測試、m48 反向驗證、設定頁截圖檢視。
- 本批已檢視並更新使用手冊：設定頁、`autoupdate status` 失敗類型解讀、常見問題。

## 0.40.0 交接

**package 0.40.0 時的狀態：工作台搜尋結果只留檔名、路徑列與約兩行片段，點檔名直接開啟原檔，移除明細頁與預覽紙（SPEC §57／D088）；只改前端，搜尋 API 不變。已在無介面 Chrome 截圖並驗證點擊行為。公司 Windows 人工驗收尚未回報。**

- 從 [0.40.0.md](0.40.0.md) 開始：範圍、已完成、限制與下一步。
- [0.40.0 驗證](../0.40.0-VALIDATION.md)：測試、瀏覽器截圖與點擊驗證。
- 本批已檢視並更新使用手冊：工作台版面、搜尋與開啟原檔。

## 0.39.4 交接

**package 0.39.4 時的狀態：新建、移入或改名的資料夾不再一次整棵同步，改為每輪最多讀 2,000 個目錄項目、展開成逐檔待辦，並排在事件待辦之後（SPEC §56／D087）。真實 fs.watch 量測：移入約 420 MB 資料夾後新建的筆記 4.4 s 可搜尋（0.39.2 為 112.6 s），但整個資料夾處理完約慢 1.8 倍（211 s 對 117 s）。公司 Windows 人工驗收尚未回報。**

- 從 [0.39.4.md](0.39.4.md) 開始：範圍、已完成、限制與下一步。
- [0.39.4 驗證](../0.39.4-VALIDATION.md)：測試、移入資料夾量測與取捨。
- 本批已檢視並更新使用手冊：日常變更一節（新資料夾分批展開、事件優先）。

## 0.39.3 交接

**package 0.39.3 時的狀態：資料夾 `change` 事件在內容已被監看時忽略，不再觸發重複的整棵子樹掃描；局部更新輪替處理待辦；每輪處理時間從穩定等待之後起算（SPEC §55／D086）。合成量測與 0.39.2 相當，沒有重現使用者 `.grok` 單次掃描數分鐘的規模，實際改善待使用者環境確認。公司 Windows 人工驗收尚未回報。**

- 從 [0.39.3.md](0.39.3.md) 開始：範圍、已完成、限制與下一步。
- [0.39.3 驗證](../0.39.3-VALIDATION.md)：原因實測、測試、量測過程中修正與否決的做法。
- 本批已檢視並更新使用手冊：日常變更一節（資料夾修改事件、輪替）。

## 0.39.2 交接

**package 0.39.2 時的狀態：局部更新每批只等一次穩定時間、變動中的檔案延後而不原地退避、輪與輪之間釋放 writer lock（SPEC §54／D085）；真實 fs.watch 量測 2,500 檔湧入後新檔 41.7 s 可搜尋（0.39.1 在 180 s 內沒有，推估約 67 分鐘）。公司 Windows 人工驗收尚未回報。**

- 從 [0.39.2.md](0.39.2.md) 開始：範圍、已完成、限制與下一步。
- [0.39.2 驗證](../0.39.2-VALIDATION.md)：測試與新舊版湧入量測。
- 本批已檢視並更新使用手冊：日常變更一節（大量檔案湧入時的處理方式與延遲）。

## 0.39.1 交接

**package 0.39.1 時的狀態：背景自動更新不再監看、處理 `.localdocsearchignore` 排除的資料夾，防抖最長等待 10 倍（SPEC §53／D084）；真實 fs.watch 量測 split 模式 CPU 37% → 1.4%，一般檔案由「從未更新」變為 3 秒可搜尋。公司 Windows 人工驗收尚未回報。**

- 從 [0.39.1.md](0.39.1.md) 開始：範圍、已完成、限制與下一步。
- [0.39.1 驗證](../0.39.1-VALIDATION.md)：測試與新舊版 fs.watch 量測。
- 本批已檢視並更新使用手冊：日常變更一節（被排除資料夾不監看、規則變更重建、15 秒上限）與 status「已排除事件」說明。

## 0.39.0 交接

**package 0.39.0 時的狀態：本版改用壓縮區段儲存與區段級不記位置索引，搜尋找滿即停（SPEC §52／D083）；真實資料 4.09 GB → 132.8 MiB，結果與 0.38.1 完全相同。總筆數預設快速、可切換精確。公司 Windows 人工驗收尚未回報。**

- 從 [0.39.0.md](0.39.0.md) 開始：範圍、已完成、限制與下一步。
- [0.39.0 驗證](../0.39.0-VALIDATION.md)：測試、真實資料遷移、大小、正確性與延遲。
- [索引大小研究](../research/index-size-2026-09-28/RESULTS.md)：方案比較與來源。
- 本批已檢視並更新使用手冊：升級說明（區段儲存與自動壓縮）、總筆數設定與 `--exact-total`／`exactTotal`、trace schema 5、`compact` 與「500 筆以上」的常見問題。

## 0.38.1 交接

**package 0.38.1 時的狀態：本版修正大量刪除效能（SPEC §51／D082）：外鍵子表索引、遷移記號完成即清除、刪除校正每 1,000 份分批提交。公司 Windows 人工驗收尚未回報。**

- 從 [0.38.1.md](0.38.1.md) 開始：範圍、已完成、限制與下一步。
- [0.38.1 驗證](../0.38.1-VALIDATION.md)：測試結果與真實 store 複本的刪除 benchmark。
- 本批已檢視並更新使用手冊：常見問題新增「排除大量檔案後同步較久」一列（刪除校正進度、可停止接續、檔案不縮小）。

## 0.38.0 交接

**package 0.38.0 時的狀態：本版以 block 級 FTS5 位置索引取代 Bloom／文件級 postings 候選（SPEC §50／D081），並包含從未單獨發布的 0.37.0 各階段。公司 Windows 人工驗收尚未回報。**

- 從 [0.38.0.md](0.38.0.md) 開始：範圍、已完成、限制與下一步。
- [0.38.0 驗證](../0.38.0-VALIDATION.md)：測試結果、真實 store 複本遷移與 benchmark、未驗證項。
- [搜尋架構研究與 prototype](../research/search-architecture-2026-09-27/PROTOTYPE-RESULTS.md)：選擇 C2-hybrid 的證據。
- 本批已檢視並更新使用手冊：舊索引升級（Workbench 202、CLI 寫入命令、唯讀 fallback）、索引大小變化、trace schema 4 的欄位說明。

## 0.37.0 歷史交接（已併入 0.38.0）

程式與 package／lockfile 仍為 0.36.2。正式工作台是 desktop-only 的 Paperless-inspired 資訊架構：58 px topbar、約 246 px 左導覽、中央文件頁與獨立明細 route；Preview list／Table 共用查詢與選取，已選上下文由 overlay drawer 開啟。根目錄、垃圾桶、臨時文件、設定與精確本機預覽均使用真實 loopback API；GUI 不顯示 Provider、model、API Key、AI question、送出或 answer。TUI 另依 SPEC §45.8／D063 改為 session-local 單欄 workflow。

- 已驗證的 GUI 安全邊界：nonce CSP、無外部資源、無 `innerHTML`／browser storage／cookie；文件操作只送 stable reference。

- [產品使用手冊](../USER-GUIDE.md)：安裝、索引、GUI、TUI、CLI、上下文複製與排錯的操作入口。
- 本批已檢視並更新使用手冊：日常 `autoupdate` 的 split／coarse 監看範圍、500 entries／250 ms 分批校正、status 進度欄位、可選 Windows 登入啟動與 all-terms 搜尋說明。
- [0.36.2 實作交接](0.36.2.md)：完成項目、驗證與禁止擴張。
- [給 Luna Max 的實作指令](PROMPT.md)：保留歷史入口，已由本批完成。
- [SPEC §47](../SPEC.md#47-0362核准的本機-gui-工作台改版)：行為權威，安全沿用 §43。
- [核准 GUI 設計說明](../design/SEEKAH-WORKBENCH.md)／[互動稿](../design/seekah-workbench.html)：後者仍是示範原型，不是驗收證據。
- [核准 TUI 設計說明](../design/SEEKAH-TUI.md)／[互動稿](../design/seekah-tui.html)：Claude Code 式資訊階層；後者明示示範資料，不是 runtime 驗收證據。
- [0.36.1 驗收交接](0.36.1.md)：保留歷史與公司 Windows 待驗，不阻塞本批。
- [0.36.2 驗證文件](../0.36.2-VALIDATION.md)：命令、瀏覽器操作、限制與未驗證項。
- [0.37.0 規格與交接](0.37.0.md)：日常變更發現、GUI 加入根目錄、根目錄刪除／確認／垃圾桶、階段 7、1、2、3、4、5、6 已完成；公司 Windows 仍待驗。
- [0.37.0 驗證](../0.37.0-VALIDATION.md)：階段 7、1、2、3、4、5、6 與根目錄刪除／垃圾桶的本機自動測試證據與未驗證限制。

- 本批 FTS5：`search_unigrams`／`search_trigrams` postings 先取文件候選，既有 exact／phrase／all-terms、filename、snippet、stable reference、64 KiB payload 與 pruning 保留。upsert／replace／delete 清理 postings；content 與 ngram migration 逐文件可取消／接續；read-only CLI／MCP 不寫。Workbench 待升級搜尋回 202，背景完成後自動重送。`m38`、payload／Workbench focused tests、Chromium smoke 與 baseline benchmark 已完成；最終 `npm test` 298 項為 293 通過、2 既有 win32 環境失敗、3 略過。
- 本批搜尋與 answer Diagnostics／Performance Trace 已升為 schema version 3：`SearchTraceRecorder` 另存 `phasesMs` inclusive、`phaseSelfMs` self、self／inclusive bottleneck；搜尋 trace 新增 `payloadReadPasses`、`postingPayloadHits`、`expandedPayloads`、`fullDocumentFallbacks`、`filenameOnlyFallbacks`、`blockExpansionRatio`。實測證實 FTS5 postings 只傳 document IDs，payload ordinal 由 `document_payload_blooms`／`document_payload_blocks` 獨立處理；`streamBlocksFor` 每次是 mapping query + payload query，不是每 payload N+1，但 page materialization 可重讀。`m38` payload ordinal expansion 與 `m39` nested timing／計數回歸已通過。
- 2026-09-27 完成 metadata／mapping overfetch optimization：filtered `streamBlocksFor` 使用 Q1 selected-preserving metadata CTE 與 Q2 complete owning-block closure，既有 reverse index hint 保留；Q1 compact projection 以 `ordinal IS NULL` 表達 missing marker，Map 在 payload lookup boundary 後建立。新增 `candidatePayloadOrdinals`、`owningBlocksFound`、`blockExpansionInputPayloads`；未新增 index／schema／cache。m23／m38／m39 focused 17 項通過；256-block fixture metadata 256→2、first page 256→4；SPEC.md metadata 1,652,374→1,442,468、standalone mapping 1,442,468→0、payload 4,638 不變。第二組專用 driver 的同 snapshot 3＋10 BEFORE／AFTER 結果 hash 相同，SPEC.md payloadLookup p50 0.804×、wall p50 0.889×，測試／稀有／不存在詞 p50／p95 gates 通過；raw samples／plans／RSS 見 `../metadata-mapping-optimization-2026-09-27-*.json`。本機 win32 evidence，不是公司 Windows 人工驗收。
- 本批 D079 修正 Workbench 索引假死與重開後未知進度：實際 `sync()` 由 worker thread 執行，`indexing.json` 原子保存進度／目前路徑／狀態，dead PID 重開標為已中斷但保留已提交文件；UI 每 750 ms 輪詢並在 busy／locked 時保留最後成功狀態。`m35`／`m37` 聚焦 18 項通過；本機 Chromium 1,200 份合成檔已驗證 POST 202、立即 status 200、重新整理中仍見 876／1200 與目前檔名、最後 complete、page errors 0。尚未代表公司大型格式或 30 萬檔 profile。
- D079 後基線的 `npm test` 原為 307 項；本批新增回歸後最終為 310 項：305 通過、M26 `path coverage` 與 M36 `profile chmod` 兩項既有 win32 環境失敗、3 略過；不能宣稱全套零失敗。

固定交接中心：[README.md](README.md)。GitHub 儲存庫為 [`ododuuu/seekah`](https://github.com/ododuuu/seekah)。0.37.0 後續只剩公司 Windows／大型庫實機驗收與版本升版決策；LocalDocSearch 資料目錄、parser selection、LAN 邊界與 Key 契約維持現況。
