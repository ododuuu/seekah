# Codex 工作階段格式研究（2026-10-02）

## 範圍與資料邊界

本文件只記錄使用者提供的欄位統計摘要與合成 fixture 設計，不是任何使用者工作階段的 dump。研究沒有讀取真實 `~/.codex`、`%LOCALAPPDATA%\LocalDocSearch*`、認證資料、history、attachment 或 SQLite；產品 parser 也不會以這些位置補資料。

產品解析器採唯讀邊界：只列舉可設定 Codex home 下 `sessions/` 遞迴的 `rollout-*.jsonl`。`history.jsonl`、`session_index.jsonl`、`archived_sessions/`、`attachments/`、認證檔與 SQLite 狀態檔不是輸入來源。

## 使用者提供的 schema 摘要

外部摘要列出 57 個 rollout、57 個 `session_meta` cwd、57 個 `event_msg/item_completed` cwd 與 57 個 `turn_context` cwd；這些 cwd、workspace root、sandbox root、permission profile path 與 world-state filesystem path 都是執行環境 metadata，不是 Reference Set。

路徑或事件數量最高的欄位如下；數量是欄位出現次數，不是產品 reference 數：

| rollout 結構 | 欄位 | 摘要數量 | parser 契約 |
| --- | --- | ---: | --- |
| `turn_context` | permission profile／sandbox entries 的 `path` | 1210／1210 | 忽略 |
| `response_item/message(user)` | `payload.content[].text` | 1067 | 只處理 `input_text` plain 與 `input_image` |
| `event_msg/thread_settings_applied` | permission profile path | 987 | 忽略 |
| `event_msg/item_completed` | `item.results[].url` | 647 | 工具結果，忽略；HTTP／HTTPS 一律不產生 reference |
| `turn_context` | `workspace_roots[]` | 611 | 忽略 |
| `response_item/function_call{shell_command}` | `payload.arguments` | 350 | 只作 `codex-tool` |
| `response_item/custom_tool_call{exec}` | `payload.input` | 349 | 只作 `codex-tool` |
| `event_msg/item_completed` | `item.command[]` | 325 | `CommandExecution` 才作 `codex-tool` |
| `turn_context` | `cwd` | 296 | 忽略 |
| `event_msg/item_completed` | `item.cwd` | 274 | 忽略；不是 command |
| `event_msg/item_completed` | `item.content[].text` | 230 | 工具輸出，忽略 |
| `response_item/message(developer)` | `payload.content[].text` | 184 | 環境注入，忽略 |
| `response_item/function_call_output` | `payload.output` | 156 | 工具輸出，忽略 |
| `event_msg/item_completed` | `item.stdout` | 155 | 工具輸出，忽略 |
| `event_msg/item_completed` | `item.aggregated_output`／`formatted_output` | 111／109 | 工具輸出，忽略 |
| `event_msg/item_completed` | `item.parsed_cmd[].cmd`／`path` | 51／9 | `CommandExecution` 作 `codex-tool` |

實際事件類型包括 `UserMessage`、`AgentMessage`、`Reasoning`、`Plan`、`WebSearch`、`FileChange`、`CommandExecution`、`McpToolCall@...` 等；不能以「任何欄位含 path」取代事件型別判斷。

`response_item/message(user)` 的 content prefix 統計包括：`input_text:environment_context` 122、`input_text:(plain)` 3593、`input_image` 14、`input_text:turn_aborted` 4、`input_text:recommended_plugins` 18、`input_text:# AGENTS.md` 19。前者的四種標記是 Codex 自動注入；只有 plain `input_text` 與 `input_image` 可作使用者來源。

## 事件來源與允許欄位

