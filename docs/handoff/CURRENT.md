# 目前交接：Seekah 0.37.0 進行中（階段 7、1、2、3、4、5、6 已完成）

更新：2026-09-27。

**使用者已決定開始實作 0.37.0。package 仍為 0.36.2，待全部階段完成才升版。階段 7、1、2、3、4、5、6 與 desktop workbench clean cutover 已完成；本批另完成 SPEC §48／D076 FTS5 ngram postings，沒有 package 版本升級。公司 Windows 人工驗收尚未回報。**

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
