# Codex 工作階段格式研究（2026-10-02）

## 範圍與資料邊界

本文件只記錄已知的 Codex rollout JSONL 結構與合成 fixture 的解析結果，不是任何使用者工作階段的 dump。研究腳本只在暫存目錄建立合成 `sessions/YYYY/MM/DD/rollout-*.jsonl`，沒有讀取真實 `~/.codex`、認證資料、歷史索引、附件或 SQLite 狀態。

產品解析器採唯讀邊界：只列舉可設定 Codex home 下的 `sessions/`，遞迴讀取檔名符合 `rollout-*.jsonl` 的檔案。`history.jsonl`、`session_index.jsonl`、`archived_sessions/`、`attachments/`、認證檔與 SQLite 檔案不是輸入來源；解析器不會為了補資料而開啟這些項目。

## 已知 JSONL 形狀

每一行是獨立 JSON object。解析器保留欄位名稱、事件類型計數與必要的工作階段 metadata，不輸出 message、reasoning、command、query、tool result 或其他對話內容。

| 結構 | 已知欄位／用途 |
| --- | --- |
| 頂層事件 | `type`、`timestamp`、`payload`、`data`、`event`。`payload`／`data`／`event` 可包含事件子類型。 |
| `session_meta` | `session_id`／`sessionId`、`cwd`、`working_directory`、`timestamp`／`created_at`。`cwd` 只作工作階段 metadata 與絕對路徑比對。 |
| `response_item` | 子類型常見為 `message`、`reasoning`、`function_call`、`tool_call`、`tool_result`；子類型來自 payload 的 `type`、`event_type` 或 `kind`。 |
| `message` | `role`、`content`、`input`、`text`、`source`／`origin`。路徑只從文字值抽取，不回傳文字本身。 |
| 工具事件 | `name`／`tool_name`、`arguments`、`command`、`path`、`file`、`file_path`、`uri`、`result` 等。讀檔、shell／command execution 與工具呼叫只產生事件類型與路徑 metadata。 |
| `event_msg` | 以 `type` 加 payload 子類型計數；若含 `user_message`／`input_message`，可用於訊息路徑 fallback。 |
| `turn_context`、`world_state` | 只視為未知或附加事件形狀遞迴檢查；不假設其內部內容，也不把整個 object 回傳。 |

## 路徑與來源分類

合成事件確認可由下列位置發現絕對路徑：

- `session_meta` 的 `cwd`：記錄工作階段工作目錄。
- `message.content`、`message.text`、`input`：使用者直接提供的路徑；明確的 Seekah prompt／context 標記可分類為 `seekah-prompt`。
- 工具事件的 `path`、`file`、`file_path`、`filename`、`uri`、`attachment`／`attachments`：記錄工具或附件引用的絕對路徑；不開啟附件本體。
- `function_call`／shell／read 相關事件的命令或 arguments：記錄抽取出的絕對路徑，來源分類為 `codex-tool`。
- MCP 工具名稱或 server/source 欄位含 Seekah／LocalDocSearch 標記時，分類為 `seekah-mcp`；不執行 MCP，也不讀取工具結果。

公開 reference 的來源欄位限定為 `seekah-prompt`、`user-provided`、`seekah-mcp`、`codex-tool`。每一筆 reference 另有 `sources`、`confidence`、`occurrences` 與事件類型清單；與 Seekah 索引比對成功時只加上索引文件 reference、狀態與 canonical path。

## 未知格式與安全限制

無法辨識事件來源時，解析器仍只抽取絕對路徑，來源標為 `user-provided`、信心為 `low`，並將工作階段標為 `message-path-fallback`。這是保守的 metadata fallback，不代表已理解該事件的語意。

- 不輸出原始 JSONL、message、reasoning、prompt、query、shell command、工具 arguments 或 result。
- 不輸出 rollout 檔案的本機檔案位置；工作階段 id 只來自 `session_meta.session_id`，缺少時使用 rollout 檔案路徑的 opaque hash，不公開檔名。
- 路徑解析支援 Windows drive、UNC、POSIX 與 `file://`；只接受絕對路徑，並以受控上限避免單行或 reference 無界成長。
- API 與工作台頁面只讀取 parser 的 metadata 結果；不提供送回 Codex、修改 rollout、開啟附件或執行 command 的操作。
