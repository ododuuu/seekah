import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { sync } from "../src/sync.js";
import { IndexStore } from "../src/store.js";
import { workbenchHtml } from "../src/workbench-app.js";
import { createWorkbench } from "../src/workbench.js";

async function seedWorkbenchIndex(temp: string): Promise<{ databasePath: string; root: string }> {
  const databasePath = path.join(temp, "data", "index.db");
  const root = path.join(temp, "watched");
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, "note.txt"), "m47-autoupdate-needle\n");
  const store = new IndexStore(databasePath);
  try { await sync(root, store); }
  finally { store.close(); }
  return { databasePath, root };
}

function requestHeaders(origin: string, token: string): Record<string, string> {
  return { "X-LocalDocSearch-Token": token, origin, "content-type": "application/json" };
}

test("M47 /api/settings validates and persists autoupdate parameters across workbench restart", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "lds-m47-settings-"));
  const { databasePath } = await seedWorkbenchIndex(temp);
  const create = () => createWorkbench({ databasePath, token: "m47-token", secret: Buffer.alloc(32, 7), environment: {}, tempParent: temp,
    startupOptions: { platform: "linux" } });
  let handle = await create();
  const origin = handle.url.split("/#")[0]!;
  const headers = requestHeaders(origin, handle.token);
  try {
    const wrongType = await fetch(origin + "/api/settings", { method: "POST", headers, body: JSON.stringify({ autoupdateDebounceMs: "2000" }) });
    assert.equal(wrongType.status, 400);
    assert.match((await wrongType.json() as { error: string }).error, /變更等待/u);
    const wrongRange = await fetch(origin + "/api/settings", { method: "POST", headers, body: JSON.stringify({ autoupdateDebounceMs: 199 }) });
    assert.equal(wrongRange.status, 400);
    const wrongReconcile = await fetch(origin + "/api/settings", { method: "POST", headers, body: JSON.stringify({ autoupdateReconcileMs: 86_400_001 }) });
    assert.equal(wrongReconcile.status, 400);

    const saved = await fetch(origin + "/api/settings", { method: "POST", headers,
      body: JSON.stringify({ autoupdateDebounceMs: 2_400, autoupdateReconcileMs: 900_000 }) });
    assert.equal(saved.status, 200);
    assert.deepEqual((await saved.json() as { autoupdateSettings: { debounceMs: number; reconcileMs: number } }).autoupdateSettings,
      { debounceMs: 2_400, reconcileMs: 900_000 });
  } finally {
    await handle.close();
  }

  handle = await create();
  const restartedOrigin = handle.url.split("/#")[0]!;
  try {
    const status = await fetch(restartedOrigin + "/api/index-status", { headers: requestHeaders(restartedOrigin, handle.token) });
    assert.equal(status.status, 200);
    assert.deepEqual((await status.json() as { autoupdateSettings: { debounceMs: number; reconcileMs: number } }).autoupdateSettings,
      { debounceMs: 2_400, reconcileMs: 900_000 });
  } finally {
    await handle.close();
    await rm(temp, { recursive: true, force: true });
  }
});

test("M47 changing live autoupdate parameters restarts the daemon and exposes LiveStatus", { timeout: 120_000 }, async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "lds-m47-live-"));
  const { databasePath } = await seedWorkbenchIndex(temp);
  const handle = await createWorkbench({ databasePath, token: "m47-live-token", secret: Buffer.alloc(32, 8), environment: {}, tempParent: temp,
    startupOptions: { platform: "linux" } });
  const origin = handle.url.split("/#")[0]!;
  const headers = requestHeaders(origin, handle.token);
  try {
    const started = await fetch(origin + "/api/settings", { method: "POST", headers, body: JSON.stringify({ autoupdateEnabled: true }) });
    assert.equal(started.status, 200);
    const firstStatus = await fetch(origin + "/api/index-status", { headers: { "X-LocalDocSearch-Token": handle.token } });
    const first = await firstStatus.json() as { autoupdate: { live?: { instanceId: string; settings: { debounceMs: number; reconcileMs: number } } } };
    assert.equal(first.autoupdate.live?.settings.debounceMs, 1_500);
    assert.equal(first.autoupdate.live?.settings.reconcileMs, 21_600_000);
    const firstInstance = first.autoupdate.live?.instanceId;
    assert.ok(firstInstance);

    const changed = await fetch(origin + "/api/settings", { method: "POST", headers,
      body: JSON.stringify({ autoupdateDebounceMs: 2_200, autoupdateReconcileMs: 900_000 }) });
    assert.equal(changed.status, 200);
    const changedData = await changed.json() as {
      message?: string;
      autoupdate: { live?: { instanceId: string; settings: { debounceMs: number; reconcileMs: number } } };
    };
    assert.match(changedData.message ?? "", /重新啟動/u);
    assert.equal(changedData.autoupdate.live?.settings.debounceMs, 2_200);
    assert.equal(changedData.autoupdate.live?.settings.reconcileMs, 900_000);
    assert.notEqual(changedData.autoupdate.live?.instanceId, firstInstance);

    const stopped = await fetch(origin + "/api/settings", { method: "POST", headers, body: JSON.stringify({ autoupdateEnabled: false }) });
    assert.equal(stopped.status, 200);
    const stoppedData = await stopped.json() as { autoupdate: { live?: unknown; enabled: boolean } };
    assert.equal(stoppedData.autoupdate.enabled, false);
    assert.equal("live" in stoppedData.autoupdate, false);
    const afterStop = await fetch(origin + "/api/index-status", { headers: { "X-LocalDocSearch-Token": handle.token } });
    const afterStopData = await afterStop.json() as { autoupdate: { live?: unknown; enabled: boolean } };
    assert.equal(afterStopData.autoupdate.enabled, false);
    assert.equal("live" in afterStopData.autoupdate, false);
  } finally {
    try { await fetch(origin + "/api/settings", { method: "POST", headers, body: JSON.stringify({ autoupdateEnabled: false }) }); } catch { /* already stopped */ }
    await handle.close();
    await rm(temp, { recursive: true, force: true });
  }
});

