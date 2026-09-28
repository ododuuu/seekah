import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { request as httpRequest } from "node:http";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { sync } from "../src/sync.js";
import { IndexStore } from "../src/store.js";
import { downgradeToPreChunk } from "./legacy-index.js";
import { importDocument, renderImportedContext, sanitizeUploadName, uploadExtension } from "../src/workbench-context.js";
import { workbenchHtml } from "../src/workbench-app.js";
import { previewId, previewMatches, ProviderError, ProviderKeys, requestProvider } from "../src/workbench-provider.js";
import { createWorkbench } from "../src/workbench.js";
import { FolderPickerError, selectFolder } from "../src/folder-picker.js";


function rawStatus(url: string, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, { headers: { host, "X-LocalDocSearch-Token": "test-token" } }, response => {
      response.resume();
      response.on("end", () => resolve(response.statusCode ?? 0));
    });
    request.on("error", reject);
    request.end();
  });
}

test("0.35 drag context reuses parsers, sanitizes names and applies a byte-safe bound", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "lds-m35-context-"));
  const file = path.join(temp, "sample.txt");
  try {
    await writeFile(file, "drag-context-needle\n第二行");
    const document = await importDocument(file, "../報告\u202e.txt", "00000000-0000-4000-8000-000000000001");
    assert.equal(document.filename, ".._報告_.txt");
    assert.equal(document.status, "indexed");
    const rendered = renderImportedContext([document], 220);
    assert.ok(rendered.bytes <= 220);
    assert.equal(rendered.truncated, true);
    assert.match(rendered.text, /拖曳文件上下文/u);
    assert.throws(() => uploadExtension("archive.zip"), /不支援/u);
    assert.equal(sanitizeUploadName("a\\b/c.txt"), "a_b_c.txt");
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test("0.36.2 provider keys stay in memory and preview ids bind route values", () => {
  const keys = new ProviderKeys({ OPENAI_API_KEY: "env-openai" });
  assert.deepEqual(keys.state("openai"), { configured: true, source: "environment", defaultModel: "auto" });
  keys.configure("openai", "session-openai");
  assert.equal(keys.get("openai"), "session-openai");
  assert.equal(keys.state("openai").source, "session");
  const secret = Buffer.alloc(32, 7);
  const first = previewId(secret, { provider: "openai", model: "gpt-5.6-terra", question: "問題", context: "內容", route: "route-a" });
  const second = previewId(secret, { provider: "openai", model: "gpt-5.6-terra", question: "問題", context: "內容", route: "route-b" });
  assert.equal(previewMatches(first, first), true);
  assert.equal(previewMatches(first, second), false);
  keys.destroy();
  assert.equal(keys.get("openai"), "env-openai");
});

test("0.36.2 provider adapter uses fixed Responses endpoints and never echoes keys", async () => {
  const calls: Array<{ url: string; init: RequestInit; body: Record<string, unknown> }> = [];
  const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {}, body: JSON.parse(String(init?.body)) as Record<string, unknown> });
    return new Response(JSON.stringify({ output: [{ content: [{ type: "output_text", text: "provider-answer" }] }] }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const common = { model: "model-1", question: "q", context: "c", apiKey: "top-secret-key" };
  assert.equal(await requestProvider({ provider: "openai", ...common }, fakeFetch), "provider-answer");
  assert.equal(await requestProvider({ provider: "xai", ...common }, fakeFetch), "provider-answer");
  assert.equal(calls[0]?.url, "https://api.openai.com/v1/responses");
  assert.equal(calls[1]?.url, "https://api.x.ai/v1/responses");
  assert.equal(new Headers(calls[0]?.init.headers).get("authorization"), "Bearer top-secret-key");
  assert.equal(calls[0]?.body.store, false);
  assert.equal("store" in calls[1]!.body, false);
  const rejected = (async () => new Response(JSON.stringify({ error: { message: "bad top-secret-key" } }), { status: 401 })) as typeof fetch;
  await assert.rejects(() => requestProvider({ provider: "openai", ...common }, rejected), (error: unknown) => {
    assert.ok(error instanceof ProviderError);
    assert.doesNotMatch(error.message, /top-secret-key/u);
    assert.match(error.message, /\[REDACTED\]/u);
    return true;
  });
});
test("0.37.0 folder picker reports unsupported platforms without pretending to select a root", async () => {
  await assert.rejects(() => selectFolder("linux"), (error: unknown) => {
    assert.ok(error instanceof FolderPickerError);
    assert.equal(error.code, "FOLDER_PICKER_UNSUPPORTED");
    assert.match(error.message, /CLI index/u);
    return true;
  });
});

test("0.37.0 desktop workbench keeps the shell self-contained and safe", () => {
  const html = workbenchHtml("fixed-nonce");
  assert.match(html, /<script nonce="fixed-nonce">/u);
  assert.match(html, /min-width: 1180px/u);
  assert.match(html, /--sidebar-width: 246px/u);
  for (const page of ["documents", "detail", "temporary", "roots", "trash"]) assert.match(html, new RegExp(`dataset\\.page = "${page}"`, "u"));
  for (const endpoint of ["/api/state", "/api/index-status", "/api/search", "/api/files", "/api/document-action", "/api/preview"]) assert.match(html, new RegExp(endpoint.replace("/", "\\/"), "u"));
  assert.match(html, /dataTransfer\.files/u);
  assert.match(html, /replaceChildren/u);
  assert.match(html, /textContent/u);
  assert.doesNotMatch(html, /innerHTML|outerHTML|insertAdjacentHTML/u);
  assert.doesNotMatch(html, /localStorage|sessionStorage|document\.cookie/u);
  assert.doesNotMatch(html, /<script[^>]+src=|<link[^>]+href=/iu);
  assert.doesNotMatch(html, /https?:\/\//iu);
  assert.doesNotMatch(html, /mobile-nav|contextPanel\.hidden=true|context-closed/u);
});

test("0.36.2 loopback workbench enforces status, selection, preview, consent and one-shot ask", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "lds-m35-http-"));
  const root = path.join(temp, "docs");
  const databasePath = path.join(temp, "data", "index.db");
  await mkdir(root);
  await writeFile(path.join(root, "indexed.txt"), "indexed-http-needle 測試");
  const store = new IndexStore(databasePath);
  await sync(root, store);
  store.close();
  const outbound: Array<{ url: string; body: string }> = [];
  let quotaNext = false;
  const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    outbound.push({ url: String(input), body: String(init?.body) });
    if (quotaNext && String(input) === "https://api.openai.com/v1/responses") {
      quotaNext = false;
      return new Response(JSON.stringify({ error: { message: "quota exceeded" } }), { status: 429 });
    }
    return new Response(JSON.stringify({ output_text: "local-fake-answer" }), { status: 200 });
  }) as typeof fetch;
  const handle = await createWorkbench({ databasePath, token: "test-token", secret: Buffer.alloc(32, 3), environment: {}, fetcher: fakeFetch, tempParent: temp, selectFolder: async () => root });
  const origin = handle.url.split("/#")[0]!;
  const headers = { "X-LocalDocSearch-Token": "test-token" };
  const postHeaders = { ...headers, origin, "content-type": "application/json" };
  try {
    const html = await fetch(origin + "/");
    assert.equal(html.status, 200);
    assert.match(html.headers.get("content-security-policy") ?? "", /default-src 'none'/u);
    assert.equal((await fetch(origin + "/api/state")).status, 403);
    assert.equal(await rawStatus(origin + "/api/state", "localhost"), 421);
    const state = await fetch(origin + "/api/state", { headers });
    assert.equal(state.status, 200);
    const stateData = await state.json() as { indexAvailable: boolean; providerChoices: string[]; modelChoices: Array<{ id: string }>; providers: { auto: { defaultModel: string } } };
    assert.equal(stateData.indexAvailable, true);
    assert.deepEqual(stateData.providerChoices, ["auto", "openai", "xai"]);
    assert.ok(stateData.modelChoices.some(item => item.id === "astra-6"));
    assert.equal(stateData.providers.auto.defaultModel, "auto");

    const status = await fetch(origin + "/api/index-status", { headers });
    assert.equal(status.status, 200);
    const statusData = await status.json() as { state: string; counts: Record<string, number>; roots: Array<{ path: string; documentCount: number; lastSuccessfulSync: string | null }> };
    assert.equal(statusData.state, "available");
    assert.equal(statusData.counts.indexed, 1);
    assert.equal(statusData.roots[0]?.path, root);
    assert.equal(statusData.roots[0]?.documentCount, 1);
    assert.ok(statusData.roots[0]?.lastSuccessfulSync);
    const choose = await fetch(origin + "/api/select-folder", { method: "POST", headers: postHeaders });
    assert.equal(choose.status, 200);
    assert.deepEqual(await choose.json(), { root });
    await writeFile(path.join(root, "fresh-http.txt"), "fresh-http-needle");
    const refresh = await fetch(origin + "/api/index", { method: "POST", headers: postHeaders, body: JSON.stringify({}) });
    assert.equal(refresh.status, 202);
    assert.equal((await refresh.json() as { indexing: { state: string } }).indexing.state, "running");
    await handle.waitForIndex();
    const completedStatus = await fetch(origin + "/api/index-status", { headers });
    assert.equal(completedStatus.status, 200);
    const completedIndexing = await completedStatus.json() as { indexing: { state: string; progress: { stage: string; current: number; total: number } } };
    assert.equal(completedIndexing.indexing.state, "complete");
    assert.equal(completedIndexing.indexing.progress.stage, "complete");
    assert.equal(completedIndexing.indexing.progress.current, completedIndexing.indexing.progress.total);
    const refreshedSearch = await fetch(origin + "/api/search", { method: "POST", headers: postHeaders, body: JSON.stringify({ query: "fresh-http-needle", mode: "phrase", page: 1, pageSize: 20 }) });
    assert.equal(refreshedSearch.status, 200);
    assert.equal((await refreshedSearch.json() as { results: unknown[] }).results.length, 1);
    // An index written before 0.39.0 has no chunk store yet (SPEC §52.4).
    downgradeToPreChunk(databasePath);
    const pendingShortSearch = await fetch(origin + "/api/search", { method: "POST", headers: postHeaders,
      body: JSON.stringify({ query: "測試", mode: "phrase", page: 1, pageSize: 20 }) });
    assert.equal(pendingShortSearch.status, 202);
    const pendingData = await pendingShortSearch.json() as { pendingUpgrade: boolean; message: string };
    assert.equal(pendingData.pendingUpgrade, true);
    assert.match(pendingData.message, /搜尋索引升級/u);
    await handle.waitForIndex();
    const upgradedShortSearch = await fetch(origin + "/api/search", { method: "POST", headers: postHeaders,
      body: JSON.stringify({ query: "測試", mode: "phrase", page: 1, pageSize: 20 }) });
    assert.equal(upgradedShortSearch.status, 200);
    assert.equal((await upgradedShortSearch.json() as { results: unknown[] }).results.length, 1);

    const search = await fetch(origin + "/api/search", { method: "POST", headers: postHeaders, body: JSON.stringify({ query: "indexed-http-needle", mode: "phrase", page: 1, pageSize: 20 }) });
    assert.equal(search.status, 200);
    const searchData = await search.json() as { query: string; results: Array<{ reference: string }>; trace: { type: string; candidateStrategy: string; counts: { results: number } } };
    assert.equal(searchData.query, "indexed-http-needle");
    assert.equal(searchData.results.length, 1);
    assert.equal(searchData.trace.type, "search");
    assert.equal(searchData.trace.candidateStrategy, "chunk-index");
    assert.equal(searchData.trace.counts.results, 1);

    const invalidAction = await fetch(origin + "/api/document-action", { method: "POST", headers: postHeaders, body: JSON.stringify({ reference: searchData.results[0]!.reference, action: "delete" }) });
    assert.equal(invalidAction.status, 400);
    const staleAction = await fetch(origin + "/api/document-action", { method: "POST", headers: postHeaders, body: JSON.stringify({ reference: "999-0000000000000000", action: "open" }) });
    assert.equal(staleAction.status, 400);

    const upload = await fetch(origin + "/api/files", { method: "POST", headers: { ...headers, origin, "X-File-Name": encodeURIComponent("臨時.txt"), "content-type": "application/octet-stream" }, body: "drag-http-needle" });
    assert.equal(upload.status, 201);
    const uploaded = await upload.json() as { id: string; status: string };
    assert.equal(uploaded.status, "indexed");

    const filenameOnly = await fetch(origin + "/api/search", { method: "POST", headers: postHeaders,
      body: JSON.stringify({ query: "indexed-http-needle", mode: "phrase", field: "filename", page: 1, pageSize: 20 }) });
    assert.equal((await filenameOnly.json() as { results: unknown[] }).results.length, 0);
    const contentOnly = await fetch(origin + "/api/search", { method: "POST", headers: postHeaders,
      body: JSON.stringify({ query: "indexed-http-needle", mode: "phrase", field: "content", statuses: ["indexed"], types: [".txt"], sort: "filename", page: 1, pageSize: 20 }) });
    assert.equal((await contentOnly.json() as { results: unknown[] }).results.length, 1);

    const unsupported = await fetch(origin + "/api/files", { method: "POST", headers: { ...headers, origin,
      "X-File-Name": encodeURIComponent("只可搜尋名稱.xyz"), "content-type": "application/octet-stream" }, body: "unparsed-secret" });
    assert.equal(unsupported.status, 201);
    const unsupportedData = await unsupported.json() as { id: string; status: string; errorMessage: string };
    assert.equal(unsupportedData.status, "unsupported");
    assert.match(unsupportedData.errorMessage, /只能搜尋檔名/u);
    const temporarySearch = await fetch(origin + "/api/search", { method: "POST", headers: postHeaders,
      body: JSON.stringify({ query: "只可搜尋名稱", mode: "phrase", field: "filename", page: 1, pageSize: 20 }) });
    const temporaryData = await temporarySearch.json() as { temporaryResults: Array<{ id: string; status: string }> };
    assert.equal(temporaryData.temporaryResults.length, 1);
    assert.equal(temporaryData.temporaryResults[0]?.id, unsupportedData.id);
    assert.equal(temporaryData.temporaryResults[0]?.status, "unsupported");
    const removeUnsupported = await fetch(origin + "/api/files/" + unsupportedData.id, { method: "DELETE", headers: postHeaders });
    assert.equal(removeUnsupported.status, 200);

    const base = { provider: "openai", model: "gpt-5.6-terra", question: "請回答", mode: "phrase", selections: [{ query: "indexed-http-needle", reference: searchData.results[0]!.reference }], fileIds: [uploaded.id] };
    const preview = await fetch(origin + "/api/preview", { method: "POST", headers: postHeaders, body: JSON.stringify(base) });
    assert.equal(preview.status, 200);
    const previewData = await preview.json() as { previewId: string; context: string; bytes: number; documentCount: number; route: { primary: { provider: string; model: string } } };
    assert.match(previewData.context, /indexed-http-needle/u);
    assert.match(previewData.context, /drag-http-needle/u);
    assert.equal(previewData.documentCount, 2);
    assert.doesNotMatch(previewData.context, /(?:建立時間|修改時間)：|\d{4}-\d{2}-\d{2}T/u);
    assert.equal(previewData.route.primary.model, "gpt-5.6-terra");

    const configure = await fetch(origin + "/api/providers", { method: "POST", headers: postHeaders, body: JSON.stringify({ provider: "openai", key: "session-key" }) });
    assert.equal(configure.status, 200);
    assert.doesNotMatch(await configure.text(), /session-key/u);
    const stale = await fetch(origin + "/api/ask", { method: "POST", headers: postHeaders, body: JSON.stringify({ ...base, question: "已改問題", previewId: previewData.previewId, confirmed: true }) });
    assert.equal(stale.status, 409);
    const staleData = await stale.json() as { trace: { type: string; status: string; errorCode?: string } };
    assert.equal(staleData.trace.type, "answer");
    assert.equal(staleData.trace.status, "error");
    assert.equal(staleData.trace.errorCode, "ANSWER_FAILED");
    assert.equal(outbound.length, 0);
    const ask = await fetch(origin + "/api/ask", { method: "POST", headers: postHeaders, body: JSON.stringify({ ...base, previewId: previewData.previewId, confirmed: true }) });
    assert.equal(ask.status, 200);
    const askData = await ask.json() as { answer: string; provider: string; model: string; fallbackUsed: boolean; trace: { type: string; status: string; provider: string; counts: { providerAttempts: number } } };
    assert.deepEqual({ answer: askData.answer, provider: askData.provider, model: askData.model, fallbackUsed: askData.fallbackUsed },
      { answer: "local-fake-answer", provider: "openai", model: "gpt-5.6-terra", fallbackUsed: false });
    assert.equal(askData.trace.type, "answer");
    assert.equal(askData.trace.status, "success");
    assert.equal(askData.trace.provider, "openai");
    assert.equal(askData.trace.counts.providerAttempts, 1);
    const duplicate = await fetch(origin + "/api/ask", { method: "POST", headers: postHeaders, body: JSON.stringify({ ...base, previewId: previewData.previewId, confirmed: true }) });
    assert.equal(duplicate.status, 409);
    assert.equal(outbound.length, 1);

    const configureXai = await fetch(origin + "/api/providers", { method: "POST", headers: postHeaders, body: JSON.stringify({ provider: "xai", key: "xai-session-key" }) });
    assert.equal(configureXai.status, 200);
    assert.doesNotMatch(await configureXai.text(), /xai-session-key/u);
    quotaNext = true;
    const autoBase = { ...base, provider: "auto", model: "auto", question: "請設計 schema migration 的 rollback plan" };
    const autoPreview = await fetch(origin + "/api/preview", { method: "POST", headers: postHeaders, body: JSON.stringify(autoBase) });
    assert.equal(autoPreview.status, 200);
    const autoPreviewData = await autoPreview.json() as { previewId: string; route: { primary: { provider: string; model: string }; fallback?: { provider: string; model: string } } };
    assert.deepEqual(autoPreviewData.route.primary, { provider: "openai", model: "gpt-6-astra" });
    assert.deepEqual(autoPreviewData.route.fallback, { provider: "xai", model: "grok-4.6" });
    const autoAsk = await fetch(origin + "/api/ask", { method: "POST", headers: postHeaders, body: JSON.stringify({ ...autoBase, previewId: autoPreviewData.previewId, confirmed: true }) });
    assert.equal(autoAsk.status, 200);
    const autoAskData = await autoAsk.json() as { answer: string; provider: string; model: string; fallbackUsed: boolean; trace: { type: string; status: string; provider: string; model: string; fallbackUsed: boolean; bottleneck: string; phasesMs: Record<string, number>; counts: { selectedDocuments: number; contextBytes: number; answerCharacters: number; answerBytes: number; providerAttempts: number } } };
    assert.deepEqual({ answer: autoAskData.answer, provider: autoAskData.provider, model: autoAskData.model, fallbackUsed: autoAskData.fallbackUsed },
      { answer: "local-fake-answer", provider: "xai", model: "grok-4.6", fallbackUsed: true });
    assert.equal(autoAskData.trace.type, "answer");
    assert.equal(autoAskData.trace.status, "success");
    assert.equal(autoAskData.trace.provider, "xai");
    assert.equal(autoAskData.trace.model, "grok-4.6");
    assert.equal(autoAskData.trace.fallbackUsed, true);
    assert.equal(autoAskData.trace.counts.selectedDocuments, 2);
    assert.equal(autoAskData.trace.counts.providerAttempts, 2);
    assert.ok(autoAskData.trace.counts.contextBytes > 0);
    assert.ok(autoAskData.trace.counts.answerCharacters > 0);
    assert.ok(autoAskData.trace.counts.answerBytes > 0);
    assert.ok(Number.isFinite(autoAskData.trace.phasesMs.contextBuild));
    assert.ok(Number.isFinite(autoAskData.trace.phasesMs.responseParsing));
    assert.ok(autoAskData.trace.bottleneck in autoAskData.trace.phasesMs);
    assert.equal(handle.lastAnswerTrace()?.counts.providerAttempts, 2);
    assert.equal(outbound.length, 3);
    const answerLog = await fetch(origin + "/api/traces?type=answer&limit=20", { headers: { "X-LocalDocSearch-Token": handle.token } });
    assert.equal(answerLog.status, 200);
    const answerLogData = await answerLog.json() as { traces: { type: string; status: string; fallbackUsed: boolean; traceId: string }[] };
    assert.ok(answerLogData.traces.some(trace => trace.type === "answer" && trace.status === "success" && trace.fallbackUsed && trace.traceId));
  } finally {
    await handle.close();
    const leftovers = (await readdir(temp)).filter(name => name.startsWith("localdocsearch-ui-"));
    assert.deepEqual(leftovers, []);
    await rm(temp, { recursive: true, force: true });
  }
});

