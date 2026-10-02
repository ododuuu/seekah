import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  codexReferencePathForTest,
  parseCodexRolloutFile,
  parseCodexSessions,
  resolveCodexHome,
  type CodexSession,
} from "../src/codex-session.js";

async function fixture(): Promise<{ temp: string; codexHome: string; rollout: string; privateText: string }> {
  const temp = await mkdtemp(path.join(os.tmpdir(), "seekah-m94-"));
  const codexHome = path.join(temp, "synthetic-codex-home");
  const rollout = path.join(codexHome, "sessions", "2026", "10", "02", "rollout-m94.jsonl");
  await mkdir(path.dirname(rollout), { recursive: true });
  const privateText = "m94-private-conversation-content";
  const rows = [
    { type: "session_meta", payload: { type: "session_meta", session_id: "m94-session", cwd: "C:/synthetic/workspace", timestamp: "2026-10-02T09:00:00.000Z", base_instructions: "C:/synthetic/base-instructions.txt" } },
    { type: "turn_context", payload: { cwd: "C:/synthetic/turn-context-cwd", workspace_roots: ["C:/synthetic/workspace-root"], permission_profile: { file_system: { entries: [{ path: { path: "C:/synthetic/permission-profile.txt" } }] } }, sandbox_policy: { writable_roots: ["C:/synthetic/writable-root"] } } },
    { type: "event_msg", payload: { type: "thread_settings_applied", thread_settings: { cwd: "C:/synthetic/thread-settings-cwd", permission_profile: { file_system: { entries: [{ path: { path: "C:/synthetic/thread-permission.txt" } }] } } } } },
    { type: "world_state", payload: { filesystem: { cwd: "C:/synthetic/world-cwd", roots: ["C:/synthetic/world-root"] } } },
    { type: "response_item", payload: { type: "message", role: "developer", content: [{ type: "input_text", text: "<environment_context>\nC:/synthetic/developer-environment.txt" }] } },
    { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "C:/synthetic/assistant-output.txt" }] } },
    { type: "response_item", payload: { type: "message", role: "user", content: [
      { type: "input_text:environment_context", text: "C:/synthetic/auto-environment.txt" },
      { type: "input_text:turn_aborted", text: "C:/synthetic/aborted.txt" },
      { type: "input_text:recommended_plugins", text: "C:/synthetic/plugins.txt" },
      { type: "input_text:# AGENTS.md", text: "C:/synthetic/agents.txt" },
      { type: "input_text:(plain)", text: "Please inspect C:/synthetic/user-provided.txt " + privateText + " https://example.test/C:/synthetic/url.txt HTTP://example.test/C:/synthetic/url-uppercase.txt" },
      { type: "input_image", image_url: { url: "file:///C:/synthetic/user-image.png" } },
    ] } },
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "# Seekah 上下文\n\n## 1. C:/synthetic/prompt-a.txt\n- 文件代碼：`1-a`\n\nC:/synthetic/snippet-path.txt\n\n## 2. C:/synthetic/prompt-b.txt" }] } },
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "C:/synthetic/sidebar-a.txt\nC:/synthetic/sidebar-b.txt" }] } },
    { type: "response_item", payload: { type: "function_call", name: "shell_command", arguments: { command: "type C:/synthetic/shell-read.txt" } } },
    { type: "response_item", payload: { type: "function_call", namespace: "mcp__beeper", name: "search_messages", arguments: { path: "C:/synthetic/not-seekah-mcp.txt" } } },
    { type: "response_item", payload: { type: "function_call", namespace: "mcp__localdocsearch__search_documents", name: "search_documents", arguments: { path: "C:/synthetic/mcp-reference.md", query: privateText } } },
    { type: "response_item", payload: { type: "function_call", server: "seekah", name: "read_document", arguments: { path: "C:/synthetic/unregistered-server.txt" } } },
    { type: "response_item", payload: { type: "custom_tool_call", name: "apply_patch", input: "*** Update File: C:/synthetic/patched.ts\n+const path = 'C:/synthetic/patch-body.txt';" } },
    { type: "response_item", payload: { type: "custom_tool_call", name: "exec", input: { command: "cat C:/synthetic/exec-read.txt" } } },
    { type: "event_msg", payload: { type: "item_completed", item: { type: "FileChange", path: "C:/synthetic/file-change.ts", savedPath: "C:/synthetic/file-change-saved.ts", content: [{ path: "C:/synthetic/file-change-content.ts", text: "C:/synthetic/file-change-output.txt" }], changes: { "C:/synthetic/file-change-map.ts": { content: "C:/synthetic/file-change-map-output.txt" } } } } },
    { type: "event_msg", payload: { type: "item_completed", item: { type: "CommandExecution", cwd: "C:/synthetic/command-cwd", command: ["type C:/synthetic/command-read.txt"], parsed_cmd: [{ cmd: "cat C:/synthetic/parsed-command.txt", path: "C:/synthetic/parsed-path.txt" }] } } },
    { type: "event_msg", payload: { type: "item_completed", item: { type: "McpToolCall", server: "localdocsearch", name: "search_documents", arguments: { path: "C:/synthetic/mcp-reference.md" } } } },
    { type: "event_msg", payload: { type: "item_completed", item: { type: "McpToolCall", server: "codex_apps", arguments: { path: "C:/synthetic/not-localdocsearch.txt" } } } },
    { type: "event_msg", payload: { type: "item_completed", item: { type: "WebSearchAction", results: [{ url: "https://example.test/C:/synthetic/result.txt" }], stdout: "C:/synthetic/stdout.txt", aggregated_output: "C:/synthetic/aggregated.txt", formatted_output: "C:/synthetic/formatted.txt", content: [{ text: "C:/synthetic/tool-content.txt" }] } } },
    { type: "response_item", payload: { type: "custom_tool_call_output", output: [{ type: "text", text: "C:/synthetic/custom-output.txt" }] } },
    { type: "response_item", payload: { type: "function_call_output", output: "C:/synthetic/function-output.txt" } },
    { type: "mystery_event", message: "C:/synthetic/fallback.txt " + privateText },
    "not-json",
  ];
  await writeFile(rollout, rows.map(row => typeof row === "string" ? row : JSON.stringify(row)).join("\n") + "\n", "utf8");
  await writeFile(path.join(codexHome, "history.jsonl"), JSON.stringify({ path: "C:/synthetic/should-not-read.txt" }), "utf8");
  await writeFile(path.join(codexHome, "session_index.jsonl"), JSON.stringify({ path: "C:/synthetic/should-not-read-index.txt" }), "utf8");
  await writeFile(path.join(codexHome, "sessions", "2026", "10", "02", "not-a-rollout.jsonl"), JSON.stringify({ path: "C:/synthetic/should-not-read-name.txt" }), "utf8");
  return { temp, codexHome, rollout, privateText };
}