test("M47 workbench startup setting reports platform support and writes saved shortcut parameters", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "lds-m47-startup-"));
  const { databasePath } = await seedWorkbenchIndex(temp);
  const appData = path.join(temp, "Roaming");
  const calls: NodeJS.ProcessEnv[] = [];
  const runPowerShell = async (_executable: string, _args: readonly string[], commandEnv: NodeJS.ProcessEnv) => {
    calls.push(commandEnv);
    await mkdir(path.dirname(commandEnv.SEEKAH_STARTUP_SHORTCUT!), { recursive: true });
    await writeFile(commandEnv.SEEKAH_STARTUP_SHORTCUT!, "fake shortcut");
  };
  const linuxHandle = await createWorkbench({ databasePath, token: "m47-linux-token", secret: Buffer.alloc(32, 9), environment: {}, tempParent: temp,
    startupOptions: { platform: "linux", env: { APPDATA: appData }, homedir: temp } });
  const linuxOrigin = linuxHandle.url.split("/#")[0]!;
  try {
    const status = await fetch(linuxOrigin + "/api/index-status", { headers: { "X-LocalDocSearch-Token": linuxHandle.token } });
    const startup = (await status.json() as { autoupdateStartup: { supported: boolean; enabled: boolean } }).autoupdateStartup;
    assert.deepEqual(startup, { supported: false, enabled: false, message: "登入啟動：不支援（僅 Windows）；請使用手動 autoupdate start。" });
  } finally {
    await linuxHandle.close();
  }

  const windowsHandle = await createWorkbench({ databasePath, token: "m47-windows-token", secret: Buffer.alloc(32, 10), environment: {}, tempParent: temp,
    startupOptions: { platform: "win32", env: { APPDATA: appData, SystemRoot: "C:\\Windows" }, homedir: temp, runPowerShell } });
  const windowsOrigin = windowsHandle.url.split("/#")[0]!;
  const windowsHeaders = requestHeaders(windowsOrigin, windowsHandle.token);
  try {
    const saved = await fetch(windowsOrigin + "/api/settings", { method: "POST", headers: windowsHeaders,
      body: JSON.stringify({ autoupdateDebounceMs: 2_800, autoupdateReconcileMs: 1_800_000 }) });
    assert.equal(saved.status, 200);
    const enabled = await fetch(windowsOrigin + "/api/settings", { method: "POST", headers: windowsHeaders,
      body: JSON.stringify({ autoupdateStartup: true }) });
    assert.equal(enabled.status, 200);
    const enabledData = await enabled.json() as { autoupdateStartup: { supported: boolean; enabled: boolean; message: string } };
    assert.deepEqual(enabledData.autoupdateStartup, { supported: true, enabled: true,
      message: expectMessage(enabledData.autoupdateStartup.message) });
    assert.equal(calls.length, 1);
    assert.match(calls[0]!.SEEKAH_STARTUP_ARGUMENTS ?? "", /--debounce 2800/u);
    assert.match(calls[0]!.SEEKAH_STARTUP_ARGUMENTS ?? "", /--reconcile 1800000/u);
    const rewritten = await fetch(windowsOrigin + "/api/settings", { method: "POST", headers: windowsHeaders,
      body: JSON.stringify({ autoupdateDebounceMs: 3_200, autoupdateReconcileMs: 3_600_000 }) });
    assert.equal(rewritten.status, 200);
    assert.equal(calls.length, 2);
    assert.match(calls[1]!.SEEKAH_STARTUP_ARGUMENTS ?? "", /--debounce 3200/u);
    assert.match(calls[1]!.SEEKAH_STARTUP_ARGUMENTS ?? "", /--reconcile 3600000/u);
    const disabled = await fetch(windowsOrigin + "/api/settings", { method: "POST", headers: windowsHeaders,
      body: JSON.stringify({ autoupdateStartup: false }) });
    assert.equal(disabled.status, 200);
    assert.equal((await disabled.json() as { autoupdateStartup: { enabled: boolean } }).autoupdateStartup.enabled, false);
  } finally {
    await windowsHandle.close();
    await rm(temp, { recursive: true, force: true });
  }
});

function expectMessage(message: string): string {
  assert.match(message, /登入啟動：已啟用/u);
  return message;
}

test("M47 workbench settings exposes autoupdate controls and summary elements", () => {
  const html = workbenchHtml("m47-fixed-nonce");
  for (const id of [
    "settings-autoupdate", "settings-autoupdate-startup", "settings-autoupdate-refresh",
    "settings-autoupdate-debounce", "settings-autoupdate-reconcile", "settings-autoupdate-summary",
    "settings-exclusion-policy", "settings-exclusion-policy-list",
  ]) assert.match(html, new RegExp(id, "u"));
  assert.match(html, /登入 Windows 時自動啟動背景自動更新/u);
  assert.match(html, /僅 Windows 支援/u);
  assert.match(html, /textContent/u);
  assert.doesNotMatch(html, /innerHTML/u);
});