test("0.37.0 empty workbench search still returns a structured trace", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "lds-m35-empty-search-trace-"));
  const databasePath = path.join(temp, "missing", "index.db");
  const handle = await createWorkbench({
    databasePath,
    token: "test-token",
    secret: Buffer.alloc(32, 4),
    environment: {},
    fetcher: async () => new Response(JSON.stringify({ output_text: "unused" }), { status: 200 }),
    tempParent: temp,
    selectFolder: async () => temp,
  });
  const origin = handle.url.split("/#")[0]!;
  const headers = { "X-LocalDocSearch-Token": "test-token", origin, "content-type": "application/json" };
  try {
    const response = await fetch(origin + "/api/search", {
      method: "POST",
      headers,
      body: JSON.stringify({ query: "missing", mode: "phrase", page: 1, pageSize: 20 }),
    });
    assert.equal(response.status, 200);
    const data = await response.json() as { results: unknown[]; trace: { candidateStrategy: string; candidateSources: string[]; counts: { documentsInScope: number; results: number } } };
    assert.equal(data.results.length, 0);
    assert.equal(data.trace.candidateStrategy, "none");
    assert.deepEqual(data.trace.candidateSources, []);
    assert.equal(data.trace.counts.documentsInScope, 0);
    assert.equal(data.trace.counts.results, 0);
  } finally {
    await handle.close();
    await rm(temp, { recursive: true, force: true });
  }
});
