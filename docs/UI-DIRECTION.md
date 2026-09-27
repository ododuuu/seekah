# LocalDocSearch 操作介面方向

更新：2026-09-23。0.34.0 已將標準 MCP App 搜尋／勾選／加入上下文接上既有唯讀工具；0.35.0 因拖曳檔案、精確預覽與 session-only Provider 設定的實際需求，已新增受保護的 localhost 工作台。TUI、headless MCP 與 MCP App 都保留。

## 建議結論

目前四個入口各有清楚用途：CLI 供腳本化、TUI 供零 port 鍵盤操作、stdio MCP／MCP App 供 AI Host 內選取、localhost UI 供拖曳與較完整預覽。0.35.0 的遠端 AI API 是明確選配；沒有 Key 時本機搜尋、解析、預覽與複製仍完整可用。不要新增依賴外部網站才能啟動的殼，也不要把本機 UI 暴露到 LAN。

## 為何先做終端互動介面

- 沿用現有 Node.js／TypeScript、`docsearch.cmd`、SQLite 與 CLI service，不需要管理員、安裝程式或額外瀏覽器政策。
- 不開本機連接埠，攻擊面與公司環境阻力較小；斷網仍可完整使用。
- 最快把既有功能組成單一工作區：輸入查詢、列表／分頁、`/` 縮小、back／reset、open／reveal、context 選取、roots、status 與 autoupdate。
- 可先使用 Node readline／ANSI 與鍵盤操作，避免為外觀引入大型 GUI framework；非 TTY 時保留既有命令與可腳本化輸出。

## localhost Web UI 的採用理由

使用者已明確要求拖曳檔案作上下文及 Provider 操作面；這是 MCP App sandbox 與終端 TUI 不適合承擔的大檔輸入流程，因此 0.35.0 新增本機 Web UI。它由 LocalDocSearch 提供，只綁定 `127.0.0.1`，每次啟動使用隨機 token，不接受 LAN 連線、不載入 CDN；只有預覽並同意後才可選擇把內容送到固定 AI API。

Web UI 的 port、瀏覽器啟動、CSRF／token、CSP、生命週期及公司端點防護風險已由 loopback、fragment token、Host／Origin、嚴格 CSP、Ctrl+C 清理與自動測試建立第一版邊界；Windows 端點政策仍需公司實機驗證。

## localhost 工作台視覺基準

正式桌面工作台以 `design/ui-directions/paperless-inspired.html` 為視覺基準：58px 品牌列、246px 側欄、Paperless 式高密度文件清單、分割文件詳細頁、表格式根目錄管理，以及一致的垃圾桶與 modal 對話框。正式介面只呈現 server 真實提供的資料與操作；demo 中沒有後端契約的分數、完整文件內容或單檔刪除不得偽造。

## 建議分期

1. 使用者後續明確要求同版完成；0.32.0 已交付 XLSM／ODT／RTF／CSV 與純 Node 終端互動介面。
2. 後續介面功能持續經既有 application service／`SearchSession` 擴充；CLI 保持相容，介面不直接操作 SQLite schema。
3. 在公司 Windows 驗證鍵盤、中文輸入、終端尺寸、open／reveal 與背景狀態。
4. 0.33.0 已補 `/select`／`/context` 與 MCP；0.34.0 已完成相容 Host 內的 MCP App 選取介面、安全註冊與唯讀診斷。Host 不支援 UI 時，headless tools 與 TUI 仍完整可用。
5. 0.35.0 已依明確拖曳／預覽需求交付 localhost UI；後續優化依 `NEXT-TODO.md`，不把四個入口重寫成四套核心。

## 必要安全界線

- 介面只顯示使用者主動搜尋到的索引內容，不預載整庫正文。
- 預覽、剪貼簿及 context 沿用既有明確選取與確認；不得自動傳送至 AI 或聊天平台。
- 日誌不得記正文；公司文件與索引不得上傳。
- GUI／Web/TUI 都必須共用既有搜尋、根目錄、安全開啟、writer lock 與 autoupdate 契約，不另寫第二套索引核心。
