# Seekah AI 協作指示

修改程式碼前，依序閱讀下列文件：

1. `docs/SPEC.md`
2. `docs/STATUS.md`
3. `docs/DECISIONS.md`
4. `docs/handoff/README.md` 與 `docs/handoff/CURRENT.md`，再讀入口指定的版本交接文件。

## 工作規則

- 本儲存庫是正式的 Seekah（原 LocalDocSearch）產品，不得與上層工作區的教材網站混用。
- 除非使用者明確變更，否則維持已決定的 Node.js 與 TypeScript 技術方向。
- 所有文件處理都必須留在本機，不得將文件內容上傳至外部服務。
- 不得自行加入 OCR、embedding、LAN 暴露或未規格化的新格式。MCP、TUI、本機 GUI 與可選 AI API 已依後續 SPEC 交付；新增行為必須先寫入 SPEC／DECISIONS。
- 不得自行改變產品行為；預定行為寫入 `docs/SPEC.md`，設計決策寫入 `docs/DECISIONS.md`。
- 每次只實作 `docs/STATUS.md` 指定的進行中里程碑；使用者核准平行開發時，依 D093：每項工作一條分支與一個 git worktree，事先分配 SPEC 章節與決策編號，只改自己的範圍並在分支提交；`package.json` 版本、`docs/STATUS.md`、`docs/handoff/`、`docs/NEXT-TODO.md` 由審查合併者統一更新。
- 每項行為變更都必須新增或更新自動測試。
- 所有專案說明文件、規格、狀態與決策紀錄都使用繁體中文；程式識別字、命令與通用技術名稱可保留英文。
- 每次工作結束時更新 `docs/STATUS.md`，並將重要決策加入 `docs/DECISIONS.md`。
- 除非使用者確實在公司 Windows 電腦完成驗收並回報，否則不得宣稱已通過 Windows 驗證。

- 交接文件固定放在 `docs/handoff/`；同步維護 `CURRENT.md` 與版本文件。`docs/HANDOFF.md` 僅保留舊連結與歷史。
- 更名不代表資料遷移：保留 LocalDocSearch 資料目錄、LOCALDOCSEARCH_DATA_DIR、.localdocsearchignore、既有 IPC／MCP 識別與 docsearch 相容入口。