| 來源 | 僅允許的實際形狀 | 禁止誤判的欄位 |
| --- | --- | --- |
| `user-provided` | `response_item/message`、`role=user`、`content[].type=input_text` 的 plain text；`content[].type=input_image` 的明確檔案 URI/path | `environment_context`、`turn_aborted`、`recommended_plugins`、`# AGENTS.md`、developer／assistant message、environment settings |
| `seekah-prompt` | `# Seekah 上下文` Markdown 的 `## N. <absolute path>` 行；或 pi context sidebar 的「每行一個 absolute path」清單 | Markdown snippet、文件代碼、查詢、說明文字中的 path |
| `seekah-mcp` | `McpToolCall` 且 server identity 是 `localdocsearch`（相容別名 `seekah`）；或 function-call namespace `mcp__localdocsearch__...` | `mcp__beeper__...`、任意 `server`／`source`／path 字串含 seekah 的非 MCP 事件 |
| `codex-tool` | `custom_tool_call{apply_patch}` 的 `payload.input`；`FileChange` 的 path／savedPath／changes key；`CommandExecution` 的 command／parsed_cmd；`function_call{shell_command}` 的 arguments；`custom_tool_call{exec}` 的 input | `stdout`、`aggregated_output`、`formatted_output`、`results[].url`、`custom_tool_call_output`、`function_call_output`、cwd、query、web-search action |

產品 MCP server 的實際註冊名稱是 `localdocsearch`：`src/host-setup.ts` 的 Codex registration 與 `src/mcp.ts` 的 `McpServer` 皆使用此名稱。真實摘要沒有 Seekah／LocalDocSearch MCP call，因此 real-format fixture 的 `seekah-mcp` 預期為 0。

## Seekah prompt 與低信心路徑

目前本機 context Markdown 的既有辨識標記是 `# Seekah 上下文`；parser 只從後續 `## N. <absolute path>` 標題取 path，不掃描片段正文。pi context sidebar 的純清單契約是每行一個 absolute path，不另加 marker，因為整段內容已可由「所有非空行都是 absolute path」辨識。這兩種輸入都分類為 `seekah-prompt`；普通使用者文字仍分類為 `user-provided`。

HTTP／HTTPS URL 永遠不是 absolute file path，parser 不輸出 URL reference。未知事件才允許 `message`／`text` 欄位做 `user-provided`／`low` 的 `message-path-fallback`；這類低信心、未在磁碟且未命中 Seekah 索引的 path 只能作低信心 metadata，不得提升成工具或 Seekah 來源。頁面仍以 confidence／indexed 狀態降級呈現，不開啟來源檔案。

## 後續 parser 邊界與效能決定

- 合成負例另外涵蓋 `data:` image URI、含 base64 signature 的片段、URL、跨行 token、句末標點、`:line` suffix 及超過 400 字元的單一路徑 token；這些內容不得變成 Reference Set。長說明文字即使超過 400 字元，仍須保留其中獨立的合法 path。事件 type 不接受 rollout 任意字串，超長或不在 allowlist 的值統一為 `unknown`。

產品 parser 對單一 rollout 設 64 MiB 檔案上限；超限只回傳 `skipped` metadata，不讀取檔案。正常檔案使用 64 KiB stream chunk 組行，2,000,000 字元以上的單行只計為 invalid，不先由 `readline` 配置無界字串。

session cache 以 canonical rollout path、`mtimeMs` 與檔案 size 驗證；session 清單建立後 detail 只解析目標檔案並重用相同 cache。API 將磁碟 `exists`、Seekah `indexed` 與主要／低信心 buckets 分開，避免不存在的未知 path 和已確認文件混在同一主要列表。

main 已有文件庫 stable reference API，因此已索引 Codex reference 的 UI 只接 Pin 與分類；工作台右側 context drawer 沒有跨頁共享狀態契約，Codex 頁面不自行宣稱加入 context。上述結論仍只用 synthetic fixture 驗證。

## 合成 fixture 必須覆蓋的負例

fixture 必須同時包含：`turn_context` permission／workspace／cwd、`thread_settings_applied` permission／cwd、`world_state`、session base instructions、developer／assistant message、tool output／result URL、`mcp__beeper`、非 localdocsearch 的 `McpToolCall`、HTTP／HTTPS URL；這些值不得進入 Reference Set。正例必須包含 plain user path、Seekah Markdown／pi path list、localdocsearch MCP、FileChange、CommandExecution、shell command、apply_patch 與 exec。

所有 fixture 均使用暫存目錄與 synthetic path；測試不得啟動真實 Codex、讀取使用者 home 或執行 rollout 內的 command。
