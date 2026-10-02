import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { sync } from "../src/sync.js";
import { IndexStore } from "../src/store.js";
import { createWorkbench } from "../src/workbench.js";
import type { WorkbenchHandle } from "../src/workbench.js";

interface Fixture {
  temp: string;
  codexHome: string;
  databasePath: string;
  firstPath: string;
  secondPath: string;
  rollout: string;
}

async function createFixture(): Promise<Fixture> {
  const temp = await mkdtemp(path.join(os.tmpdir(), "seekah-m96-"));
  const root = path.join(temp, "indexed-root");
  const codexHome = path.join(temp, "synthetic-codex-home");
  const databasePath = path.join(temp, "data", "index.db");
  const firstPath = path.join(root, "first.md");
  const secondPath = path.join(root, "second.md");
  const rollout = path.join(codexHome, "sessions", "2026", "10", "02", "rollout-m96.jsonl");
  await mkdir(root, { recursive: true });
  await mkdir(path.dirname(rollout), { recursive: true });
  await writeFile(firstPath, "m96 first document\n", "utf8");
  await writeFile(secondPath, "m96 second document\n", "utf8");
  const store = new IndexStore(databasePath);
  try { await sync(root, store); }
  finally { store.close(); }
  await writeFile(rollout, [
    { type: "session_meta", payload: { type: "session_meta", session_id: "m96-session", cwd: root, timestamp: "2026-10-02T10:00:00.000Z" } },
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: `Inspect ${firstPath} and ${secondPath}` }] } },
  ].map(row => JSON.stringify(row)).join("\n") + "\n", "utf8");
  return { temp, codexHome, databasePath, firstPath, secondPath, rollout };
}

function requestHeaders(token: string, origin?: string): Record<string, string> {
  return { "X-LocalDocSearch-Token": token, ...(origin ? { origin } : {}) };
}

