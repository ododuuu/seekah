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
  missingPath: string;
  mcpPath: string;
  privateText: string;
}

async function createFixture(): Promise<Fixture> {
  const temp = await mkdtemp(path.join(os.tmpdir(), "seekah-m95-"));
  const root = path.join(temp, "indexed-root");
  const codexHome = path.join(temp, "synthetic-codex-home");
  const databasePath = path.join(temp, "data", "index.db");
  const indexedPath = path.join(root, "indexed.md");
  const unindexedPath = path.join(temp, "existing-but-unindexed.md");
  const missingPath = path.join(root, "missing-fallback.md");
  const mcpPath = path.join(root, "mcp.md");
  const rollout = path.join(codexHome, "sessions", "2026", "10", "02", "rollout-m95.jsonl");
  const privateText = "m95-private-conversation-content";
  await mkdir(path.dirname(indexedPath), { recursive: true });
  await mkdir(path.dirname(unindexedPath), { recursive: true });
  await mkdir(path.dirname(rollout), { recursive: true });
  await writeFile(indexedPath, "m95 indexed document\n", "utf8");
  await writeFile(unindexedPath, "m95 existing but unindexed document\n", "utf8");
  const store = new IndexStore(databasePath);
  try { await sync(root, store); }
  finally { store.close(); }
  const rows = [
    { type: "session_meta", payload: { type: "session_meta", session_id: "m95-session", cwd: root, timestamp: "2026-10-02T10:00:00.000Z" } },
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Please inspect " + indexedPath + " " + privateText }] } },
    { type: "response_item", payload: { type: "function_call", namespace: "mcp__localdocsearch__search_documents", name: "search_documents", arguments: { path: mcpPath, query: privateText } } },
    { type: "response_item", payload: { type: "function_call", name: "shell_command", arguments: { command: "type " + unindexedPath } } },
    { type: "unknown_event", message: missingPath },
  ];
  await writeFile(rollout, rows.map(row => JSON.stringify(row)).join("\n") + "\n", "utf8");
  return { temp, codexHome, databasePath, indexedPath, unindexedPath, missingPath, mcpPath, privateText };
}

function requestHeaders(token: string, origin?: string): Record<string, string> {
  return { "X-LocalDocSearch-Token": token, ...(origin ? { origin } : {}) };
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
  const crossOrigin = await fetch(origin + "/api/codex/sessions", { headers: requestHeaders(handle.token, "http://evil.test") });
  assert.equal(crossOrigin.status, 403);
  const listResponse = await fetch(origin + "/api/codex/sessions", { headers: requestHeaders(handle.token, origin) });
  assert.equal(listResponse.status, 200);
  const list = await listResponse.json() as { readOnly: boolean; sessions: Array<Record<string, unknown>> };
  assert.equal(list.readOnly, true);
  assert.equal(list.sessions.length, 1);
  assert.equal(list.sessions[0]?.id, "m95-session");
  assert.equal(list.sessions[0]?.referenceCount, 4);
  assert.equal(list.sessions[0]?.visibleReferenceCount, 2);
  assert.equal(list.sessions[0]?.lowReferenceCount, 2);
  assert.equal("references" in (list.sessions[0] ?? {}), false);
  assert.doesNotMatch(JSON.stringify(list), new RegExp(fixture.privateText, "u"));

  const detailsResponse = await fetch(origin + "/api/codex/sessions/m95-session/references", { headers: requestHeaders(handle.token, origin) });
  assert.equal(detailsResponse.status, 200);
  const details = await detailsResponse.json() as {
    readOnly: boolean;
    sessionId: string;
    referenceCount: number;
    visibleReferenceCount: number;
    lowReferenceCount: number;
    references: Array<{ path: string; source: string; indexed: boolean; exists: boolean; display: string; indexedStatus?: string; seekahReference?: string }>;
    lowReferences: Array<{ path: string; source: string; indexed: boolean; exists: boolean; display: string; indexedStatus?: string }>;
  };
  assert.equal(details.readOnly, true);
  assert.equal(details.sessionId, "m95-session");
  assert.equal(details.referenceCount, 4);
  assert.equal(details.visibleReferenceCount, 2);
  assert.equal(details.lowReferenceCount, 2);
  assert.equal(details.references.length, 2);
  const indexed = details.references.find(item => item.path === fixture.indexedPath);
  assert.ok(indexed);
  assert.equal(indexed.indexed, true);
  assert.equal(indexed.exists, true);
  assert.match(indexed.seekahReference ?? "", /^[1-9]\d*-[0-9a-f]{16}$/u);
  const existingUnindexed = details.references.find(item => item.path === fixture.unindexedPath);
  assert.ok(existingUnindexed);
  assert.equal(existingUnindexed.indexed, false);
  assert.equal(existingUnindexed.exists, true);
  assert.equal(details.lowReferences.length, 2);
  const mcp = details.lowReferences.find(item => item.path === fixture.mcpPath);
  assert.ok(mcp);
  assert.equal(mcp.source, "seekah-mcp");
  assert.equal(mcp.exists, false);
  const missingFallback = details.lowReferences.find(item => item.path === fixture.missingPath);
  assert.ok(missingFallback);
  assert.equal(missingFallback.display, "low-confidence-missing");
  assert.equal(missingFallback.indexedStatus, "low-confidence-missing");
  assert.doesNotMatch(JSON.stringify(details), new RegExp(fixture.privateText, "u"));

  const wrongOriginDetail = await fetch(origin + "/api/codex/sessions/m95-session/references", { headers: requestHeaders(handle.token, "http://evil.test") });
  assert.equal(wrongOriginDetail.status, 403);


  const missing = await fetch(origin + "/api/codex/sessions/m95-missing/references", { headers: requestHeaders(handle.token, origin) });
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
  const pageHtml = codexSessionHtml("m95-codex-nonce");
  assert.match(pageHtml, /reference\.sources/u);
  assert.match(pageHtml, /可能已移動或其他電腦的路徑/u);
  assert.match(pageHtml, /釘選/u);
  assert.match(pageHtml, /加入分類/u);
  assert.match(pageHtml, /\/api\/library\/pinned/u);
  assert.match(pageHtml, /\/api\/library\/groups\//u);
  assert.match(pageHtml, /reference\.exists/u);
});

test("M95 reverse 移除 API 索引比對或入口時契約必須失敗", async () => {
  const workbenchSource = await readFile(path.resolve("src/workbench.ts"), "utf8");
  const pageSource = await readFile(path.resolve("src/codex-session-app.ts"), "utf8");
  const required = ["/api/codex/sessions", "markIndexedCodexReferences", "codexReferenceBuckets", "parseCodexSessionFiles", "parseCodexRolloutFileCached", "lowReferences", "Origin", "codexSessionHtml", "Codex 工作階段"];
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
