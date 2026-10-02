import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { codexSessionHtml } from "../src/codex-session-app.js";
import { sync } from "../src/sync.js";
import { IndexStore } from "../src/store.js";
import { workbenchHtml } from "../src/workbench-app.js";
import { createWorkbench } from "../src/workbench.js";

interface Fixture {
  temp: string;
  codexHome: string;
  databasePath: string;
  indexedPath: string;
  unindexedPath: string;
  mcpPath: string;
  privateText: string;
}

async function createFixture(): Promise<Fixture> {
  const temp = await mkdtemp(path.join(os.tmpdir(), "seekah-m95-"));
  const root = path.join(temp, "indexed-root");
  const codexHome = path.join(temp, "synthetic-codex-home");
  const databasePath = path.join(temp, "data", "index.db");
  const indexedPath = path.join(root, "indexed.md");
  const unindexedPath = path.join(root, "not-indexed.md");
  const mcpPath = path.join(root, "mcp.md");
  const rollout = path.join(codexHome, "sessions", "2026", "10", "02", "rollout-m95.jsonl");
  const privateText = "m95-private-conversation-content";
  await mkdir(path.dirname(indexedPath), { recursive: true });
  await mkdir(path.dirname(rollout), { recursive: true });
  await writeFile(indexedPath, "m95 indexed document\n", "utf8");
  const store = new IndexStore(databasePath);
  try { await sync(root, store); }
  finally { store.close(); }
  const rows = [
    { type: "session_meta", payload: { type: "session_meta", session_id: "m95-session", cwd: root, timestamp: "2026-10-02T10:00:00.000Z" } },
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Please inspect " + indexedPath + " " + privateText }] } },
    { type: "response_item", payload: { type: "function_call", server: "seekah", name: "read_document", arguments: { path: mcpPath, query: privateText } } },
    { type: "response_item", payload: { type: "function_call", name: "shell_command", command: "type " + unindexedPath } },
  ];
  await writeFile(rollout, rows.map(row => JSON.stringify(row)).join("\n") + "\n", "utf8");
  return { temp, codexHome, databasePath, indexedPath, unindexedPath, mcpPath, privateText };
}

function requestHeaders(token: string): Record<string, string> {
  return { "X-LocalDocSearch-Token": token };
}

test("M95 Codex sessions API 只回傳 metadata、reference 與 Seekah 索引狀態", async t => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.temp, { recursive: true, force: true }));
  const handle = await createWorkbench({
    databasePath: fixture.databasePath,
    codexHome: fixture.codexHome,
    token: "m95-token",
    secret: Buffer.alloc(32, 95),
    environment: {},
    tempParent: fixture.temp,
    startupOptions: { platform: "linux" },
  });
  t.after(() => handle.close());
  const origin = handle.url.split("/#")[0]!;

  const unauthorized = await fetch(origin + "/api/codex/sessions");
  assert.equal(unauthorized.status, 403);
  const listResponse = await fetch(origin + "/api/codex/sessions", { headers: requestHeaders(handle.token) });
  assert.equal(listResponse.status, 200);
  const list = await listResponse.json() as { readOnly: boolean; sessions: Array<Record<string, unknown>> };
  assert.equal(list.readOnly, true);
  assert.equal(list.sessions.length, 1);
  assert.equal(list.sessions[0]?.id, "m95-session");
  assert.equal(list.sessions[0]?.referenceCount, 3);
  assert.equal("references" in (list.sessions[0] ?? {}), false);
  assert.doesNotMatch(JSON.stringify(list), new RegExp(fixture.privateText, "u"));

  const detailsResponse = await fetch(origin + "/api/codex/sessions/m95-session/references", { headers: requestHeaders(handle.token) });
  assert.equal(detailsResponse.status, 200);
  const details = await detailsResponse.json() as {
    readOnly: boolean;
    sessionId: string;
    references: Array<{ path: string; source: string; indexed: boolean; seekahReference?: string }>;
  };
  assert.equal(details.readOnly, true);
  assert.equal(details.sessionId, "m95-session");
  assert.equal(details.references.length, 3);
  const indexed = details.references.find(item => item.path === fixture.indexedPath);
  assert.ok(indexed);
  assert.equal(indexed.indexed, true);
  assert.match(indexed.seekahReference ?? "", /^[1-9]\d*-[0-9a-f]{16}$/u);
  assert.equal(details.references.find(item => item.path === fixture.mcpPath)?.source, "seekah-mcp");
  assert.equal(details.references.find(item => item.path === fixture.unindexedPath)?.indexed, false);
  assert.doesNotMatch(JSON.stringify(details), new RegExp(fixture.privateText, "u"));

  const missing = await fetch(origin + "/api/codex/sessions/m95-missing/references", { headers: requestHeaders(handle.token) });
  assert.equal(missing.status, 404);
});

test("M95 Codex 工作階段頁面可由 loopback route 開啟且不含對話內容", async t => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.temp, { recursive: true, force: true }));
  const handle = await createWorkbench({ databasePath: fixture.databasePath, codexHome: fixture.codexHome, token: "m95-page-token", environment: {}, tempParent: fixture.temp,
    startupOptions: { platform: "linux" } });
  t.after(() => handle.close());
  const origin = handle.url.split("/#")[0]!;
  const pageResponse = await fetch(origin + "/codex-sessions");
  assert.equal(pageResponse.status, 200);
  const page = await pageResponse.text();
  assert.match(page, /Codex 工作階段/u);
  assert.match(page, /X-LocalDocSearch-Token/u);
  assert.match(page, /textContent/u);
  assert.doesNotMatch(page, /innerHTML/u);
  assert.doesNotMatch(page, new RegExp(fixture.privateText, "u"));
  assert.match(workbenchHtml("m95-workbench-nonce"), /codex-session-toggle/u);
  assert.match(codexSessionHtml("m95-codex-nonce"), /reference\.sources/u);
});

test("M95 reverse 移除 API 索引比對或入口時契約必須失敗", async () => {
  const workbenchSource = await readFile(path.resolve("src/workbench.ts"), "utf8");
  const pageSource = await readFile(path.resolve("src/codex-session-app.ts"), "utf8");
  const required = ["/api/codex/sessions", "markIndexedCodexReferences", "codexSessionHtml", "Codex 工作階段"];
  for (const marker of required) assert.match(workbenchSource + pageSource, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")));
  const withoutIndexMatch = workbenchSource.replace("markIndexedCodexReferences(sessions, store)", "sessions");
  assert.throws(() => {
    if (!withoutIndexMatch.includes("markIndexedCodexReferences(sessions, store)")) throw new Error("API 索引比對契約移除");
  }, /索引比對/u);
  const withoutPageRoute = workbenchSource.replace("url.pathname === \"/codex-sessions\"", "url.pathname === \"/removed-codex-sessions\"");
  assert.throws(() => {
    if (!withoutPageRoute.includes("url.pathname === \"/codex-sessions\"")) throw new Error("Codex 頁面入口契約移除");
  }, /入口/u);
});