async function requestJson(origin: string, token: string, route: string, method = "GET", body?: unknown) {
  const response = await fetch(origin + route, {
    method,
    headers: {
      ...requestHeaders(token, origin),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, data: await response.json() as Record<string, unknown> };
}

test("M96 Codex 與工作台共享 token session 上下文集合", async () => {
  const fixture = await createFixture();
  let handle: WorkbenchHandle | undefined;
  try {
    handle = await createWorkbench({
      databasePath: fixture.databasePath,
      codexHome: fixture.codexHome,
      token: "m96-token",
      secret: Buffer.alloc(32, 96),
      environment: {},
      tempParent: fixture.temp,
      startupOptions: { platform: "linux" },
    });
    const origin = handle.url.split("/#")[0]!;
    const unauthorized = await fetch(origin + "/api/context-selection");
    assert.equal(unauthorized.status, 403);
    const wrongOrigin = await fetch(origin + "/api/context-selection", { headers: requestHeaders(handle.token, "http://evil.test") });
    assert.equal(wrongOrigin.status, 403);

    const initial = await requestJson(origin, handle.token, "/api/context-selection");
    assert.equal(initial.status, 200);
    assert.deepEqual(initial.data.items, []);
    assert.equal(initial.data.temporaryCount, 0);

    const detailResponse = await requestJson(origin, handle.token, "/api/codex/sessions/m96-session/references");
    assert.equal(detailResponse.status, 200);
    const references = detailResponse.data.references as Array<Record<string, unknown>>;
    const first = references.find(item => item.path === fixture.firstPath);
    const second = references.find(item => item.path === fixture.secondPath);
    assert.ok(first && typeof first.seekahReference === "string");
    assert.ok(second && typeof second.seekahReference === "string");
    const firstBody = { path: fixture.firstPath, reference: first.seekahReference, name: "first.md" };
    const secondBody = { path: fixture.secondPath, reference: second.seekahReference, name: "second.md" };

    const added = await requestJson(origin, handle.token, "/api/context-selection", "POST", firstBody);
    assert.equal(added.status, 200);
    assert.deepEqual(added.data.items, [firstBody]);
    const fromCodexPage = await requestJson(origin, handle.token, "/api/context-selection");
    assert.deepEqual(fromCodexPage.data.items, [firstBody]);

    const mismatch = await requestJson(origin, handle.token, "/api/context-selection", "POST", { ...firstBody, path: fixture.secondPath });
    assert.equal(mismatch.status, 400);
    const stale = await requestJson(origin, handle.token, "/api/context-selection", "POST", { ...firstBody, reference: "999999-0000000000000000" });
    assert.equal(stale.status, 400);
    assert.deepEqual((await requestJson(origin, handle.token, "/api/context-selection")).data.items, [firstBody]);

    const temporaryAtLimit = await requestJson(origin, handle.token, "/api/context-selection", "PUT", { temporaryCount: 19 });
    assert.equal(temporaryAtLimit.status, 200);
    assert.equal(temporaryAtLimit.data.temporaryCount, 19);
    const rejectedByLimit = await requestJson(origin, handle.token, "/api/context-selection", "POST", secondBody);
    assert.equal(rejectedByLimit.status, 409);
    const stillLimited = await requestJson(origin, handle.token, "/api/context-selection");
    assert.deepEqual(stillLimited.data.items, [firstBody]);
    assert.equal(stillLimited.data.temporaryCount, 19);

    assert.equal((await requestJson(origin, handle.token, "/api/context-selection", "PUT", { temporaryCount: 0 })).status, 200);
    const addedSecond = await requestJson(origin, handle.token, "/api/context-selection", "POST", secondBody);
    assert.equal(addedSecond.status, 200);
    assert.deepEqual(addedSecond.data.items, [firstBody, secondBody]);
    const removed = await requestJson(origin, handle.token, "/api/context-selection", "DELETE", { reference: secondBody.reference });
    assert.equal(removed.status, 200);
    assert.deepEqual(removed.data.items, [firstBody]);
    const cleared = await requestJson(origin, handle.token, "/api/context-selection", "DELETE", { clear: true });
    assert.equal(cleared.status, 200);
    assert.deepEqual(cleared.data.items, []);
  } finally {
    if (handle) await handle.close();
    await rm(fixture.temp, { recursive: true, force: true });
  }
});

function assertContextPageContract(workbenchSource: string, codexSource: string): void {
  for (const marker of ["/api/context-selection", "contextSelection", "temporaryCount", "indexedLibraryDocument"]) {
    assert.match(workbenchSource, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")), `工作台缺少 ${marker}。`);
  }
  for (const marker of ["/api/context-selection", "toggleContext", "加入上下文", "移出上下文", "contextSelection"]) {
    assert.match(codexSource, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")), `Codex 頁缺少 ${marker}。`);
  }
  assert.match(workbenchSource, /refreshContextSelection/u);
  assert.match(codexSource, /loadContextSelection/u);
  assert.match(codexSource, /context\.dataset\.action = "context"/u);
  assert.match(workbenchSource, /toggle\.dataset\.action = "context"/u);
}

test("M96 reverse 移除共用 API 或 Codex 操作接線時必須失敗", async () => {
  const workbenchSource = await readFile(path.resolve("src/workbench.ts"), "utf8");
  const workbenchAppSource = await readFile(path.resolve("src/workbench-app.ts"), "utf8");
  const codexSource = await readFile(path.resolve("src/codex-session-app.ts"), "utf8");
  assertContextPageContract(workbenchSource + workbenchAppSource, codexSource);
  const withoutApi = (workbenchSource + workbenchAppSource).replaceAll("/api/context-selection", "/api/removed-context-selection");
  assert.throws(() => assertContextPageContract(withoutApi, codexSource), /共用 API|context-selection/u);
  const withoutCodexAction = codexSource.replace('context.dataset.action = "context";', 'context.dataset.action = "removed";');
  assert.throws(() => assertContextPageContract(workbenchSource + workbenchAppSource, withoutCodexAction), /dataset|加入上下文|移出上下文|接線/u);
  const withoutWorkBenchPoll = workbenchAppSource.replaceAll("refreshContextSelection", "removedContextRefresh");
  assert.throws(() => assertContextPageContract(workbenchSource + withoutWorkBenchPoll, codexSource), /refreshContextSelection/u);
});
