# 失敗 scope 拆分交付報告

## 修改檔案

- `docs/SPEC.md`：新增 §60，定義 `readFailures` 與 `deferredChecks` 的分類、`complete` 保守語意、持久化相容與 status 驗收；同步修正文 §46.8 的 status 用語。
- `docs/DECISIONS.md`：最上方新增 D091。
- `docs/USER-GUIDE.md`：補充 `autoupdate status` 的讀取失敗／延後核對解讀。
- `src/reconcile.ts`：目錄列舉與 IO／權限錯誤寫入 `readFailures`；檔案不穩定、待辦阻擋與尚未完成 scope 寫入 `deferredChecks`；兩類都阻止刪除核對並使 `complete` 為否。
- `src/live-queue.ts`：同一 `failed_scopes_json` 欄位改保存 `{readFailures,deferredChecks}` 物件；舊 JSON 陣列保守解讀為 `readFailures`，損壞或不完整資料標為 root 的延後核對。
- `src/live-update.ts`、`src/autoupdate-control.ts`、`src/autoupdate.ts`：status API／文字分開回報兩類數量。
- `test/m37-reconcile.test.ts`：既有讀取失敗斷言改用新欄位。
- `test/m49.test.ts`：新增 4 項測試，涵蓋兩類來源分計數、可讀 scope 的待辦延後、舊資料陣列相容與 status 文字。

## 測試

- `npm run build`：通過。
- `node --test --test-concurrency=1 dist/test/m49.test.js`：4 通過、0 失敗。
- `npm test`：共 350 項，345 通過、3 略過、2 失敗。2 項失敗均為既有 win32 環境限制：M26 path coverage、M36 profile chmod；未新增其他失敗。

## 相容性

- 工作狀態庫 schema version 不變；`reconcile_state.failed_scopes_json` 欄位不變，不要求 rebuild、刪除資料庫或刪除 WAL／journal。
- 舊版 JSON 陣列無法回復原始來源類型，採保守方式歸入 `readFailures`，因此仍保持未完成；下一次保存會轉成新物件格式。
- 延後核對仍使 `complete = false`，且阻止該 scope 的 `removeMissing`。

## 不確定處

- 舊資料只有合併後的 scope 陣列，無法判定每筆原本是讀取失敗或延後核對；目前選擇保守歸入讀取失敗。
- 尚未取得公司 Windows 人工驗收回報；本次僅執行工作樹所在環境的本機 win32 自動測試。
