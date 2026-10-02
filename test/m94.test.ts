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
    { type: "session_meta", payload: { type: "session_meta", session_id: "m94-session", cwd: "C:/synthetic/workspace", timestamp: "2026-10-02T09:00:00.000Z" } },
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "C:/synthetic/user-provided.txt " + privateText }] } },
    { type: "response_item", payload: { type: "message", role: "user", source: "seekah-prompt", content: [{ type: "input_text", text: "C:/synthetic/prompt-a.txt\nC:/synthetic/prompt-b.txt" }] } },
    { type: "response_item", payload: { type: "function_call", name: "mcp__seekah__search_documents", arguments: { path: "C:/synthetic/mcp-reference.md", query: privateText } } },
    { type: "response_item", payload: { type: "function_call", name: "shell_command", command: "type C:/synthetic/tool-read.txt" } },
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

test("M94 只讀解析 rollout metadata、來源分類與未知格式 fallback", async t => {
  const fixtureData = await fixture();
  t.after(() => rm(fixtureData.temp, { recursive: true, force: true }));
  const [session] = await parseCodexSessions({ codexHome: fixtureData.codexHome });
  assert.ok(session);
  assert.equal(session.id, "m94-session");
  assert.equal(session.cwd, "C:\\synthetic\\workspace");
  assert.equal(session.eventCount, 6);
  assert.equal(session.invalidLineCount, 1);
  assert.equal(session.eventTypes["session_meta"], 1);
  assert.equal(session.eventTypes["response_item/message"], 2);
  assert.equal(session.eventTypes["response_item/function_call"], 2);
  assert.equal(session.eventTypes["mystery_event"], 1);
  assert.equal(session.parseMode, "message-path-fallback");

  assert.equal(reference(session, "user-provided.txt").source, "user-provided");
  assert.equal(reference(session, "user-provided.txt").confidence, "medium");
  assert.equal(reference(session, "prompt-a.txt").source, "seekah-prompt");
  assert.equal(reference(session, "prompt-a.txt").confidence, "high");
  assert.equal(reference(session, "mcp-reference.md").source, "seekah-mcp");
  assert.equal(reference(session, "mcp-reference.md").confidence, "high");
  assert.equal(reference(session, "tool-read.txt").source, "codex-tool");
  assert.equal(reference(session, "tool-read.txt").confidence, "high");
  assert.equal(reference(session, "fallback.txt").source, "user-provided");
  assert.equal(reference(session, "fallback.txt").confidence, "low");
  assert.ok(!session.references.some(item => item.path.includes("should-not-read")));
  assert.doesNotMatch(JSON.stringify(session), new RegExp(fixtureData.privateText, "u"));
});

test("M94 Codex home 可由環境變數設定且絕對路徑正規化", () => {
  const home = "C:\\synthetic\\codex-home";
  assert.equal(resolveCodexHome(undefined, { SEEKAH_CODEX_HOME: home }), path.resolve(home));
  assert.equal(codexReferencePathForTest("file:///C:/synthetic/file.md"), "C:\\synthetic\\file.md");
  assert.equal(codexReferencePathForTest("/tmp/synthetic/file.md"), "/tmp/synthetic/file.md");
});

test("M94 缺少 session_meta 時使用 opaque session id", async t => {
  const fixtureData = await fixture();
  t.after(() => rm(fixtureData.temp, { recursive: true, force: true }));
  const filePath = path.join(fixtureData.codexHome, "sessions", "2026", "10", "02", "rollout-without-meta.jsonl");
  await writeFile(filePath, JSON.stringify({ type: "unknown_event", message: "C:/synthetic/opaque.txt" }), "utf8");
  const session = await parseCodexRolloutFile(filePath);
  assert.match(session.id, /^rollout-[0-9a-f]{16}$/u);
  assert.doesNotMatch(session.id, /without-meta/u);
});
test("M94 reverse 移除 rollout path collection 時契約必須失敗", async () => {
  const source = await readFile(path.resolve("src/codex-session.ts"), "utf8");
  const required = ["rollout-", "message-path-fallback", "markIndexedCodexReferences", "seekah-mcp", "codex-tool"];
  for (const marker of required) assert.match(source, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")));
  const withoutCollection = source.replace("collectPaths(lineRecord, pathValues, undefined);", "collectPaths(lineRecord, [], undefined);");
  assert.doesNotMatch(withoutCollection, /collectPaths\(lineRecord, pathValues, undefined\)/u);
  assert.throws(() => {
    if (!withoutCollection.includes("collectPaths(lineRecord, pathValues, undefined);")) throw new Error("parser path collection contract removed");
  }, /path collection/u);
});
