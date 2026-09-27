# seekah desktop UI concepts

目前主提案參考 Paperless-ngx 成熟文件管理流程的桌面版資訊架構；2026-09-26 已完成正式 `src/workbench-app.ts` clean cutover。此資料夾的 HTML 仍是視覺參考，不是 runtime 或驗收資料來源。

## 開啟主提案

```powershell
Start-Process .\design\ui-directions\paperless-inspired.html
```

或：

```powershell
Start-Process .\design\ui-directions\index.html
```

先前五種桌面操作模型仍保留在 `desktop.html`，但不再是主提案。

## 從 Paperless-ngx 借用的設計決策

依據 Paperless-ngx 官方截圖、`document-list.component.html` 與 `document-detail.component.html`：

- 固定頂部全域搜尋，任何頁面都可立即回到文件查找。
- 左側導覽按真實工作物件分組，而不是放抽象 dashboard 卡片。
- 文件頁把選取、顯示模式、排序、篩選和結果數放在同一工作區。
- 文件清單可切換資訊較豐富的 preview list 與高密度 table。
- 勾選後才顯示批次操作，未選取時不佔主要視覺位置。
- 文件詳細頁採左側資料／內容、右側來源預覽的並排結構。
- 根目錄與垃圾桶是同一導覽架構中的一級管理頁，不藏在設定裡。
- 危險操作保持次要，永久刪除明確標示不可還原。

## 沒有照搬的部分

Paperless-ngx 是完整 DMS，seekah 目前不是。因此 demo 沒有偽造以下能力：

- tags、correspondents、document types、custom fields
- OCR 管線、郵件匯入、workflow
- 使用者權限、分享、版本管理
- dashboard 統計卡與 saved views

seekah 的篩選只保留目前產品真實能對應的概念：根目錄、格式、解析狀態與搜尋模式。側欄只放文件、臨時文件、根目錄、垃圾桶、上下文與設定。

## 正式工作台對應的互動

- 頂部全域搜尋。
- 文件 preview list／table 切換。
- 根目錄、格式、解析狀態與搜尋模式 filter 狀態。
- 單項、本頁與全部選取。
- 選取後出現的上下文批次工具列。
- 文件詳細頁、前後文件切換、詳細資料／索引內容 tab。
- 來源預覽、加入上下文、開啟來源。
- 根目錄管理、加入與更新入口。
- 垃圾桶還原、永久刪除警告。
- 刪除確認與提醒設定。

Paperless-inspired HTML 所有操作仍是 demo，不讀寫實際索引；正式工作台使用既有 loopback API，並移除 Provider／model／API Key／AI question／送出／answer 控制。

2026-09-26 的正式工作台已將 runtime 的 shell、Georgia brand／圓形 S、無框 sidebar 導覽列、active state／count pills、單一中文搜尋模式 chip、sticky 搜尋篩選列、文件 preview cards／Table、目前結果排序、結果分頁、bulk bar、detail paper preview、索引根目錄表格與垃圾桶卡片列逐項對齊此主提案。sidebar 導覽不套用共用 `.btn`；只有整個 sidebar 與 main 之間保留 demo 的分隔線。正式頁只保留真實資料與 runtime 必要控制，不複製 demo 假數字或不存在的 DMS 能力；根目錄及垃圾桶操作仍使用正式 loopback API。

## 桌面驗證

正式工作台已用 Chromium 驗證：

- `1440 × 900`、`1920 × 1080` 與最小 `1180 × 800`；
- 三個尺寸沒有水平溢位，topbar 58 px，1440／1920 sidebar 246 px；
- preview list／table、搜尋、選取、server preview／複製、detail、臨時上傳、根目錄兩步流程與垃圾桶還原；
- context drawer／dialog 的 inert、Esc／焦點回復；axe 初始頁、drawer 與 preview dialog 均 0 violation；
- CSP 無外部資源，console 與 page errors 為空。

## 參考來源

- [Paperless-ngx 官方文件](https://docs.paperless-ngx.com/)
- [Paperless-ngx 官方截圖與功能說明](https://github.com/paperless-ngx/paperless-ngx/blob/dev/docs/index.md)
- [Document list template](https://github.com/paperless-ngx/paperless-ngx/blob/dev/src-ui/src/app/components/document-list/document-list.component.html)
- [Document detail template](https://github.com/paperless-ngx/paperless-ngx/blob/dev/src-ui/src/app/components/document-detail/document-detail.component.html)
