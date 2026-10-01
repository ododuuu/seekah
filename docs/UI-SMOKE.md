# 工作台瀏覽器煙霧測試

## 執行

在本 worktree 的專案根目錄執行：

```text
npm run build
node scripts/ui-smoke.mjs
```

腳本不是 `npm test` 的一部分，因為需要本機 Chrome／Chromium 與 CDP。預設尋找 Windows 常見的 Google Chrome 路徑；也可用 `SEEKAH_CHROME_PATH` 或 `CHROME_PATH` 指定執行檔。找不到瀏覽器時會印出明確原因並以非 0 結束。

## 測試資料與清理

每次執行會建立兩組獨立的合成根目錄，分別對應 1440×900 與 1180×800；先以 `dist/src/cli.js index <合成根目錄>` 建立索引，再以同一組暫存 `LOCALDOCSEARCH_DATA_DIR` 啟動工作台。資料包含一般文件、`.localdocsearchignore`、被使用者規則排除的文件、第一行／第八行分散命中的多段落文件、單一 passage、超過四詞的省略提示，以及分頁用的多筆文件。腳本不會讀取或使用使用者真實索引，也不會對真實資料目錄執行 `index` 或啟動背景更新。

Chrome profile 與合成資料在該次 viewport 檢查完成後刪除；截圖保留在腳本建立的暫存輸出目錄，腳本結束時會印出完整路徑。若要保留其他診斷資料，請自行複製截圖；腳本不會把它們寫入 repo。

## 檢查內容

- 初始載入等待 12 秒，監聽 CDP `Runtime.exceptionThrown`、`Runtime.consoleAPICalled` 的 `error` 與 `Log.entryAdded` 的 `error`；側邊欄不得停在「讀取中…」。
- 文件、臨時文件、根目錄、垃圾桶與設定頁都實際開啟；根目錄排除細節會展開並檢查規則與逐規則略過數，設定頁檢查政策清單。
- 驗證有結果與零結果搜尋；有結果時以 CDP Selection API 選取檔名、既有高亮片段與 `all-terms` 多段落片段，確認文字原樣、位置／詞標籤不會混入 passage snippet、選取檔名不會送出 `open`，清除選取後仍可開啟；列表／表格都檢查兩段 passage、`mark`、清單／aria 語意與複製控制，並攔截 `navigator.clipboard.writeText`，確認「複製路徑」保留含中文、空白與 emoji 的完整路徑，「複製檔名」保留原始檔名。另驗證單一 passage／phrase 外觀、`omittedTerms` 提示、搜尋模式切換、翻頁與已選上下文抽屜。零結果依序查詢合成根內的被排除路徑、已索引路徑與根外路徑。根外 `/api/explain` 回應另外確認不含 `exists` 欄位。
- 攔截 `/api/select-folder`：合成資料夾只選取、不送出建立索引；再模擬 `C:\`，確認「會預設略過哪些位置」預覽與兩步確認流程。
- 在合成根內新增／修改／刪除文件後，攔截資料夾選擇器回傳子資料夾，實際執行重新檢查，檢查新增、更新、移除、略過四類計數與根目錄數量不增加。
- 兩種 viewport 各保存一張多段落結果 PNG 截圖。

## 限制

- 這是本機合成資料的 Chromium smoke，不是公司 Windows 真實資料驗收；不得據此宣稱公司 Windows 通過。
- 需要已編譯的 `dist/`、可執行的 Node.js 22 內建 WebSocket 與本機 Chrome／Chromium；不適合無瀏覽器的 CI。
- 不建立或確認新的永久索引根目錄；加入資料夾流程只驗證選取、預覽與確認按鈕，不按下確認建立索引。
- 測試只涵蓋目前工作台畫面與指定 API 流程，不取代既有 `npm test`、HTTP 契約測試或完整格式解析測試。