function reference(session: CodexSession, value: string) {
  const item = session.references.find(candidate => candidate.path.endsWith(value));
  assert.ok(item, `缺少 reference ${value}`);
  return item;
}

test("M94 依真實 schema allowlist 解析 metadata、四種來源並排除環境與輸出", async t => {
  const fixtureData = await fixture();
  t.after(() => rm(fixtureData.temp, { recursive: true, force: true }));
  const [session] = await parseCodexSessions({ codexHome: fixtureData.codexHome });
  assert.ok(session);
  assert.equal(session.id, "m94-session");
  assert.equal(session.cwd, "C:\\synthetic\\workspace");
  assert.equal(session.invalidLineCount, 1);
  assert.equal(session.eventTypes["session_meta"], 1);
  assert.equal(session.eventTypes["response_item/message"], 5);
  assert.equal(session.eventTypes["response_item/function_call"], 4);
  assert.equal(session.eventTypes["event_msg/item_completed"], 5);
  assert.equal(session.parseMode, "message-path-fallback");

  assert.equal(reference(session, "user-provided.txt").source, "user-provided");
  assert.equal(reference(session, "user-image.png").source, "user-provided");
  assert.equal(reference(session, "prompt-a.txt").source, "seekah-prompt");
  assert.equal(reference(session, "prompt-b.txt").source, "seekah-prompt");
  assert.equal(reference(session, "sidebar-a.txt").source, "seekah-prompt");
  assert.equal(reference(session, "mcp-reference.md").source, "seekah-mcp");
  assert.equal(reference(session, "shell-read.txt").source, "codex-tool");
  assert.equal(reference(session, "patched.ts").source, "codex-tool");
  assert.equal(reference(session, "file-change-map.ts").source, "codex-tool");
  assert.equal(reference(session, "parsed-path.txt").source, "codex-tool");
  assert.equal(reference(session, "fallback.txt").source, "user-provided");
  assert.equal(reference(session, "fallback.txt").confidence, "low");

  const serialized = JSON.stringify(session);
  for (const excluded of [
    "auto-environment.txt", "turn-context-cwd", "thread-permission.txt", "world-root", "base-instructions.txt", "writable-root",
    "permission-profile.txt", "file-change-output.txt", "file-change-map-output.txt", "command-cwd",
    "developer-environment.txt", "assistant-output.txt", "not-seekah-mcp.txt", "unregistered-server.txt",
    "not-localdocsearch.txt", "stdout.txt", "aggregated.txt", "formatted.txt", "tool-content.txt", "url.txt", "url-uppercase.txt", "patch-body.txt", "snippet-path.txt",
  ]) assert.doesNotMatch(serialized, new RegExp(excluded.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")));
  assert.ok(!session.references.some(item => item.path.includes("should-not-read")));
  assert.doesNotMatch(serialized, new RegExp(fixtureData.privateText, "u"));
});

test("M94 真實摘要無 localdocsearch MCP 時不得猜成 seekah-mcp", async t => {
  const fixtureData = await fixture();
  t.after(() => rm(fixtureData.temp, { recursive: true, force: true }));
  const filePath = path.join(fixtureData.codexHome, "sessions", "2026", "10", "02", "rollout-no-seekah-mcp.jsonl");
  const rows = [
    { type: "session_meta", payload: { type: "session_meta", session_id: "m94-no-mcp", cwd: "C:/synthetic/workspace" } },
    { type: "response_item", payload: { type: "message", role: "developer", content: [{ type: "input_text", text: "C:/synthetic/developer-only.txt" }] } },
    { type: "response_item", payload: { type: "function_call", namespace: "mcp__beeper", name: "search_messages", arguments: { path: "C:/synthetic/beeper-only.txt" } } },
    { type: "response_item", payload: { type: "function_call", server: "seekah", name: "read_document", arguments: { path: "C:/synthetic/unregistered-only.txt" } } },
    { type: "event_msg", payload: { type: "item_completed", item: { type: "McpToolCall", server: "codex_apps", arguments: { path: "C:/synthetic/codex-app-only.txt" } } } },
    { type: "event_msg", payload: { type: "item_completed", item: { type: "WebSearchAction", results: [{ url: "https://example.test/C:/synthetic/url-only.txt" }] } } },
  ];
  await writeFile(filePath, rows.map(row => JSON.stringify(row)).join("\n") + "\n", "utf8");
  const session = await parseCodexRolloutFile(filePath);
  assert.equal(session.parseMode, "structured");
  assert.equal(session.references.length, 0);
});

test("M94 Codex home 可由環境變數設定且絕對路徑正規化", () => {
  const home = "C:\\synthetic\\codex-home";
  assert.equal(resolveCodexHome(undefined, { SEEKAH_CODEX_HOME: home }), path.resolve(home));
  assert.equal(codexReferencePathForTest("file:///C:/synthetic/file.md"), "C:\\synthetic\\file.md");
  assert.equal(codexReferencePathForTest("/tmp/synthetic/file.md"), "/tmp/synthetic/file.md");
  assert.equal(codexReferencePathForTest("https://example.test/file.md"), null);
});

test("M94 缺少 session_meta 時使用 opaque session id", async t => {
  const fixtureData = await fixture();
  t.after(() => rm(fixtureData.temp, { recursive: true, force: true }));
  const filePath = path.join(fixtureData.codexHome, "sessions", "2026", "10", "02", "rollout-without-meta.jsonl");
  await writeFile(filePath, JSON.stringify({ type: "unknown_event", message: "C:/synthetic/opaque.txt" }), "utf8");
  const session = await parseCodexRolloutFile(filePath);
  assert.match(session.id, /^rollout-[0-9a-f]{16}$/u);
  assert.doesNotMatch(session.id, /without-meta/u);
  assert.equal(session.parseMode, "message-path-fallback");
});

test("M94 reverse 移除 structured path collection 時契約必須失敗", async () => {
  const source = await readFile(path.resolve("src/codex-session.ts"), "utf8");
  const required = ["rollout-", "message-path-fallback", "markIndexedCodexReferences", "seekah-mcp", "codex-tool", "structuredEvidence", "collectAbsolutePaths"];
  for (const marker of required) assert.match(source, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")));
  const withoutCollection = source.replace("const evidence = structuredEvidence(type, lineRecord, payload);", "const evidence: PathEvidence[] = [];");
  assert.doesNotMatch(withoutCollection, /const evidence = structuredEvidence\(type, lineRecord, payload\)/u);
  assert.throws(() => {
    if (!withoutCollection.includes("const evidence = structuredEvidence(type, lineRecord, payload);")) throw new Error("parser structured path collection contract removed");
  }, /path collection/u);
});
