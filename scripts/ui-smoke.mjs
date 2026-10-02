import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(project, "dist", "src", "cli.js");
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const outputDir = mkdtempSync(path.join(os.tmpdir(), "seekah-ui-smoke-output-"));
const results = [];
const browserEvents = [];
const syntheticProcessPaths = new Set();

function text(value) {
  return value === undefined || value === null ? "" : String(value);
}

function errorText(error) {
  return error instanceof Error ? error.message : text(error);
}

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

function truncate(value, limit = 500) {
  const rendered = text(value).replace(/\s+/gu, " ").trim();
  return rendered.length > limit ? rendered.slice(0, limit) + "…" : rendered;
}

async function check(label, callback) {
  try {
    await callback();
    results.push({ status: "pass", label });
    console.log(`[PASS] ${label}`);
  } catch (error) {
    const message = truncate(errorText(error));
    results.push({ status: "fail", label, message });
    console.log(`[FAIL] ${label}: ${message}`);
  }
}

function findChrome() {
  const candidates = [
    process.env.SEEKAH_CHROME_PATH,
    process.env.CHROME_PATH,
    process.platform === "win32" ? path.join(process.env.PROGRAMFILES ?? "C:\\Program Files", "Google", "Chrome", "Application", "chrome.exe") : null,
    process.platform === "win32" ? path.join(process.env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)", "Google", "Chrome", "Application", "chrome.exe") : null,
    process.platform === "win32" && process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe") : null,
    process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : null,
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ].filter(Boolean);
  return candidates.find(candidate => existsSync(candidate)) ?? null;
}

async function unusedPort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(error => error ? reject(error) : resolve(typeof address === "object" && address ? address.port : 0));
    });
  });
}

function waitForExit(child) {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  return new Promise(resolve => child.once("exit", code => resolve(code ?? 0)));
}
async function stopProcess(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === "win32") {
    spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
  } else {
    child.kill("SIGTERM");
  }
  await Promise.race([waitForExit(child), sleep(2_000)]);
  if (child.exitCode === null) {
    if (process.platform === "win32") {
      spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    } else {
      child.kill("SIGKILL");
    }
    await Promise.race([waitForExit(child), sleep(2_000)]);
  }
  if (child.exitCode === null) throw new Error(`無法停止子程序 PID ${child.pid}。`);
}
async function removeDirectory(directory, label) {
  const deadline = Date.now() + 10_000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      await rm(directory, { recursive: true, force: true });
      return;
    } catch (error) {
      lastError = error;
      if (error?.code !== "EBUSY" && error?.code !== "EPERM") throw error;
      await sleep(250);
    }
  }
  throw new Error(`${label} 清理逾時：${errorText(lastError)}`);
}
async function stopChrome(child, profile) {
  let processError;
  try { await stopProcess(child); } catch (error) { processError = error; }
  if (profile && process.platform === "win32") {
    const escaped = profile.replace(/'/gu, "''");
    const command = `$profile = '${escaped}'; Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($profile) } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`;
    spawnSync("powershell.exe", ["-NoProfile", "-Command", command], { stdio: "ignore", windowsHide: true });
  }
  let profileError;
  try { if (profile) await removeDirectory(profile, "Chrome profile"); }
  catch (error) { profileError = error; }
  if (processError) throw processError;
  if (profileError) throw profileError;
}
function processCommandLines() {
  if (process.platform === "win32") {
    const result = spawnSync("powershell.exe", [
      "-NoProfile", "-Command",
      "Get-CimInstance Win32_Process | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress",
    ], { encoding: "utf8", windowsHide: true });
    if (result.status !== 0 || !result.stdout) return [];
    try {
      const entries = JSON.parse(result.stdout);
      return (Array.isArray(entries) ? entries : [entries]).map(entry => `${entry.ProcessId ?? ""} ${entry.CommandLine ?? ""}`);
    } catch { return []; }
  }
  const result = spawnSync("ps", ["-eo", "pid=,args="], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.split(/\r?\n/u).filter(Boolean) : [];
}

async function assertNoSyntheticProcesses() {
  const patterns = [...syntheticProcessPaths].map(value => path.resolve(value).toLowerCase());
  if (!patterns.length) return;
  const deadline = Date.now() + 5_000;
  let matches = [];
  do {
    matches = processCommandLines().filter(line => {
      const normalized = line.toLowerCase();
      return patterns.some(pattern => normalized.includes(pattern));
    });
    if (!matches.length) return;
    await sleep(250);
  } while (Date.now() < deadline);
  throw new Error(`仍有程序指向 smoke 暫存路徑：${truncate(matches.join(" | "), 1_500)}`);
}

function runIndex(root, dataDir) {
  const result = spawnSync(process.execPath, [cli, "index", root], {
    cwd: project,
    encoding: "utf8",
    timeout: 120_000,
    windowsHide: true,
    env: { ...process.env, LOCALDOCSEARCH_DATA_DIR: dataDir, NODE_NO_WARNINGS: "1" },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`CLI index 結束碼 ${result.status ?? "未知"}：${truncate(result.stderr || result.stdout, 1_200)}`);
  }
}

async function fixtureFor(viewport) {
  const temp = await mkdtemp(path.join(outputDir, `fixture-${viewport.width}x${viewport.height}-`));
  try {
  const root = path.join(temp, "synthetic-root 中文😀");
  const dataDir = path.join(temp, "data");
  const codexHome = path.join(temp, "codex-home");
  const codexRollout = path.join(codexHome, "sessions", "2026", "10", "02", "rollout-ui-smoke.jsonl");
  const refreshFolder = path.join(root, "refresh-area");
  const multiPath = path.join(root, "multi-passage-lines.txt");
  const singlePath = path.join(root, "single-passage.txt");
  const phraseSecondPath = path.join(root, "phrase-second.txt");
  const filenameBodyPath = path.join(root, "UI_SMOKE_FILENAME_BODY_NEEDLE.txt");
  const omittedPath = path.join(root, "omitted-terms.txt");
  await mkdir(path.join(root, "excluded"), { recursive: true });
  await mkdir(path.join(refreshFolder, "ignored"), { recursive: true });
  await mkdir(path.dirname(codexRollout), { recursive: true });
  await writeFile(path.join(root, ".localdocsearchignore"), "excluded/\nrefresh-area/ignored/\n");
  await writeFile(path.join(root, "included 中文😀.txt"), "UI_SMOKE_INCLUDED_NEEDLE\n一般合成文件。\n");
  await writeFile(path.join(root, "ordinary.md"), "普通文件，不含測試查詢。\n");
  await writeFile(multiPath, [
    "private first passage",
    "合成 filler line 2。",
    "合成 filler line 3。",
    "合成 filler line 4。",
    "合成 filler line 5。",
    "合成 filler line 6。",
    "合成 filler line 7。",
    "node final passage",
  ].join("\n") + "\n");
  await writeFile(singlePath, "private node together\n");
  await writeFile(phraseSecondPath, [
    "UI_SMOKE_PHRASE_NEEDLE first passage",
    "合成 phrase filler。",
    "UI_SMOKE_PHRASE_NEEDLE second passage",
  ].join("\n") + "\n");
  await writeFile(filenameBodyPath, "UI_SMOKE_FILENAME_BODY_NEEDLE body passage\n");
  await writeFile(omittedPath, "alpha beta gamma delta epsilon\n");
  for (let index = 0; index < 22; index += 1) {
    await writeFile(path.join(root, `page-result-${String(index).padStart(2, "0")}.txt`), `UI_SMOKE_PAGE_TOKEN ${index}\n`);
  }
  await writeFile(path.join(root, "excluded", "secret.txt"), "UI_SMOKE_EXCLUDED_SECRET\n");
  await writeFile(path.join(refreshFolder, "refresh-existing.txt"), "UI_SMOKE_REFRESH_BEFORE\n");
  await writeFile(path.join(refreshFolder, "refresh-removed.txt"), "UI_SMOKE_REFRESH_REMOVED\n");
  await writeFile(path.join(refreshFolder, "ignored", "skip.txt"), "UI_SMOKE_IGNORED\n");
  runIndex(root, dataDir);
  await writeFile(codexRollout, [
    JSON.stringify({ type: "session_meta", payload: { type: "session_meta", session_id: "ui-smoke-session", cwd: root, timestamp: "2026-10-02T10:00:00.000Z" } }),
    JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Please inspect " + multiPath }] } }),
  ].join("\n") + "\n");
  return {
    temp,
    root,
    dataDir,
    codexHome,
    refreshFolder,
    excludedPath: path.join(root, "excluded", "secret.txt"),
    indexedPath: path.join(root, "included 中文😀.txt"),
    multiPath,
    singlePath,
    phraseSecondPath,
    filenameBodyPath,
    omittedPath,
    outsidePath: path.join(temp, "outside-root.txt"),
  };
  } catch (error) {
    await removeDirectory(temp, `fixture ${viewport.width}x${viewport.height}`);
    throw error;
  }
}

async function prepareRefreshFixture(fixture) {
  await writeFile(path.join(fixture.refreshFolder, "refresh-existing.txt"), "UI_SMOKE_REFRESH_AFTER_WITH_UPDATED_CONTENT\n");
  await rm(path.join(fixture.refreshFolder, "refresh-removed.txt"), { force: true });
  await writeFile(path.join(fixture.refreshFolder, "refresh-added.txt"), "UI_SMOKE_REFRESH_ADDED\n");
}
async function prepareIndexingFixture(fixture) {
  for (let index = 0; index < 600; index += 1) {
    await writeFile(path.join(fixture.root, `ui-smoke-indexing-${index}.txt`), `UI_SMOKE_INDEXING_${index}\n`);
  }
}

function syntheticEnvironment(fixture) {
  return {
    ...process.env,
    LOCALDOCSEARCH_DATA_DIR: fixture.dataDir,
    APPDATA: path.join(fixture.temp, "appdata"),
    LOCALAPPDATA: path.join(fixture.temp, "localappdata"),
    NODE_NO_WARNINGS: "1",
  };
}

function startCliAutoupdate(fixture, startupCatchupMode) {
  const args = [cli, "autoupdate", "start"];
  if (startupCatchupMode) args.push("--startup-catchup", startupCatchupMode);
  args.push("--data-dir", fixture.dataDir);
  const result = spawnSync(process.execPath, args, {
    cwd: project,
    encoding: "utf8",
    timeout: 30_000,
    windowsHide: true,
    env: syntheticEnvironment(fixture),
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`CLI autoupdate start 結束碼 ${result.status ?? "未知"}：${truncate(result.stderr || result.stdout, 1_200)}`);
}

function stopCliAutoupdate(fixture) {
  const result = spawnSync(process.execPath, [cli, "autoupdate", "stop", "--data-dir", fixture.dataDir], {
    cwd: project,
    encoding: "utf8",
    timeout: 30_000,
    windowsHide: true,
    env: syntheticEnvironment(fixture),
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !/AUTOUPDATE_NOT_RUNNING|沒有正在執行的自動更新/u.test(result.stderr || result.stdout)) {
    throw new Error(`CLI autoupdate stop 結束碼 ${result.status ?? "未知"}：${truncate(result.stderr || result.stdout, 1_200)}`);
  }
}

function startWorkbench(dataDir, temp, codexHome) {
  const databasePath = path.join(dataDir, "LocalDocSearch", "index.db");
  const workbenchModule = pathToFileURL(path.join(project, "dist", "src", "workbench.js")).href;
  const launcher = `
    import { createWorkbench } from ${JSON.stringify(workbenchModule)};
    const handle = await createWorkbench({
      databasePath: ${JSON.stringify(databasePath)},
      codexHome: ${JSON.stringify(codexHome)},
      tempParent: ${JSON.stringify(temp)},
      searchDelayMs: 1250,
      indexHold: () => new Promise(resolve => setTimeout(resolve, 3000)),
    });
    console.log(handle.url);
    let closing = false;
    const close = async () => {
      if (closing) return;
      closing = true;
      await handle.close();
      process.exit(0);
    };
    process.once("SIGINT", () => { void close(); });
    process.once("SIGTERM", () => { void close(); });
    await new Promise(() => {});
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", launcher], {
    cwd: project,
    env: {
      ...process.env,
      LOCALDOCSEARCH_DATA_DIR: dataDir,
      APPDATA: path.join(temp, "appdata"),
      LOCALAPPDATA: path.join(temp, "localappdata"),
      NODE_NO_WARNINGS: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let output = "";
  const collect = chunk => { output += chunk.toString("utf8"); };
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);
  return { child, getOutput: () => output };
}

async function waitForWorkbench(started) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const match = started.getOutput().match(/(http:\/\/127\.0\.0\.1:\d+\/#\S+)/u);
    if (match) return match[1];
    if (started.child.exitCode !== null) break;
    await sleep(250);
  }
  throw new Error(`工作台未印出網址：${truncate(started.getOutput(), 1_200)}`);
}

async function waitForChromePage(port) {
  const endpoint = `http://127.0.0.1:${port}/json`;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(endpoint);
      const targets = await response.json();
      const page = targets.find(item => item.type === "page" && item.webSocketDebuggerUrl);
      if (page) return page.webSocketDebuggerUrl;
    } catch {
      // Chrome has not opened the DevTools endpoint yet.
    }
    await sleep(250);
  }
  throw new Error(`Chrome DevTools 端點未就緒：${endpoint}`);
}

class CdpClient {
  constructor(wsUrl, viewportLabel) {
    this.wsUrl = wsUrl;
    this.viewportLabel = viewportLabel;
    this.nextId = 0;
    this.pending = new Map();
    this.ws = new WebSocket(wsUrl);
    this.ws.addEventListener("message", event => this.onMessage(event));
    this.ws.addEventListener("error", event => {
      const message = `CDP WebSocket ${viewportLabel} error：${text(event.message || "未知錯誤")}`;
      for (const pending of this.pending.values()) pending.reject(new Error(message));
      this.pending.clear();
    });
  }

  async open() {
    if (this.ws.readyState !== WebSocket.OPEN) {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("CDP WebSocket 開啟逾時。")), 10_000);
        const onOpen = () => { clearTimeout(timer); resolve(); };
        const onError = () => { clearTimeout(timer); reject(new Error("CDP WebSocket 無法開啟。")); };
        this.ws.addEventListener("open", onOpen, { once: true });
        this.ws.addEventListener("error", onError, { once: true });
      });
    }
  }

  onMessage(event) {
    let message;
    try { message = JSON.parse(text(event.data)); } catch { return; }
    if (message.id !== undefined && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(message.error.message || "CDP 命令失敗。"));
      else pending.resolve(message);
      return;
    }
    if (message.method === "Runtime.exceptionThrown") {
      const details = message.params?.exceptionDetails ?? {};
      browserEvents.push({ kind: "exception", failure: true, message: details.exception?.description || details.text || "未提供例外內容" });
    } else if (message.method === "Runtime.consoleAPICalled") {
      const type = message.params?.type || "unknown";
      const messageText = (message.params?.args || []).map(argument => argument.value ?? argument.description ?? "").join(" ");
      browserEvents.push({ kind: `console.${type}`, failure: type === "error", message: messageText });
    } else if (message.method === "Log.entryAdded") {
      const entry = message.params?.entry ?? {};
      const level = entry.level || "unknown";
      browserEvents.push({ kind: `log.${level}`, failure: level === "error", message: `${entry.text || ""} ${entry.url || ""}`.trim() });
    }
  }

  send(method, params = {}) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP 命令逾時：${method}`));
      }, 15_000);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const response = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (response.result?.exceptionDetails) {
      throw new Error(response.result.exceptionDetails.exception?.description || response.result.exceptionDetails.text || "瀏覽器 evaluate 失敗。");
    }
    return response.result?.result?.value;
  }

  close() {
    try { this.ws.close(); } catch { /* already closed */ }
  }
}

async function waitFor(callback, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  let lastError;
  while (Date.now() < deadline) {
    try {
      if (await callback()) return;
    } catch (error) {
      lastError = error;
    }
    await sleep(100);
  }
  throw lastError ?? new Error("等待瀏覽器條件逾時。");
}

function browserFailuresSince(start) {
  return browserEvents.slice(start).filter(event => event.failure);
}

function describeBrowserFailures(start) {
  return browserFailuresSince(start).map(event => `${event.kind}: ${truncate(event.message, 240)}`).join(" | ");
}

async function noBrowserErrorsSince(cdp, start, label) {
  const failures = browserFailuresSince(start);
  if (failures.length) throw new Error(`${label}：${describeBrowserFailures(start)}`);
  const dimensions = await cdp.evaluate("({ width: window.innerWidth, height: window.innerHeight })");
  expect(dimensions?.width >= 1180, `${label}：viewport 寬度不足（${dimensions?.width}）。`);
}
async function noBrowserErrorsExcept(cdp, start, label, allow) {
  const failures = browserFailuresSince(start).filter(event => !allow(event));
  if (failures.length) throw new Error(`${label}：${failures.map(event => `${event.kind}: ${truncate(event.message, 240)}`).join(" | ")}`);
  const dimensions = await cdp.evaluate("({ width: window.innerWidth, height: window.innerHeight })");
  expect(dimensions?.width >= 1180, `${label}：viewport 寬度不足（${dimensions?.width}）。`);
}

async function visible(cdp, selector) {
  return await cdp.evaluate(`(() => { const node = document.querySelector(${JSON.stringify(selector)}); return Boolean(node && !node.hidden && getComputedStyle(node).display !== "none"); })()`);
}

async function click(cdp, selector) {
  const clicked = await cdp.evaluate(`(() => { const node = document.querySelector(${JSON.stringify(selector)}); if (!(node instanceof HTMLElement)) return false; node.click(); return true; })()`);
  expect(clicked, `找不到可點擊元素 ${selector}。`);
}

async function installPickerPatch(cdp) {
  await cdp.evaluate(`(() => {
    const originalFetch = window.fetch.bind(window);
    const smokeClipboard = {
      writeText: async value => { window.__uiSmoke.clipboardText = String(value); },
    };
    window.__uiSmoke = {
      selectRoot: null,
      requests: [],
      documentActions: [],
      libraryActions: [],
      clipboardText: null,
      failNextAutoupdate: false,
      failNextStartupCatchupMode: false,
      failNextWorkbenchOpenMode: false,
      delayNextSettingsMs: 0,
      delayNextCatchupMs: 0,
      delayNextIndexStatusMs: 0,
    };
    try {
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: smokeClipboard });
    } catch {
      try { Object.defineProperty(Navigator.prototype, "clipboard", { configurable: true, get: () => smokeClipboard }); } catch {}
    }
    window.fetch = async (input, init) => {
      const requestUrl = input instanceof Request ? input.url : String(input);
      const requestPath = new URL(requestUrl, location.href).pathname;
      const requestMethod = String(init?.method || (input instanceof Request ? input.method : "GET")).toUpperCase();
      let body = null;
      if (typeof init?.body === "string") {
        try { body = JSON.parse(init.body); } catch { body = null; }
      }
      window.__uiSmoke.requests.push({ path: requestPath, method: requestMethod, body });
      if (requestPath === "/api/select-folder") {
        return new Response(JSON.stringify({ root: window.__uiSmoke.selectRoot }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (requestPath === "/api/document-action") {
        let body = null;
        try { body = JSON.parse(String(init?.body || "")); } catch {}
        window.__uiSmoke.documentActions.push(body);
        return new Response(JSON.stringify({ changed: false }), { status: 200, headers: { "content-type": "application/json" } });
      }
      const libraryPathParts = requestPath.split("/");
      const isLibraryGroupItems = libraryPathParts.length === 6
        && libraryPathParts[1] === "api" && libraryPathParts[2] === "library"
        && libraryPathParts[3] === "groups" && libraryPathParts[4] && libraryPathParts[5] === "items";
      if ((requestPath === "/api/library/pinned" && (requestMethod === "PUT" || requestMethod === "DELETE"))
        || (isLibraryGroupItems && requestMethod === "POST")) {
        window.__uiSmoke.libraryActions.push({ path: requestPath, method: requestMethod, body });
      }
      if (requestPath === "/api/settings" && body?.startupCatchupMode !== undefined && window.__uiSmoke.failNextStartupCatchupMode) {
        window.__uiSmoke.failNextStartupCatchupMode = false;
        const response = new Response(JSON.stringify({ error: "煙霧測試模擬開機補捉策略保存失敗。" }), { status: 503, headers: { "content-type": "application/json" } });
        const delay = Number(window.__uiSmoke.delayNextSettingsMs) || 0;
        window.__uiSmoke.delayNextSettingsMs = 0;
        return delay ? await new Promise(resolve => setTimeout(() => resolve(response), delay)) : response;
      }
      if (requestPath === "/api/settings" && body?.workbenchOpenMode !== undefined && window.__uiSmoke.failNextWorkbenchOpenMode) {
        window.__uiSmoke.failNextWorkbenchOpenMode = false;
        const response = new Response(JSON.stringify({ error: "煙霧測試模擬工作台開啟策略保存失敗。" }), { status: 503, headers: { "content-type": "application/json" } });
        const delay = Number(window.__uiSmoke.delayNextSettingsMs) || 0;
        window.__uiSmoke.delayNextSettingsMs = 0;
        return delay ? await new Promise(resolve => setTimeout(() => resolve(response), delay)) : response;
      }
      if (requestPath === "/api/autoupdate/catchup" && Number(window.__uiSmoke.delayNextCatchupMs) > 0) {
        const delay = Number(window.__uiSmoke.delayNextCatchupMs);
        window.__uiSmoke.delayNextCatchupMs = 0;
        const response = await originalFetch(input, init);
        return await new Promise(resolve => setTimeout(() => resolve(response), delay));
      }
      if (requestPath === "/api/settings" && body?.autoupdateEnabled !== undefined && window.__uiSmoke.failNextAutoupdate) {
        window.__uiSmoke.failNextAutoupdate = false;
        const response = new Response(JSON.stringify({ error: "煙霧測試模擬設定失敗。" }), { status: 503, headers: { "content-type": "application/json" } });
        const delay = Number(window.__uiSmoke.delayNextSettingsMs) || 0;
        window.__uiSmoke.delayNextSettingsMs = 0;
        return delay ? await new Promise(resolve => setTimeout(() => resolve(response), delay)) : response;
      }
      return originalFetch(input, init);
    };
    return true;
  })()`);
}

async function reloadWorkbench(cdp) {
  await cdp.send("Page.reload", { ignoreCache: true });
  await waitFor(() => cdp.evaluate("document.readyState === 'complete' && Boolean(document.getElementById('settings-toggle'))"), 30_000);
  await installPickerPatch(cdp);
}
async function settingSnapshot(cdp) {
  return await cdp.evaluate(`(() => {
    const read = id => {
      const node = document.getElementById(id);
      return node ? {
        role: node.getAttribute("role"),
        ariaChecked: node.getAttribute("aria-checked"),
        disabled: Boolean(node.disabled),
        state: document.getElementById(id + "-state")?.textContent?.trim() || "",
      } : null;
    };
    return {
      auto: read("settings-autoupdate"),
      startup: read("settings-autoupdate-startup"),
      mode: {
        value: document.getElementById("settings-startup-catchup-mode")?.value || "",
        disabled: Boolean(document.getElementById("settings-startup-catchup-mode")?.disabled),
        status: document.getElementById("startup-catchup-mode-status")?.textContent?.trim() || "",
      },
      openMode: {
        value: document.getElementById("settings-workbench-open-mode")?.value || "",
        disabled: Boolean(document.getElementById("settings-workbench-open-mode")?.disabled),
        status: document.getElementById("workbench-open-mode-status")?.textContent?.trim() || "",
      },
      catchup: {
        hidden: Boolean(document.getElementById("startup-catchup-banner")?.hidden),
        status: document.getElementById("startup-catchup-status")?.textContent?.trim() || "",
        actionsDisabled: Array.from(document.querySelectorAll("#startup-catchup-banner button")).every(node => node.disabled),
      },
      open: {
        hidden: Boolean(document.getElementById("workbench-open-banner")?.hidden),
        title: document.getElementById("workbench-open-title")?.textContent?.trim() || "",
        message: document.getElementById("workbench-open-message")?.textContent?.trim() || "",
        warning: document.getElementById("workbench-open-warning")?.textContent?.trim() || "",
        status: document.getElementById("workbench-open-status")?.textContent?.trim() || "",
        actionsDisabled: Array.from(document.querySelectorAll("#workbench-open-banner button")).every(node => node.disabled),
      },
      status: document.getElementById("settings-status")?.textContent?.trim() || "",
    };
  })()`);
}

async function indexStatus(cdp) {
  return await cdp.evaluate(`(async () => {
    const token = decodeURIComponent(location.hash.slice(1));
    const response = await fetch("/api/index-status", { headers: { "X-LocalDocSearch-Token": token } });
    return await response.json();
  })()`);
}
async function settingsPost(cdp, body) {
  return await cdp.evaluate(`(async () => {
    const token = decodeURIComponent(location.hash.slice(1));
    const response = await fetch("/api/settings", {
      method: "POST",
      headers: { "X-LocalDocSearch-Token": token, "content-type": "application/json" },
      body: ${JSON.stringify(JSON.stringify(body))},
    });
    return { status: response.status, data: await response.json() };
  })()`);
}

async function pressKey(cdp, key, code, virtualKeyCode, textValue) {
  await cdp.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key,
    code,
    text: textValue,
    unmodifiedText: textValue,
    windowsVirtualKeyCode: virtualKeyCode,
    nativeVirtualKeyCode: virtualKeyCode,
  });
  await cdp.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key,
    code,
    windowsVirtualKeyCode: virtualKeyCode,
    nativeVirtualKeyCode: virtualKeyCode,
  });
}

async function setPickerRoot(cdp, root) {
  await cdp.evaluate(`(() => {
    window.__uiSmoke.selectRoot = ${JSON.stringify(root)};
    window.__uiSmoke.requests = [];
    window.__uiSmoke.documentActions = [];
    window.__uiSmoke.clipboardText = null;
    return true;
  })()`);
}


async function inputAndSearch(cdp, query) {
  await cdp.evaluate(`(() => {
    const input = document.getElementById("document-query");
    if (!(input instanceof HTMLInputElement)) return false;
    input.value = ${JSON.stringify(query)};
    input.dispatchEvent(new Event("input", { bubbles: true }));
    document.getElementById("document-search-button")?.click();
    return true;
  })()`);
}

async function setSearchMode(cdp, mode) {
  const activeModeId = mode === "all-terms" ? "mode-phrase" : "mode-all-terms";
  const expectedModeId = mode === "all-terms" ? "mode-all-terms" : "mode-phrase";
  const clicked = await cdp.evaluate(`(() => {
    const active = document.getElementById(${JSON.stringify(activeModeId)});
    if (!(active instanceof HTMLElement)) return false;
    if (active.getAttribute("aria-pressed") === "true") active.click();
    return true;
  })()`);
  expect(clicked, `找不到搜尋模式按鈕 ${activeModeId}。`);
  await waitFor(() => cdp.evaluate(`document.getElementById(${JSON.stringify(expectedModeId)})?.getAttribute("aria-pressed") === "true"`));
}
async function searchDirectly(cdp, query, mode, page = 1) {
  return await cdp.evaluate(`(async () => {
    const token = decodeURIComponent(location.hash.slice(1));
    const response = await fetch("/api/search", {
      method: "POST",
      headers: { "X-LocalDocSearch-Token": token, "content-type": "application/json" },
      body: JSON.stringify({ query: ${JSON.stringify(query)}, mode: ${JSON.stringify(mode)}, page: ${page}, pageSize: 20, field: "all" }),
    });
    return { status: response.status, data: await response.json() };
  })()`);
}

async function inputAndExplain(cdp, filePath) {
  await cdp.evaluate(`(() => {
    const input = document.getElementById("search-empty-explain-path");
    if (!(input instanceof HTMLInputElement)) return false;
    input.value = ${JSON.stringify(filePath)};
    input.dispatchEvent(new Event("input", { bubbles: true }));
    const form = document.getElementById("search-empty-explain-form");
    if (!(form instanceof HTMLFormElement)) return false;
    form.requestSubmit();
    return true;
  })()`);
}

async function explainDirectly(cdp, filePath) {
  return await cdp.evaluate(`(async () => {
    const token = decodeURIComponent(location.hash.slice(1));
    const response = await fetch("/api/explain", {
      method: "POST",
      headers: { "X-LocalDocSearch-Token": token, "content-type": "application/json" },
      body: JSON.stringify({ path: ${JSON.stringify(filePath)} }),
    });
    return { status: response.status, data: await response.json() };
  })()`);
}


async function runViewport(viewport, chromePath) {
  const label = `${viewport.width}x${viewport.height}`;
  let fixture;
  let workbench;
  let chrome;
  let chromeProfile;
  let cdp;
  let port;
  try {
    fixture = await fixtureFor(viewport);
    syntheticProcessPaths.add(fixture.temp);
    syntheticProcessPaths.add(fixture.dataDir);
    workbench = startWorkbench(fixture.dataDir, fixture.temp, fixture.codexHome);
    const url = await waitForWorkbench(workbench);
    port = await unusedPort();
    chromeProfile = await mkdtemp(path.join(outputDir, `chrome-${label}-`));
    syntheticProcessPaths.add(chromeProfile);
    chrome = spawn(chromePath, [
      "--headless=new",
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${chromeProfile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      `--window-size=${viewport.width},${viewport.height}`,
      "about:blank",
    ], { cwd: project, stdio: "ignore", windowsHide: true });
    const wsUrl = await waitForChromePage(port);
    cdp = new CdpClient(wsUrl, label);
    await cdp.open();
    await cdp.send("Runtime.enable");
    await cdp.send("Log.enable");
    await cdp.send("Page.enable");
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: viewport.width, height: viewport.height, deviceScaleFactor: 1, mobile: false });
    const navigationStart = browserEvents.length;
    await cdp.send("Page.navigate", { url });

    await check(`${label} 載入後 12 秒內無 exception／console.error，側邊欄離開讀取中`, async () => {
      await sleep(12_000);
      const snapshot = await cdp.evaluate(`(() => ({
        sidebarStatus: document.getElementById("sidebar-status")?.textContent?.trim() || "",
        documentsVisible: !document.getElementById("documents-page")?.hidden,
        indexMessage: document.getElementById("index-status-message")?.textContent?.trim() || "",
      }))()`);
      expect(snapshot?.documentsVisible, "文件頁沒有顯示。");
      expect(snapshot?.sidebarStatus && snapshot.sidebarStatus !== "讀取中…", `側邊欄仍顯示「${snapshot?.sidebarStatus}」。`);
      await noBrowserErrorsSince(cdp, navigationStart, "初始載入發現瀏覽器錯誤");
    });

    await check(`${label} 文件頁可開啟且無 exception`, async () => {
      const start = browserEvents.length;
      await click(cdp, "#nav-documents");
      await waitFor(() => visible(cdp, "#documents-page"));
      await noBrowserErrorsSince(cdp, start, "文件頁");
    });

    await check(`${label} 文件庫四個導覽頁可載入並完成釘選／分類／已存搜尋重新執行`, async () => {
      const start = browserEvents.length;
      const indexedPathLiteral = JSON.stringify(fixture.indexedPath);
      const waitLibrary = async (step, callback) => {
        try { await waitFor(callback); } catch (error) { throw new Error(step + "：" + errorText(error)); }
      };
      await click(cdp, "#nav-documents");
      await waitLibrary("文件頁顯示", () => visible(cdp, "#documents-page"));
      await inputAndSearch(cdp, "UI_SMOKE_INCLUDED_NEEDLE");
      await waitLibrary("搜尋結果顯示", () => cdp.evaluate("document.querySelector('#document-list .document-row .document-actions button') !== null"));
      const selected = await cdp.evaluate(`(() => {
        const action = Array.from(document.querySelectorAll("#document-list .document-row .document-actions button"))
          .find(node => node.textContent?.trim() === "加入上下文");
        if (!(action instanceof HTMLElement)) return false;
        action.click();
        return true;
      })()`);
      expect(selected, "搜尋結果沒有可選取文件。");
      await waitLibrary("最近數量更新", () => cdp.evaluate("document.getElementById('nav-library-recent-count')?.textContent === '1'"));
      await click(cdp, "#nav-library-recent");
      await waitLibrary("最近頁顯示", () => visible(cdp, "#library-recent-page"));
      await waitLibrary("最近文件路徑", () => cdp.evaluate("(document.getElementById('library-recent-list')?.textContent || '').includes(" + indexedPathLiteral + ")"));
      const pinned = await cdp.evaluate(`(() => {
        const row = document.querySelector("#library-recent-list .library-item");
        const action = row && Array.from(row.querySelectorAll("button")).find(node => node.textContent?.trim() === "釘選");
        if (!(action instanceof HTMLElement)) return false;
        action.click();
        return true;
      })()`);
      expect(pinned, "最近文件列沒有釘選操作。");
      await waitLibrary("釘選數量更新", () => cdp.evaluate("document.getElementById('nav-library-pinned-count')?.textContent === '1'"));
      await click(cdp, "#nav-library-pinned");
      await waitLibrary("釘選頁顯示", () => visible(cdp, "#library-pinned-page"));
      await waitLibrary("釘選文件路徑", () => cdp.evaluate("(document.getElementById('library-pinned-list')?.textContent || '').includes(" + indexedPathLiteral + ")"));
      await click(cdp, "#nav-library-groups");
      await waitLibrary("分類頁顯示", () => visible(cdp, "#library-groups-page"));
      const created = await cdp.evaluate(`(() => {
        const input = document.getElementById("library-group-name");
        if (!(input instanceof HTMLInputElement)) return false;
        input.value = "UI Smoke 分類";
        document.getElementById("library-create-group")?.click();
        return true;
      })()`);
      expect(created, "分類頁沒有建立操作。");
      await waitLibrary("分類數量更新", () => cdp.evaluate("document.getElementById('nav-library-groups-count')?.textContent === '1'"));
      await click(cdp, "#nav-library-recent");
      await waitLibrary("分類加入清單頁", () => visible(cdp, "#library-recent-page"));
      await waitLibrary("分類選項顯示", () => cdp.evaluate("document.querySelector('#library-recent-list select option:nth-child(2)') !== null"));
      const grouped = await cdp.evaluate(`(() => {
        const row = document.querySelector("#library-recent-list .library-item");
        const select = row?.querySelector("select");
        const action = row && Array.from(row.querySelectorAll("button")).find(node => node.textContent?.trim() === "加入");
        if (!(select instanceof HTMLSelectElement) || !(action instanceof HTMLElement)) return false;
        select.value = select.options[1]?.value || "";
        action.click();
        return Boolean(select.value);
      })()`);
      expect(grouped, "最近文件列沒有加入分類操作。");
      await click(cdp, "#nav-library-groups");
      await waitLibrary("分類文件路徑", () => visible(cdp, "#library-groups-page"));
      await waitLibrary("分類文件路徑內容", () => cdp.evaluate("(document.getElementById('library-groups-list')?.textContent || '').includes(" + indexedPathLiteral + ")"));
      await click(cdp, "#nav-documents");
      await waitLibrary("重新搜尋文件頁", () => visible(cdp, "#documents-page"));
      await waitLibrary("保存前結果", () => cdp.evaluate("document.querySelector('#document-list .document-row') !== null"));
      await click(cdp, "#nav-library-saved-searches");
      await waitLibrary("已存搜尋頁顯示", () => visible(cdp, "#library-saved-searches-page"));
      const saved = await cdp.evaluate(`(() => {
        const input = document.getElementById("library-saved-search-name");
        if (!(input instanceof HTMLInputElement)) return false;
        input.value = "UI Smoke 搜尋";
        document.getElementById("library-save-search")?.click();
        return true;
      })()`);
      expect(saved, "已存搜尋頁沒有儲存操作。");
      await waitLibrary("已存搜尋清單", () => cdp.evaluate("document.querySelector('#library-saved-searches-list .library-item') !== null"));
      const rerun = await cdp.evaluate(`(() => {
        const row = document.querySelector("#library-saved-searches-list .library-item");
        const action = row && Array.from(row.querySelectorAll("button")).find(node => node.textContent?.trim() === "重新搜尋");
        if (!(action instanceof HTMLElement)) return false;
        action.click();
        return true;
      })()`);
      expect(rerun, "已存搜尋列沒有重新搜尋操作。");
      await waitLibrary("已存搜尋重新執行結果", () => cdp.evaluate("!document.getElementById('documents-page')?.hidden && document.querySelector('#document-list .document-row') !== null"));
      await noBrowserErrorsSince(cdp, start, "文件庫導覽與操作");
    });
    await check(`${label} Codex reference 可加入上下文並跨頁／reload 保留`, async () => {
      const start = browserEvents.length;
      await click(cdp, "#codex-session-toggle");
      await waitFor(async () => {
        const snapshot = await cdp.evaluate(`(() => ({
          pathname: location.pathname,
          sessionRows: document.querySelectorAll("#session-list .session-row").length,
          detailButtons: document.querySelectorAll("#session-detail button[data-action='context']").length,
          body: document.body?.textContent?.slice(0, 500) || "",
        }))()`);
        if (snapshot.pathname === "/codex-sessions" && snapshot.sessionRows > 0) return true;
        throw new Error("Codex 頁面狀態：" + JSON.stringify(snapshot));
      });
      await waitFor(() => cdp.evaluate("document.querySelector('#session-detail button[data-action=\"context\"]') !== null"));
      const added = await cdp.evaluate(`(() => {
        const button = document.querySelector('#session-detail button[data-action="context"]');
        if (!(button instanceof HTMLElement) || button.textContent?.trim() !== "加入上下文") return false;
        button.click();
        return true;
      })()`);
      expect(added, "Codex 已索引 reference 沒有加入上下文按鈕。");
      await waitFor(() => cdp.evaluate("document.querySelector('#session-detail button[data-action=\"context\"]')?.textContent?.trim() === '移出上下文'"));
      await click(cdp, "#back");
      await waitFor(() => cdp.evaluate("location.pathname === '/' && Boolean(document.getElementById('documents-page'))"));
      await waitFor(() => cdp.evaluate("document.getElementById('nav-context-count')?.textContent === '2'"));
      const shared = await cdp.evaluate(`(() => ({
        count: document.getElementById("nav-context-count")?.textContent || "",
        panel: document.getElementById("context-indexed-list")?.textContent || "",
      }))()`);
      expect(shared.count === "2" && shared.panel.includes("multi-passage-lines.txt") && shared.panel.includes(fixture.multiPath), "Codex 選取沒有同步到工作台上下文側欄。");
      await reloadWorkbench(cdp);
      await waitFor(() => cdp.evaluate("document.getElementById('nav-context-count')?.textContent === '2'"));
      const removed = await cdp.evaluate(`(() => {
        const row = Array.from(document.querySelectorAll("#context-indexed-list .context-item")).find(node => node.textContent?.includes("multi-passage-lines.txt"));
        const button = row?.querySelector(".result-action");
        if (!(button instanceof HTMLElement)) return false;
        button.click();
        return true;
      })()`);
      expect(removed, "工作台側欄沒有移除 Codex 選取的文件。");
      await waitFor(() => cdp.evaluate("document.getElementById('nav-context-count')?.textContent === '1'"));
      await reloadWorkbench(cdp);
      await waitFor(() => cdp.evaluate("document.getElementById('nav-context-count')?.textContent === '1'"));
      await click(cdp, "#context-clear-selection");
      await waitFor(() => cdp.evaluate("document.getElementById('nav-context-count')?.textContent === '0'"));
      await noBrowserErrorsSince(cdp, start, "Codex reference 跨頁上下文");
    });

    await check(`${label} 臨時文件頁可開啟且無 exception`, async () => {
      const start = browserEvents.length;
      await click(cdp, "#nav-temporary");
      await waitFor(() => visible(cdp, "#temporary-page"));
      await noBrowserErrorsSince(cdp, start, "臨時文件頁");
    });

    await check(`${label} 根目錄頁可開啟、每個預設排除細節可展開且有規則／略過數`, async () => {
      const start = browserEvents.length;
      await click(cdp, "#nav-roots");
      await waitFor(() => visible(cdp, "#roots-page"));
      await waitFor(() => cdp.evaluate("document.querySelectorAll('#roots-body .root-exclusion-details').length > 0"));
      const details = await cdp.evaluate(`(() => Array.from(document.querySelectorAll("#roots-body .root-exclusion-details")).map(node => {
        node.open = true;
        return {
          open: node.open,
          rules: node.querySelectorAll(".exclusion-rule").length,
          text: node.textContent || "",
        };
      }))()`);
      expect(Array.isArray(details) && details.length > 0, "根目錄沒有排除細節。");
      for (const item of details) {
        expect(item.open, "排除 details 無法展開。");
        expect(item.rules > 0, "排除細節沒有規則。");
        expect(/逐規則最近略過：[^。]*\d/u.test(item.text), "排除細節沒有逐規則略過數。");
      }
      await noBrowserErrorsSince(cdp, start, "根目錄頁");
    });

    await check(`${label} 垃圾桶頁可開啟且無 exception`, async () => {
      const start = browserEvents.length;
      await click(cdp, "#nav-trash");
      await waitFor(() => visible(cdp, "#trash-page"));
      await noBrowserErrorsSince(cdp, start, "垃圾桶頁");
    });

    await installPickerPatch(cdp);
    await check(`${label} 設定頁 Toggle Switch 可鍵盤操作、狀態與 API 一致且失敗會回復`, async () => {
      const start = browserEvents.length;
      await cdp.evaluate("window.__uiSmoke.delayNextIndexStatusMs = 2500");
      await click(cdp, "#settings-toggle");
      await waitFor(() => cdp.evaluate("document.getElementById('settings-dialog')?.open === true"));
      const settings = await cdp.evaluate(`(() => ({
        policyHeading: document.getElementById("settings-exclusion-policy")?.textContent || "",
        policyCount: document.querySelectorAll("#settings-exclusion-policy-list .settings-exclusion-root").length,
      }))()`);
      expect(settings.policyHeading.includes("哪些位置預設不索引"), "設定頁沒有排除政策標題。");
      expect(settings.policyCount > 0, "設定頁沒有政策清單。");
      let snapshot = await settingSnapshot(cdp);
      expect(snapshot.auto?.role === "switch" && snapshot.startup?.role === "switch", "背景更新開關不是 role=switch。");
      expect(snapshot.auto?.ariaChecked === "false" && snapshot.startup?.ariaChecked === "false", "初始 aria-checked 不正確。");
      expect(snapshot.auto?.state === "已關閉" && snapshot.startup?.state === "已關閉", "初始狀態文字不正確。");
      await cdp.evaluate("document.getElementById('settings-autoupdate')?.focus()");
      await pressKey(cdp, " ", "Space", 32, " ");
      await waitFor(async () => {
        const current = await settingSnapshot(cdp);
        return current.auto?.ariaChecked === "true" && current.auto?.state === "已開啟" && !current.auto?.disabled;
      });
      let apiState = await indexStatus(cdp);
      expect(apiState?.autoupdate?.enabled === true, "鍵盤開啟後 API autoupdate 沒有 enabled=true。");
      await sleep(2_700);
      snapshot = await settingSnapshot(cdp);
      expect(snapshot.auto?.ariaChecked === "true" && snapshot.auto?.state === "已開啟", "慢速 index-status 回應覆寫了 POST 成功狀態。");
      await click(cdp, "#settings-autoupdate");
      await waitFor(async () => {
        const current = await settingSnapshot(cdp);
        return current.auto?.ariaChecked === "false" && current.auto?.state === "已關閉" && !current.auto?.disabled;
      });
      apiState = await indexStatus(cdp);
      expect(apiState?.autoupdate?.enabled === false, "點擊關閉後 API autoupdate 沒有 enabled=false。");
      await click(cdp, "#settings-autoupdate");
      await waitFor(async () => (await settingSnapshot(cdp)).auto?.ariaChecked === "true");
      apiState = await indexStatus(cdp);
      expect(apiState?.autoupdate?.enabled === true, "再次開啟後 API autoupdate 沒有 enabled=true。");
      await cdp.evaluate("window.__uiSmoke.failNextAutoupdate = true; window.__uiSmoke.delayNextSettingsMs = 250;");
      await click(cdp, "#settings-autoupdate");
      await sleep(50);
      snapshot = await settingSnapshot(cdp);
      expect(snapshot.auto?.disabled && snapshot.auto?.state === "處理中…", "設定處理期間開關沒有 disabled／處理中狀態。");
      await waitFor(async () => {
        const current = await settingSnapshot(cdp);
        return !current.auto?.disabled && current.auto?.ariaChecked === "true" && current.auto?.state === "已開啟";
      });
      snapshot = await settingSnapshot(cdp);
      expect(snapshot.status.includes("煙霧測試模擬設定失敗"), "設定失敗沒有顯示明確錯誤。");
      apiState = await indexStatus(cdp);
      expect(apiState?.autoupdate?.enabled === true, "設定失敗後 API autoupdate 不應改變。");
      await click(cdp, "#settings-autoupdate");
      await waitFor(async () => (await settingSnapshot(cdp)).auto?.ariaChecked === "false");
      apiState = await indexStatus(cdp);
      expect(apiState?.autoupdate?.enabled === false, "清理背景 daemon 後 API autoupdate 沒有 disabled。");
      if (!snapshot.startup?.disabled) {
        await click(cdp, "#settings-autoupdate-startup");
        await waitFor(async () => (await settingSnapshot(cdp)).startup?.ariaChecked === "true");
        apiState = await indexStatus(cdp);
        expect(apiState?.autoupdate?.enabled === false, "登入啟動開啟不應啟動背景 daemon。");
        expect(apiState?.autoupdateStartup?.enabled === true, "登入啟動開啟後 API 狀態不一致。");
        await click(cdp, "#settings-autoupdate-startup");
        await waitFor(async () => (await settingSnapshot(cdp)).startup?.ariaChecked === "false");
        apiState = await indexStatus(cdp);
        expect(apiState?.autoupdateStartup?.enabled === false, "登入啟動關閉後 API 狀態不一致。");
      }
      await noBrowserErrorsSince(cdp, start, "設定 Toggle Switch");
      await cdp.evaluate("document.getElementById('settings-dialog')?.close()");
    });

    await installPickerPatch(cdp);
    await check(`${label} 主題按鈕循環、URL 保存與 token fragment 保留`, async () => {
      const start = browserEvents.length;
      const sequence = await cdp.evaluate(`(() => {
        const button = document.getElementById("theme-button");
        if (!(button instanceof HTMLElement)) return null;
        const read = () => ({
          mode: document.documentElement.dataset.theme || "",
          search: location.search,
          hash: location.hash,
          canvas: getComputedStyle(document.documentElement).getPropertyValue("--canvas").trim(),
          label: button.textContent || "",
        });
        const values = [read()];
        button.click(); values.push(read());
        button.click(); values.push(read());
        button.click(); values.push(read());
        return values;
      })()`);
      expect(sequence?.length === 4, "主題按鈕不存在或無法循環。");
      expect(sequence[0].mode === "auto" && sequence[1].mode === "light" && sequence[2].mode === "dark" && sequence[3].mode === "auto", "主題循環順序不是自動／淺色／深色。");
      expect(sequence[1].search === "?theme=light" && sequence[2].search === "?theme=dark" && sequence[3].search === "", "主題 query 保存／清除不符。");
      expect(sequence.every(item => item.hash === sequence[0].hash), "主題切換改寫了 token fragment。");
      expect(sequence[1].canvas !== sequence[2].canvas, "淺色／深色沒有套用不同 CSS token。");
      await cdp.evaluate(`(() => {
        const button = document.getElementById("theme-button");
        button?.click();
        button?.click();
        return true;
      })()`);
      const explicit = await cdp.evaluate("({ mode: document.documentElement.dataset.theme, search: location.search, hash: location.hash })");
      expect(explicit.mode === "dark" && explicit.search === "?theme=dark", "深色主題保存失敗。");
      await reloadWorkbench(cdp);
      const persisted = await cdp.evaluate("({ mode: document.documentElement.dataset.theme, search: location.search, hash: location.hash })");
      expect(persisted.mode === "dark" && persisted.search === "?theme=dark" && persisted.hash === sequence[0].hash, "重新載入沒有保留深色主題或 token。");
      await click(cdp, "#theme-button");
      expect(await cdp.evaluate("document.documentElement.dataset.theme === 'auto' && location.search === ''"), "清除主題後沒有回到 auto。");
      await noBrowserErrorsSince(cdp, start, "主題切換");
    });
    await check(`${label} 搜尋有結果`, async () => {
      const start = browserEvents.length;
      await click(cdp, "#nav-documents");
      await waitFor(() => visible(cdp, "#documents-page"));
      await inputAndSearch(cdp, "UI_SMOKE_INCLUDED_NEEDLE");
      await waitFor(() => cdp.evaluate("document.querySelectorAll('#document-list .document-row').length > 0 && !document.getElementById('search-status')?.textContent?.includes('搜尋中')"));
      const result = await cdp.evaluate("document.querySelectorAll('#document-list .document-row').length");
      expect(result > 0, "搜尋結果列為空。");
      await noBrowserErrorsSince(cdp, start, "有結果搜尋");
    });
    await check(`${label} 慢速搜尋顯示取消並保留上一筆結果與輸入`, async () => {
      const start = browserEvents.length;
      const previous = await cdp.evaluate(`(() => ({
        query: document.getElementById("document-query")?.value || "",
        rows: document.querySelectorAll("#document-list .document-row").length,
      }))()`);
      await inputAndSearch(cdp, "UI_SMOKE_PAGE_TOKEN");
      try {
        await waitFor(() => visible(cdp, "#search-cancel-button"), 10_000);
      } catch (error) {
        const snapshot = await cdp.evaluate(`(() => ({
          status: document.getElementById("search-status")?.textContent?.trim() || "",
          query: document.getElementById("document-query")?.value || "",
          rows: document.querySelectorAll("#document-list .document-row").length,
          cancelHidden: Boolean(document.getElementById("search-cancel-button")?.hidden),
        }))()`);
        throw new Error(`取消按鈕等待失敗：${JSON.stringify(snapshot)}；${errorText(error)}`);
      }
      expect(await visible(cdp, "#search-cancel-button"), "搜尋超過一秒後仍沒有顯示取消按鈕。");
      const waitingStatus = await cdp.evaluate("document.getElementById('search-status')?.textContent?.trim() || ''");
      expect(/已等待 \d+ 秒/u.test(waitingStatus), `搜尋等待秒數未顯示：${waitingStatus}`);
      await click(cdp, "#search-cancel-button");
      try {
        await waitFor(async () => {
          const current = await cdp.evaluate(`(() => ({
            status: document.getElementById("search-status")?.textContent?.trim() || "",
            query: document.getElementById("document-query")?.value || "",
            rows: document.querySelectorAll("#document-list .document-row").length,
            cancelHidden: Boolean(document.getElementById("search-cancel-button")?.hidden),
          }))()`);
          return current.status === "搜尋已取消" && current.query === previous.query && current.rows === previous.rows && current.cancelHidden;
        });
      } catch (error) {
        const snapshot = await cdp.evaluate(`(() => ({
          status: document.getElementById("search-status")?.textContent?.trim() || "",
          query: document.getElementById("document-query")?.value || "",
          rows: document.querySelectorAll("#document-list .document-row").length,
          cancelHidden: Boolean(document.getElementById("search-cancel-button")?.hidden),
        }))()`);
        throw new Error(`取消後狀態等待失敗：${JSON.stringify({ previous, snapshot })}；${errorText(error)}`);
      }
      await noBrowserErrorsSince(cdp, start, "慢速搜尋取消");
    });
    await check(`${label} 搜尋結果可選取、複製且選取時不開啟`, async () => {
      const start = browserEvents.length;
      await inputAndSearch(cdp, "UI_SMOKE_INCLUDED_NEEDLE");
      await waitFor(() => cdp.evaluate("document.querySelectorAll('#document-list .document-row').length > 0 && !document.getElementById('search-status')?.textContent?.includes('搜尋中')"));
      const selection = await cdp.evaluate(`(() => {
        const title = document.querySelector("#document-list .document-title");
        if (!(title instanceof HTMLElement)) return null;
        const active = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(title);
        active?.removeAllRanges();
        active?.addRange(range);
        const selectedTitle = active?.toString() || "";
        const before = window.__uiSmoke.documentActions.length;
        title.click();
        const guarded = window.__uiSmoke.documentActions.length === before;
        active?.removeAllRanges();
        return { selectedTitle, filename: title.textContent || "", guarded };
      })()`);
      expect(selection?.selectedTitle === selection?.filename, "檔名 Selection API 文字不等於可見檔名。");
      expect(selection?.guarded, "選取檔名後點擊仍送出 open。");
      await cdp.evaluate(`(() => {
        const title = document.querySelector("#document-list .document-title");
        title?.click();
        return true;
      })()`);
      await waitFor(() => cdp.evaluate("window.__uiSmoke.documentActions.some(item => item?.action === 'open')"));

      const pathButtonClicked = await cdp.evaluate(`(() => {
        window.__uiSmoke.clipboardText = null;
        const button = Array.from(document.querySelectorAll("#document-list .copy-action button")).find(node => node.textContent === "複製路徑");
        if (!(button instanceof HTMLElement)) return false;
        button.click();
        return true;
      })()`);
      expect(pathButtonClicked, "找不到複製路徑按鈕。");
      await waitFor(() => cdp.evaluate("window.__uiSmoke.clipboardText !== null"));
      const pathCopy = await cdp.evaluate(`(() => {
        const row = document.querySelector("#document-list .document-row");
        return {
          path: row?.querySelector(".document-path")?.title || "",
          filename: row?.querySelector(".document-title")?.textContent || "",
          copied: window.__uiSmoke.clipboardText,
        };
      })()`);
      expect(pathCopy.copied === pathCopy.path, `複製路徑不等於完整路徑：${pathCopy.copied}`);
      expect(/[\\u4e00-\\u9fff]/u.test(pathCopy.copied) && pathCopy.copied.includes(" ") && pathCopy.copied.includes("😀"), "合成複製路徑未涵蓋中文、空白與 emoji。");

      const filenameButtonClicked = await cdp.evaluate(`(() => {
        window.__uiSmoke.clipboardText = null;
        const button = Array.from(document.querySelectorAll("#document-list .copy-action button")).find(node => node.textContent === "複製檔名");
        if (!(button instanceof HTMLElement)) return false;
        button.click();
        return true;
      })()`);
      expect(filenameButtonClicked, "找不到複製檔名按鈕。");
      await waitFor(() => cdp.evaluate("window.__uiSmoke.clipboardText !== null"));
      const filenameCopy = await cdp.evaluate(`(() => ({
        filename: document.querySelector("#document-list .document-title")?.textContent || "",
        copied: window.__uiSmoke.clipboardText,
      }))()`);
      expect(filenameCopy.copied === filenameCopy.filename, "複製檔名不等於原始檔名。");
      expect(/[\\u4e00-\\u9fff]/u.test(filenameCopy.copied) && filenameCopy.copied.includes("😀"), "合成複製檔名未涵蓋中文與 emoji。");

      const snippetSelection = await cdp.evaluate(`(() => {
        const snippet = document.querySelector("#document-list .snippet");
        if (!(snippet instanceof HTMLElement)) return null;
        const active = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(snippet);
        active?.removeAllRanges();
        active?.addRange(range);
        const selected = active?.toString() || "";
        active?.removeAllRanges();
        return { selected, text: snippet.textContent || "" };
      })()`);
      expect(snippetSelection?.selected === snippetSelection?.text, "高亮片段選取文字被 mark 或控制項改寫。");
      await noBrowserErrorsSince(cdp, start, "結果選取與複製");
    });

    await check(`${label} all-terms 多段落在列表／表格可讀、可高亮且可精確選取`, async () => {
      const start = browserEvents.length;
      await setSearchMode(cdp, "all-terms");
      await inputAndSearch(cdp, "private node");
      await waitFor(() => cdp.evaluate(`Boolean(Array.from(document.querySelectorAll("#document-list .document-row")).find(node => node.querySelector(".document-title")?.textContent === "multi-passage-lines.txt"))`));
      const response = await searchDirectly(cdp, "private node", "all-terms");
      expect(response.status === 200, `all-terms API HTTP ${response.status ?? "未知"}。`);
      const multi = response.data?.results?.find(item => typeof item.path === "string" && item.path.endsWith("multi-passage-lines.txt"));
      expect(multi?.passages?.length === 2, "合成多段落 API 沒有回傳兩段。");
      expect(multi.passages[0].location === "第 1 行" && multi.passages[1].location === "第 8 行", "API 多段落位置不符。");
      const list = await cdp.evaluate(`(() => {
        const row = Array.from(document.querySelectorAll("#document-list .document-row")).find(node => node.querySelector(".document-title")?.textContent === "multi-passage-lines.txt");
        if (!row) return null;
        const labels = Array.from(row.querySelectorAll(".result-passage-label")).map(node => node.textContent || "");
        const snippets = Array.from(row.querySelectorAll(".result-passage-snippet")).map(node => node.textContent || "");
        return {
          labels,
          snippets,
          marks: row.querySelectorAll(".result-passage-snippet mark").length,
          passages: row.querySelectorAll(".result-passages > .result-passage").length,
          listLabel: row.querySelector(".result-passages")?.getAttribute("aria-label") || "",
          labelSelect: Array.from(row.querySelectorAll(".result-passage-label")).map(node => getComputedStyle(node).userSelect),
          copyButtons: row.querySelectorAll(".copy-action button").length,
        };
      })()`);
      expect(list?.passages === 2, "列表沒有顯示兩個 li passage。");
      expect(list.labels[0].includes("第 1 行") && list.labels[0].includes("private"), "列表第一段缺少位置／詞標籤。");
      expect(list.labels[1].includes("第 8 行") && list.labels[1].includes("node"), "列表第二段缺少位置／詞標籤。");
      expect(JSON.stringify(list.snippets) === JSON.stringify(multi.passages.map(passage => passage.snippet)), "列表片段文字不是 API 原始 snippet。");
      expect(list.marks >= 2, "列表多段落沒有命中詞 mark。");
      expect(list.listLabel === "搜尋命中段落", "列表缺少 passage 清單 aria label。");
      expect(list.labelSelect.every(value => value === "none"), "passage 標籤沒有 user-select:none。");
      expect(list.copyButtons === 2, "多段落結果遺失複製路徑／檔名按鈕。");
      const selected = await cdp.evaluate(`(() => {
        const row = Array.from(document.querySelectorAll("#document-list .document-row")).find(node => node.querySelector(".document-title")?.textContent === "multi-passage-lines.txt");
        const active = window.getSelection();
        if (!row || !active) return [];
        return Array.from(row.querySelectorAll(".result-passage-snippet")).map(node => {
          const range = document.createRange();
          range.selectNodeContents(node);
          active.removeAllRanges();
          active.addRange(range);
          const value = active.toString();
          active.removeAllRanges();
          return value;
        });
      })()`);
      expect(JSON.stringify(selected) === JSON.stringify(multi.passages.map(passage => passage.snippet)), "Selection API 選取片段混入標籤或高亮字元。");
      await click(cdp, "#view-table");
      await waitFor(() => cdp.evaluate("!document.getElementById('document-table-wrap')?.hidden"));
      const table = await cdp.evaluate(`(() => {
        const row = Array.from(document.querySelectorAll("#document-table-body tr")).find(node => node.querySelector(".table-title")?.textContent === "multi-passage-lines.txt");
        return row ? {
          passages: row.querySelectorAll(".result-passages > .result-passage").length,
          snippets: Array.from(row.querySelectorAll(".result-passage-snippet")).map(node => node.textContent || ""),
          copyButtons: row.querySelectorAll(".copy-action button").length,
        } : null;
      })()`);
      expect(table?.passages === 2, "表格沒有顯示兩個 passage。");
      expect(JSON.stringify(table.snippets) === JSON.stringify(multi.passages.map(passage => passage.snippet)), "表格片段文字不是 API 原始 snippet。");
      expect(table.copyButtons === 2, "表格多段落結果遺失既有複製按鈕。");
      await click(cdp, "#view-list");
      await waitFor(() => visible(cdp, "#document-list"));
      await noBrowserErrorsSince(cdp, start, "all-terms 多段落列表／表格");
    });

    await check(`${label} 單一 passage 與 phrase 維持既有單一片段外觀`, async () => {
      const start = browserEvents.length;
      const query = "private node together";
      await setSearchMode(cdp, "phrase");
      await inputAndSearch(cdp, query);
      await waitFor(() => cdp.evaluate(`Boolean(Array.from(document.querySelectorAll("#document-list .document-row")).find(node => node.querySelector(".document-title")?.textContent === "single-passage.txt"))`));
      const phrase = await cdp.evaluate(`(() => {
        const row = Array.from(document.querySelectorAll("#document-list .document-row")).find(node => node.querySelector(".document-title")?.textContent === "single-passage.txt");
        return row ? {
          passageCount: row.querySelectorAll(".result-passages > .result-passage").length,
          snippetCount: row.querySelectorAll(".snippet").length,
          snippet: row.querySelector(".snippet")?.textContent || "",
          copyButtons: row.querySelectorAll(".copy-action button").length,
        } : null;
      })()`);
      expect(phrase?.passageCount === 0 && phrase?.snippetCount === 1, "phrase 單一結果外觀被多段落元件取代。");
      expect(phrase.copyButtons === 2, "phrase 單一結果遺失既有複製控制。");
      await setSearchMode(cdp, "all-terms");
      await inputAndSearch(cdp, query);
      await waitFor(() => cdp.evaluate(`Boolean(Array.from(document.querySelectorAll("#document-list .document-row")).find(node => node.querySelector(".document-title")?.textContent === "single-passage.txt"))`));
      const allTerms = await cdp.evaluate(`(() => {
        const row = Array.from(document.querySelectorAll("#document-list .document-row")).find(node => node.querySelector(".document-title")?.textContent === "single-passage.txt");
        return row ? {
          passageCount: row.querySelectorAll(".result-passages > .result-passage").length,
          snippetCount: row.querySelectorAll(".snippet").length,
          snippet: row.querySelector(".snippet")?.textContent || "",
          copyButtons: row.querySelectorAll(".copy-action button").length,
        } : null;
      })()`);
      expect(allTerms?.passageCount === 0 && allTerms?.snippetCount === 1, "單一 all-terms passage 不應顯示多段落清單。");
      expect(allTerms.copyButtons === 2, "all-terms 單一結果遺失既有複製控制。");
      expect(allTerms.snippet === phrase.snippet, "phrase 與單一 all-terms 的既有 snippet 外觀不一致。");
      await noBrowserErrorsSince(cdp, start, "單一 passage／phrase");
    });
    await check(`${label} phrase 第二片段與檔名／內文共命中顯示內容`, async () => {
      const start = browserEvents.length;
      await setSearchMode(cdp, "phrase");
      await inputAndSearch(cdp, "UI_SMOKE_PHRASE_NEEDLE");
      await waitFor(() => cdp.evaluate(`Boolean(Array.from(document.querySelectorAll("#document-list .document-row")).find(node => node.querySelector(".document-title")?.textContent === "phrase-second.txt"))`));
      const response = await searchDirectly(cdp, "UI_SMOKE_PHRASE_NEEDLE", "phrase");
      const phrase = response.data?.results?.find(item => typeof item.path === "string" && item.path.endsWith("phrase-second.txt"));
      expect(phrase?.passages?.length === 2, "phrase API 沒有回傳同文件第二片段。");
      expect(phrase.passages[0].location === "第 1 行" && phrase.passages[1].location === "第 3 行", "phrase 第二片段位置不符。");
      const list = await cdp.evaluate(`(() => {
        const row = Array.from(document.querySelectorAll("#document-list .document-row")).find(node => node.querySelector(".document-title")?.textContent === "phrase-second.txt");
        return row ? {
          passages: row.querySelectorAll(".result-passages > .result-passage").length,
          snippets: Array.from(row.querySelectorAll(".result-passage-snippet")).map(node => node.textContent || ""),
        } : null;
      })()`);
      expect(list?.passages === 2 && list.snippets.some(value => value.includes("second passage")), "列表沒有顯示第二片段。");
      await click(cdp, "#view-table");
      await waitFor(() => cdp.evaluate("!document.getElementById('document-table-wrap')?.hidden"));
      const tablePassages = await cdp.evaluate(`(() => {
        const row = Array.from(document.querySelectorAll("#document-table-body tr")).find(node => node.querySelector(".table-title")?.textContent === "phrase-second.txt");
        return row ? row.querySelectorAll(".result-passages > .result-passage").length : 0;
      })()`);
      expect(tablePassages === 2, "表格沒有顯示 phrase 第二片段。");
      await click(cdp, "#view-list");
      await waitFor(() => visible(cdp, "#document-list"));

      const filenameQuery = "UI_SMOKE_FILENAME_BODY_NEEDLE";
      await inputAndSearch(cdp, filenameQuery);
      await waitFor(() => cdp.evaluate(`Boolean(Array.from(document.querySelectorAll("#document-list .document-row")).find(node => node.querySelector(".document-title")?.textContent === "UI_SMOKE_FILENAME_BODY_NEEDLE.txt"))`));
      const filenameResponse = await searchDirectly(cdp, filenameQuery, "phrase");
      const filenameBody = filenameResponse.data?.results?.find(item => typeof item.path === "string" && item.path.endsWith("UI_SMOKE_FILENAME_BODY_NEEDLE.txt"));
      expect(filenameBody?.filenameOnly === true && filenameBody.passages?.length === 1, "檔名／內文共命中 API 欄位不符。");
      expect(filenameBody.passages[0].snippet.includes("body passage"), "檔名／內文共命中 API 沒有 body snippet。");
      const filenameRow = await cdp.evaluate(`(() => {
        const row = Array.from(document.querySelectorAll("#document-list .document-row")).find(node => node.querySelector(".document-title")?.textContent === "UI_SMOKE_FILENAME_BODY_NEEDLE.txt");
        return row ? {
          snippet: row.querySelector(".snippet")?.textContent || "",
          filenameFallback: row.textContent?.includes("檔名符合") || false,
        } : null;
      })()`);
      expect(filenameRow?.snippet.includes("body passage") && !filenameRow.filenameFallback, "工作台仍只顯示檔名符合。");
      await click(cdp, "#view-table");
      await waitFor(() => cdp.evaluate("!document.getElementById('document-table-wrap')?.hidden"));
      const filenameTable = await cdp.evaluate(`(() => {
        const row = Array.from(document.querySelectorAll("#document-table-body tr")).find(node => node.querySelector(".table-title")?.textContent === "UI_SMOKE_FILENAME_BODY_NEEDLE.txt");
        return row?.querySelector(".snippet")?.textContent || "";
      })()`);
      expect(filenameTable.includes("body passage"), "表格仍遺失檔名／內文共命中片段。");
      await click(cdp, "#view-list");
      await waitFor(() => visible(cdp, "#document-list"));
      await noBrowserErrorsSince(cdp, start, "phrase 第二片段與檔名／內文共命中");
    });

    await check(`${label} omittedTerms 顯示省略詞提示`, async () => {
      const start = browserEvents.length;
      await setSearchMode(cdp, "all-terms");
      await inputAndSearch(cdp, "alpha beta gamma delta epsilon");
      await waitFor(() => cdp.evaluate(`Boolean(Array.from(document.querySelectorAll("#document-list .document-row")).find(node => node.querySelector(".document-title")?.textContent === "omitted-terms.txt"))`));
      const response = await searchDirectly(cdp, "alpha beta gamma delta epsilon", "all-terms");
      const result = response.data?.results?.find(item => typeof item.path === "string" && item.path.endsWith("omitted-terms.txt"));
      expect(result?.omittedTerms === 1, `API omittedTerms 不符：${result?.omittedTerms ?? "未提供"}。`);
      const notice = await cdp.evaluate(`(() => {
        const row = Array.from(document.querySelectorAll("#document-list .document-row")).find(node => node.querySelector(".document-title")?.textContent === "omitted-terms.txt");
        return row ? {
          text: row.querySelector(".result-passages-omitted")?.textContent || "",
          listCount: row.querySelectorAll(".result-passages").length,
        } : null;
      })()`);
      expect(notice?.text === "還有 1 個詞未列出", "工作台沒有顯示 omittedTerms 提示。");
      expect(notice.listCount === 0, "單一 passage 不應虛構多段落清單。");
      await noBrowserErrorsSince(cdp, start, "omittedTerms 提示");
    });

    await check(`${label} 模式切換、分頁與上下文常駐側欄維持可操作`, async () => {
      const start = browserEvents.length;
      await setSearchMode(cdp, "phrase");
      await inputAndSearch(cdp, "UI_SMOKE_PAGE_TOKEN");
      await waitFor(() => cdp.evaluate("document.querySelectorAll('#document-list .document-row').length > 0 && !document.getElementById('search-status')?.textContent?.includes('搜尋中')"));
      const pageOne = await searchDirectly(cdp, "UI_SMOKE_PAGE_TOKEN", "phrase", 1);
      expect(pageOne.data?.pageCount >= 2, `合成分頁資料不足：${pageOne.data?.pageCount ?? "未提供"}。`);
      expect(await cdp.evaluate("document.getElementById('pagination-label')?.textContent === '1'"), "分頁初始頁碼不是 1。");
      expect(!(await cdp.evaluate("Boolean(document.getElementById('documents-next')?.disabled)")), "有第二頁時下一頁按鈕仍停用。");
      await click(cdp, "#documents-next");
      await waitFor(() => cdp.evaluate("document.getElementById('pagination-label')?.textContent === '2'"));
      await click(cdp, "#documents-prev");
      await waitFor(() => cdp.evaluate("document.getElementById('pagination-label')?.textContent === '1'"));

      await setSearchMode(cdp, "all-terms");
      await inputAndSearch(cdp, "private node");
      await waitFor(() => cdp.evaluate(`Boolean(Array.from(document.querySelectorAll("#document-list .document-row")).find(node => node.querySelector(".document-title")?.textContent === "multi-passage-lines.txt"))`));
      const selected = await cdp.evaluate(`(() => {
        const row = Array.from(document.querySelectorAll("#document-list .document-row")).find(node => node.querySelector(".document-title")?.textContent === "multi-passage-lines.txt");
        const control = row && Array.from(row.querySelectorAll(".document-actions button")).find(node => node.textContent === "加入上下文");
        if (!(control instanceof HTMLElement)) return false;
        control.click();
        return true;
      })()`);
      expect(selected, "找不到多段落結果的加入上下文控制。");
      await waitFor(() => cdp.evaluate("document.getElementById('nav-context-count')?.textContent === '1'"));
      await click(cdp, "#nav-context");
      await waitFor(() => cdp.evaluate("document.getElementById('context-drawer')?.classList.contains('context-panel') && !document.getElementById('context-drawer')?.classList.contains('is-collapsed')"));
      const panel = await cdp.evaluate(`(() => ({
        count: document.getElementById("context-count")?.textContent || "",
        itemCount: document.querySelectorAll("#context-indexed-list .context-item").length,
        nameText: document.querySelector("#context-indexed-list .context-item-name")?.textContent || "",
        pathText: document.querySelector("#context-indexed-list .context-item-meta")?.textContent || "",
        pathTitle: document.querySelector("#context-indexed-list .context-item-meta")?.title || "",
        bulkDisplay: getComputedStyle(document.getElementById("bulk-bar")).display,
        copyDisabled: Boolean(document.getElementById("context-copy-paths")?.disabled),
        hint: document.querySelector(".context-panel-hint")?.textContent || "",
      }))()`);
      expect(panel.count === "已選 1 / 20" && panel.itemCount === 1, "上下文常駐側欄沒有保留選取結果。");
      expect(panel.nameText === "multi-passage-lines.txt" && panel.pathText === fixture.multiPath && panel.pathTitle === fixture.multiPath, "上下文側欄沒有以檔名／完整絕對路徑兩行顯示。");
      expect(panel.bulkDisplay === (viewport.width <= 1180 ? "flex" : "none"), "結果底部選取列沒有依上下文欄狀態隱藏。");
      expect(!panel.copyDisabled && panel.hint.includes("每行一個"), "上下文側欄複製控制狀態或提示不符。");
      await click(cdp, "#context-copy-paths");
      await waitFor(() => cdp.evaluate(`window.__uiSmoke.clipboardText === ${JSON.stringify(fixture.multiPath)}`));
      const copiedPanelPath = await cdp.evaluate("window.__uiSmoke.clipboardText");
      expect(copiedPanelPath === fixture.multiPath && !copiedPanelPath.includes("上下文") && !copiedPanelPath.endsWith("\n"), "側欄複製內容不是只有一行絕對路徑。");
      await click(cdp, "#context-indexed-list .context-item .result-action");
      await waitFor(() => cdp.evaluate("document.getElementById('nav-context-count')?.textContent === '0'"));

      const reselected = await cdp.evaluate(`(() => {
        const row = Array.from(document.querySelectorAll("#document-list .document-row")).find(node => node.querySelector(".document-title")?.textContent === "multi-passage-lines.txt");
        const control = row && Array.from(row.querySelectorAll(".document-actions button")).find(node => node.textContent === "加入上下文");
        if (!(control instanceof HTMLElement)) return false;
        control.click();
        return true;
      })()`);
      expect(reselected, "移除後無法再次加入上下文。");
      await waitFor(() => cdp.evaluate("document.getElementById('nav-context-count')?.textContent === '1'"));
      await click(cdp, "#context-toggle");
      await waitFor(() => cdp.evaluate("document.getElementById('app-shell')?.classList.contains('context-panel-collapsed') && document.getElementById('context-toggle')?.getAttribute('aria-expanded') === 'false'"));
      await click(cdp, "#nav-context");
      await waitFor(() => cdp.evaluate("!document.getElementById('app-shell')?.classList.contains('context-panel-collapsed') && document.getElementById('context-toggle')?.getAttribute('aria-expanded') === 'true'"));
      await click(cdp, "#context-clear-selection");
      await noBrowserErrorsSince(cdp, start, "模式切換／分頁／上下文常駐側欄");
    });

    await check(`${label} 列表與表格維持一致操作群組並呼叫 library API`, async () => {
      const start = browserEvents.length;
      await cdp.evaluate("window.__uiSmoke.libraryActions = []");
      await setSearchMode(cdp, "all-terms");
      await inputAndSearch(cdp, "private node");
      await waitFor(() => cdp.evaluate(`Boolean(Array.from(document.querySelectorAll("#document-list .document-row")).find(node => node.querySelector(".document-title")?.textContent === "multi-passage-lines.txt"))`));
      const sort = await cdp.evaluate(`(() => {
        const select = document.getElementById("document-sort"); return { value: select?.value || "", label: select?.selectedOptions?.[0]?.textContent || "" };
      })()`);
      expect(sort?.value === "relevance" && sort.label === "目前結果：相關性", `排序下拉顯示不符：${JSON.stringify(sort)}`);
      const listActions = await cdp.evaluate(`(() => {
        const row = Array.from(document.querySelectorAll("#document-list .document-row")).find(node => node.querySelector(".document-title")?.textContent === "multi-passage-lines.txt");
        const group = row?.querySelector(".document-actions");
        const controls = Array.from(group?.querySelectorAll("button, select") || []);
        const label = node => node instanceof HTMLSelectElement ? node.selectedOptions?.[0]?.textContent || "" : node.textContent || "";
        return row ? {
          labels: controls.map(label),
          actions: controls.filter(node => node.dataset.action).map(node => node.dataset.action),
          groupClass: group?.className || "",
          gap: group ? getComputedStyle(group).gap : "",
          heights: controls.map(node => Math.round(node.getBoundingClientRect().height)),
          primaryContext: Boolean(row.querySelector('button[data-action="context"].primary')),
        } : null;
      })()`);
      const expectedLabels = ["複製路徑", "複製檔名", "開啟", "顯示所在位置", "釘選", "加入分類", "加入上下文"];
      expect(listActions && expectedLabels.every(value => listActions.labels.includes(value)), "列表結果遺失一致快捷操作。");
      expect(listActions?.actions.join(",") === "open,reveal,pin,group,context" && listActions.groupClass.includes("document-actions"), "列表 action data contract 不符。");
      expect(listActions?.gap === "6px" && listActions.heights.every(value => value === 30) && listActions.primaryContext, "列表操作列沒有統一 gap／高度或主色上下文按鈕。");
      const clickedLibraryButtons = await cdp.evaluate(`(() => {
        const row = Array.from(document.querySelectorAll("#document-list .document-row")).find(node => node.querySelector(".document-title")?.textContent === "multi-passage-lines.txt");
        const pin = row?.querySelector('button[data-action="pin"]');
        const group = row?.querySelector('select[data-action="group"]');
        const groupOption = group instanceof HTMLSelectElement ? Array.from(group.options).find(option => option.value) : null;
        if (pin instanceof HTMLElement) pin.click();
        if (group instanceof HTMLSelectElement && groupOption) {
          group.value = groupOption.value;
          group.dispatchEvent(new Event("change", { bubbles: true }));
        }
        return { pin: Boolean(pin), group: Boolean(group && groupOption) };
      })()`);
      expect(clickedLibraryButtons?.pin && clickedLibraryButtons?.group, `列表沒有可點擊的釘選／分類按鈕：${JSON.stringify(clickedLibraryButtons)}`);
      const toggledAgain = await cdp.evaluate(`(() => {
        const row = Array.from(document.querySelectorAll("#document-list .document-row")).find(node => node.querySelector(".document-title")?.textContent === "multi-passage-lines.txt");
        const pin = row?.querySelector('button[data-action="pin"]');
        if (pin instanceof HTMLElement) pin.click();
        return Boolean(pin);
      })()`);
      expect(toggledAgain, "釘選成功後找不到取消釘選按鈕。");
      await waitFor(() => cdp.evaluate("window.__uiSmoke.libraryActions.length === 3"), 5_000);
      const libraryActions = await cdp.evaluate("window.__uiSmoke.libraryActions");
      expect(libraryActions[0].path === "/api/library/pinned" && libraryActions[0].method === "PUT" && libraryActions[0].body?.path === fixture.multiPath && libraryActions[0].body?.reference && libraryActions[0].body?.name && !Object.prototype.hasOwnProperty.call(libraryActions[0].body, "pinned"), "釘選沒有送出 pi2 PUT payload。");
      expect(/^\/api\/library\/groups\/\d+\/items$/u.test(libraryActions[1].path) && libraryActions[1].method === "POST" && libraryActions[1].body?.path === fixture.multiPath && libraryActions[1].body?.reference && libraryActions[1].body?.name, "分類沒有送出 pi2 items POST payload。");
      expect(libraryActions[2].path === "/api/library/pinned" && libraryActions[2].method === "DELETE" && libraryActions[2].body?.path === fixture.multiPath && libraryActions[2].body?.reference && !Object.prototype.hasOwnProperty.call(libraryActions[2].body, "name"), "取消釘選沒有送出 pi2 DELETE payload。");
      await click(cdp, "#view-table");
      await waitFor(() => cdp.evaluate("!document.getElementById('document-table-wrap')?.hidden"));
      const tableActions = await cdp.evaluate(`(() => {
        const row = Array.from(document.querySelectorAll("#document-table-body tr")).find(node => node.querySelector(".table-title")?.textContent === "multi-passage-lines.txt");
        if (!row) return null;
        const cells = Array.from(row.children);
        const actionCell = cells.at(-1);
        const checkCell = cells[0];
        const group = actionCell?.querySelector(".document-actions");
        const controls = Array.from(group?.querySelectorAll("button, select") || []);
        return {
          cellCount: cells.length,
          headerCount: document.querySelectorAll(".documents-table thead th").length,
          labels: controls.map(node => node instanceof HTMLSelectElement ? node.selectedOptions?.[0]?.textContent || "" : node.textContent || ""),
          actionCellClass: actionCell?.className || "",
          gap: group ? getComputedStyle(group).gap : "",
          heights: controls.map(node => Math.round(node.getBoundingClientRect().height)),
          primaryContext: Boolean(actionCell?.querySelector('button[data-action="context"].primary')),
          titleCopyButtons: row.querySelectorAll("td:nth-child(2) .copy-control").length,
          checkVisibleText: (checkCell?.innerText || "").trim(),
          checkPseudoText: [getComputedStyle(checkCell, "::before").content, getComputedStyle(checkCell, "::after").content].join(""),
          hasStandaloneDot: (checkCell?.innerText || "").includes(".")
            || [getComputedStyle(checkCell, "::before").content, getComputedStyle(checkCell, "::after").content].some(value => value.includes(".")),
        };
      })()`);
      expect(tableActions?.cellCount === 7 && tableActions.headerCount === 7, "表格結果沒有獨立七欄操作結構。");
      expect(tableActions.labels.length === expectedLabels.length && expectedLabels.every(value => tableActions.labels.includes(value)), "表格操作群組與列表不一致。");
      expect(tableActions.gap === "6px" && tableActions.heights.every(value => value === 30) && tableActions.primaryContext
        && tableActions.titleCopyButtons === 0 && tableActions.actionCellClass.includes("document-actions-cell")
        && !tableActions.checkVisibleText.includes(".") && !tableActions.checkPseudoText.includes("."), "勾選框所在儲存格可見文字不得含句點。");
      await click(cdp, "#view-list");
      await waitFor(() => visible(cdp, "#document-list"));
      await noBrowserErrorsSince(cdp, start, "列表／表格快捷操作");
    });

    await check(`${label} 搜尋零結果顯示排除提示與檢查輸入欄`, async () => {
      const start = browserEvents.length;
      await inputAndSearch(cdp, "UI_SMOKE_ZERO_RESULT_NEEDLE");
      await waitFor(() => cdp.evaluate("Boolean(document.getElementById('search-empty-explain-form'))"));
      const empty = await cdp.evaluate(`(() => ({
        hint: document.querySelector(".empty-exclusion-hint")?.textContent || "",
        input: Boolean(document.getElementById("search-empty-explain-path")),
      }))()`);
      expect(empty.input, "零結果沒有檢查輸入欄。");
      expect(empty.hint.includes("可能有位置依預設排除規則不索引"), "零結果沒有排除提示。");
      await noBrowserErrorsSince(cdp, start, "零結果搜尋");
    });

    const explanationCases = [
      { name: "被排除路徑", path: fixture.excludedPath, state: "excluded", pattern: /已排除/u },
      { name: "已索引路徑", path: fixture.indexedPath, state: "indexed", pattern: /已索引/u },
      { name: "根外路徑", path: fixture.outsidePath, state: "outside-root", pattern: /不在任何已登錄根目錄內/u },
    ];
    for (const item of explanationCases) {
      await check(`${label} 零結果輸入${item.name}顯示對應說明`, async () => {
        const start = browserEvents.length;
        await inputAndExplain(cdp, item.path);
        await waitFor(() => cdp.evaluate(`new RegExp(${JSON.stringify(item.pattern.source)}, "u").test(document.getElementById("search-empty-explain-result")?.textContent || "")`));
        const direct = await explainDirectly(cdp, item.path);
        expect(direct?.status === 200, `${item.name} explain HTTP ${direct?.status ?? "未知"}。`);
        expect(direct?.data?.state === item.state, `${item.name} state 不符：${direct?.data?.state ?? "未提供"}。`);
        if (item.state === "outside-root") expect(!Object.prototype.hasOwnProperty.call(direct.data, "exists"), "根外回應不應含 exists 欄位。");
        await noBrowserErrorsSince(cdp, start, `${item.name}說明`);
      });
    }

    await check(`${label} 加入合成資料夾只顯示預覽、確認按鈕狀態正確且未開始索引`, async () => {
      const start = browserEvents.length;
      await click(cdp, "#nav-roots");
      await waitFor(() => visible(cdp, "#roots-page"));
      const initiallyDisabled = await cdp.evaluate("Boolean(document.getElementById('root-confirm')?.disabled)");
      expect(initiallyDisabled, "尚未選取資料夾時確認按鈕不應可用。");
      await setPickerRoot(cdp, fixture.root);
      await click(cdp, "#root-choose");
      await waitFor(() => cdp.evaluate(`document.getElementById("root-draft")?.value === ${JSON.stringify(fixture.root)}`));
      await waitFor(() => cdp.evaluate("window.__uiSmoke.requests.some(item => item.path === '/api/exclusions') && !document.getElementById('root-confirm')?.disabled"));
      const preview = await cdp.evaluate(`(() => ({
        draftMessage: document.getElementById("root-draft-message")?.textContent || "",
        previewRequest: window.__uiSmoke.requests.some(item => item.path === "/api/exclusions"),
        confirmDisabled: Boolean(document.getElementById("root-confirm")?.disabled),
        indexPosts: window.__uiSmoke.requests.filter(item => item.path === "/api/index" && item.method === "POST").length,
      }))()`);
      expect(preview.draftMessage.includes("尚未開始索引"), "合成資料夾選取後沒有唯讀預覽訊息。");
      expect(preview.previewRequest, "合成資料夾選取後沒有取得排除預覽。");
      expect(!preview.confirmDisabled, "取得合成資料夾預覽後確認按鈕仍停用。");
      expect(preview.indexPosts === 0, "選取資料夾時不應直接開始索引。");
      await noBrowserErrorsSince(cdp, start, "合成資料夾加入流程");
    });

    await check(`${label} 加入 C:\\ 前顯示會預設略過哪些位置且不可跳過確認`, async () => {
      const start = browserEvents.length;
      const volumeRoot = "C:\\";
      await setPickerRoot(cdp, volumeRoot);
      await click(cdp, "#root-choose");
      await waitFor(() => cdp.evaluate(`document.getElementById("root-draft")?.value === ${JSON.stringify(volumeRoot)}`));
      await waitFor(() => visible(cdp, "#root-exclusion-preview"));
      const preview = await cdp.evaluate(`(() => ({
        hidden: Boolean(document.getElementById("root-exclusion-preview")?.hidden),
        text: document.getElementById("root-exclusion-preview")?.textContent || "",
        confirmDisabled: Boolean(document.getElementById("root-confirm")?.disabled),
        indexPosts: window.__uiSmoke.requests.filter(item => item.path === "/api/index" && item.method === "POST").length,
      }))()`);
      expect(!preview.hidden, "整顆磁碟排除預覽仍隱藏。");
      expect(preview.text.includes("會預設略過哪些位置"), "整顆磁碟預覽缺少固定標題。");
      expect(/Windows|Program Files|ProgramData/u.test(preview.text), "整顆磁碟預覽沒有列出預設排除規則。");
      expect(!preview.confirmDisabled, "排除預覽完成後確認按鈕狀態不正確。");
      expect(preview.indexPosts === 0, "未按確認前不應送出建立索引要求。");
      await noBrowserErrorsSince(cdp, start, "整顆磁碟加入流程");
    });

    await prepareRefreshFixture(fixture);
    await check(`${label} 重新檢查資料夾顯示四類完成計數且不新增第二筆根目錄`, async () => {
      const start = browserEvents.length;
      await setPickerRoot(cdp, fixture.refreshFolder);
      await click(cdp, "#roots-refresh-folder");
      await waitFor(() => cdp.evaluate(`/(新增|更新) \\d+、更新 \\d+、移除 \\d+、略過 \\d+/.test(document.getElementById("index-status-message")?.textContent || "")`), 30_000);
      const result = await cdp.evaluate(`(() => ({
        message: document.getElementById("index-status-message")?.textContent || "",
        rootRows: document.querySelectorAll("#roots-body tr:not(.root-empty-row)").length,
        navRootCount: document.getElementById("nav-root-count")?.textContent || "",
      }))()`);
      expect(/新增 \d+、更新 \d+、移除 \d+、略過 \d+/u.test(result.message), `完成訊息缺少四類計數：${result.message}`);
      expect(result.rootRows === 1 && result.navRootCount === "1", "重新檢查資料夾新增了第二筆根目錄。");
      await noBrowserErrorsSince(cdp, start, "重新檢查資料夾");
    });
    await check(`${label} CLI autoupdate start 可由工作台讀取並關閉`, async () => {
      const start = browserEvents.length;
      startCliAutoupdate(fixture);
      try {
        await click(cdp, "#settings-toggle");
        await waitFor(() => cdp.evaluate("document.getElementById('settings-dialog')?.open === true"));
        await click(cdp, "#settings-autoupdate-refresh");
        await waitFor(async () => {
          const current = await indexStatus(cdp);
          return current?.autoupdate?.enabled === true && current.autoupdate.live?.mode === "background";
        }, 30_000);
        const running = await settingSnapshot(cdp);
        expect(running.auto?.ariaChecked === "true" && running.auto?.state === "已開啟", "CLI autoupdate start 後 Toggle Switch 沒有顯示已開啟。");
        await click(cdp, "#settings-autoupdate");
        await waitFor(async () => (await settingSnapshot(cdp)).auto?.ariaChecked === "false", 30_000);
        const stopped = await indexStatus(cdp);
        expect(stopped?.autoupdate?.enabled === false, "工作台關閉 CLI daemon 後 API 仍顯示 enabled。");
        await noBrowserErrorsSince(cdp, start, "CLI autoupdate start／stop");
      } finally {
        try {
          const current = await indexStatus(cdp);
          if (current?.autoupdate?.enabled) await settingsPost(cdp, { autoupdateEnabled: false });
        } catch { /* 主斷言已回報；清理只處理合成 daemon。 */ }
        await sleep(500);
        await cdp.evaluate("document.getElementById('settings-dialog')?.close()");
      }
    });
    await check(`${label} 開機補捉 ask 四動作、auto／off、執行中與設定失敗回復`, async () => {
      const start = browserEvents.length;
      const refreshCatchup = async () => {
        await click(cdp, "#settings-autoupdate-refresh");
        await waitFor(async () => {
          const current = await indexStatus(cdp);
          return current?.autoupdate?.live?.mode === "background";
        }, 30_000);
      };
      const catchupStatus = async () => {
        const current = await indexStatus(cdp);
        return current?.autoupdate?.live?.startupCatchup;
      };
      const chooseMode = async mode => {
        await cdp.evaluate(`(() => {
          const node = document.getElementById("settings-startup-catchup-mode");
          if (!(node instanceof HTMLSelectElement)) return false;
          node.value = ${JSON.stringify(mode)};
          node.dispatchEvent(new Event("change", { bubbles: true }));
          return true;
        })()`);
        await waitFor(async () => {
          const snapshot = await settingSnapshot(cdp);
          return snapshot.mode?.value === mode && !snapshot.mode?.disabled;
        }, 30_000);
      };
      const refreshPendingAsk = async () => {
        try {
          await refreshCatchup();
          await waitFor(async () => {
            const status = await catchupStatus();
            return status?.mode === "ask" && status?.state === "pending";
          }, 30_000);
          await waitFor(async () => {
            const snapshot = await settingSnapshot(cdp);
            return snapshot.catchup?.hidden === false && snapshot.mode?.value === "ask";
          }, 30_000);
        } catch (error) {
          const current = await indexStatus(cdp).catch(() => null);
          const snapshot = await settingSnapshot(cdp).catch(() => null);
          const live = current?.autoupdate?.live;
          throw new Error(`startup catch-up pending 等待失敗：${JSON.stringify({
            autoupdate: { enabled: current?.autoupdate?.enabled, live: live ? { mode: live.mode, startupCatchup: live.startupCatchup } : null },
            snapshot,
          })}；${error instanceof Error ? error.message : String(error)}`);
        }
      };

      const initial = await settingsPost(cdp, { autoupdateEnabled: false, startupCatchupMode: "ask" });
      expect(initial.status === 200 && initial.data?.startupCatchupMode === "ask", "無法先保存 ask 策略。");
      startCliAutoupdate(fixture, "ask");
      try {
        await click(cdp, "#settings-toggle");
        await waitFor(() => cdp.evaluate("document.getElementById('settings-dialog')?.open === true"));
        await refreshPendingAsk();
        let snapshot = await settingSnapshot(cdp);
        expect(snapshot.catchup?.status.includes("等待你的選擇"), "ask pending 狀態沒有明確文字。");
        expect(snapshot.catchup?.actionsDisabled === false, "ask pending 四個動作全部停用。");

        await cdp.evaluate("window.__uiSmoke.failNextStartupCatchupMode = true; window.__uiSmoke.delayNextSettingsMs = 250;");
        await cdp.evaluate(`(() => {
          const node = document.getElementById("settings-startup-catchup-mode");
          if (!(node instanceof HTMLSelectElement)) return false;
          node.value = "auto";
          node.dispatchEvent(new Event("change", { bubbles: true }));
          return true;
        })()`);
        await sleep(50);
        snapshot = await settingSnapshot(cdp);
        expect(snapshot.mode?.disabled === true, "開機補捉策略保存期間沒有停用選擇器。");
        await waitFor(async () => {
          const current = await settingSnapshot(cdp);
          return current.mode?.value === "ask" && !current.mode?.disabled;
        }, 30_000);
        snapshot = await settingSnapshot(cdp);
        expect(snapshot.status.includes("煙霧測試模擬開機補捉策略保存失敗"), "策略保存失敗沒有顯示明確錯誤。");

        await click(cdp, "#startup-catchup-later");
        await waitFor(async () => (await settingSnapshot(cdp)).catchup?.hidden === true);
        expect((await catchupStatus())?.state === "pending", "稍後提醒不應消費 downtime gap。");

        stopCliAutoupdate(fixture);
        startCliAutoupdate(fixture, "ask");
        await refreshPendingAsk();
        await click(cdp, "#startup-catchup-skip");
        await waitFor(async () => (await catchupStatus())?.state === "skipped", 30_000);
        expect((await settingSnapshot(cdp)).catchup?.hidden === true, "略過本次後 banner 沒有隱藏。");

        stopCliAutoupdate(fixture);
        startCliAutoupdate(fixture, "ask");
        await refreshPendingAsk();
        await click(cdp, "#startup-catchup-disable");
        await waitFor(async () => {
          const mode = await settingSnapshot(cdp);
          const status = await catchupStatus();
          return mode.mode?.value === "off" && !mode.mode?.disabled && status?.mode === "off" && status?.state === "skipped";
        }, 30_000);
        expect((await settingSnapshot(cdp)).catchup?.hidden === true, "關閉開機補捉後 banner 沒有隱藏。");

        await chooseMode("auto");
        await waitFor(async () => {
          const status = await catchupStatus();
          return status?.mode === "auto" && ["running", "complete"].includes(status?.state);
        }, 30_000);
        expect((await settingSnapshot(cdp)).catchup?.hidden === true, "auto 模式不應顯示 ask banner。");

        await chooseMode("off");
        await waitFor(async () => {
          const status = await catchupStatus();
          return status?.mode === "off" && status?.state === "skipped";
        }, 30_000);
        const explicitBefore = (await indexStatus(cdp)).autoupdate?.live?.localUpdateCount ?? 0;
        await writeFile(path.join(fixture.root, `ui-smoke-explicit-${viewport.width}.txt`), "UI_SMOKE_EXPLICIT_EVENT\n");
        await waitFor(async () => ((await indexStatus(cdp)).autoupdate?.live?.localUpdateCount ?? 0) > explicitBefore, 30_000);

        await chooseMode("ask");
        await refreshPendingAsk();
        await cdp.evaluate("window.__uiSmoke.delayNextCatchupMs = 1_000");
        await click(cdp, "#startup-catchup-start");
        await sleep(50);
        snapshot = await settingSnapshot(cdp);
        expect(snapshot.catchup?.actionsDisabled === true && snapshot.catchup?.status.includes("處理中"), "立即補捉執行中沒有停用四個動作或顯示處理中。");
        await waitFor(async () => ["running", "complete"].includes((await catchupStatus())?.state), 30_000);
        expect((await catchupStatus())?.mode === "ask", "立即補捉後策略不應被改寫。");
        await noBrowserErrorsSince(cdp, start, "開機補捉 ask／四動作／auto／off");
      } finally {
        try { stopCliAutoupdate(fixture); } catch { /* 主斷言保留；finally 僅清理合成 daemon。 */ }
        await cdp.evaluate("document.getElementById('settings-dialog')?.close()");
      }
    });
    await check(`${label} 工作台開啟模式覆蓋未執行 ask 四動作、auto／off 與設定恢復`, async () => {
      const start = browserEvents.length;
      const chooseMode = async mode => {
        const changed = await cdp.evaluate(`(() => {
          const node = document.getElementById("settings-workbench-open-mode");
          if (!(node instanceof HTMLSelectElement)) return false;
          node.value = ${JSON.stringify(mode)};
          node.dispatchEvent(new Event("change", { bubbles: true }));
          return true;
        })()`);
        expect(changed, "找不到工作台開啟提醒策略選擇器。");
        await waitFor(async () => {
          const snapshot = await settingSnapshot(cdp);
          return snapshot.openMode?.value === mode && !snapshot.openMode?.disabled;
        }, 30_000);
      };
      const chooseStartupMode = async mode => {
        const changed = await cdp.evaluate(`(() => {
          const node = document.getElementById("settings-startup-catchup-mode");
          if (!(node instanceof HTMLSelectElement)) return false;
          node.value = ${JSON.stringify(mode)};
          node.dispatchEvent(new Event("change", { bubbles: true }));
          return true;
        })()`);
        expect(changed, "找不到 startup catch-up 策略選擇器。");
        await waitFor(async () => {
          const snapshot = await settingSnapshot(cdp);
          return snapshot.mode?.value === mode && !snapshot.mode?.disabled;
        }, 30_000);
      };
      const openSettingsAndRefresh = async () => {
        await click(cdp, "#settings-toggle");
        await waitFor(() => cdp.evaluate("document.getElementById('settings-dialog')?.open === true"));
        await click(cdp, "#settings-autoupdate-refresh");
        await waitFor(async () => (await indexStatus(cdp)).autoupdate?.enabled === false, 30_000);
      };
      const waitForStopped = async () => {
        await waitFor(async () => (await indexStatus(cdp)).autoupdate?.enabled === false, 30_000);
      };
      try {
        try { stopCliAutoupdate(fixture); } catch { /* 已停止即可。 */ }
        const initial = await settingsPost(cdp, {
          autoupdateEnabled: false,
          startupCatchupMode: "ask",
          workbenchOpenMode: "ask",
        });
        expect(initial.status === 200 && initial.data?.workbenchOpenMode === "ask", "無法先保存 workbenchOpenMode ask。");
        await cdp.evaluate("document.getElementById('settings-dialog')?.close()");
        await reloadWorkbench(cdp);
        await waitFor(async () => (await indexStatus(cdp)).state === "available", 30_000);
        await openSettingsAndRefresh();
        await sleep(500);
        const initialSnapshot = await settingSnapshot(cdp);
        const initialStatus = await indexStatus(cdp);
        expect(initialSnapshot.openMode?.value === "ask" && initialSnapshot.open?.hidden === false,
          `daemon 未執行時沒有工作台開啟提醒：${JSON.stringify({ status: initialStatus, snapshot: initialSnapshot })}`);
        let snapshot = initialSnapshot;
        expect(snapshot.open.title.includes("背景更新目前沒有執行"), "daemon 未執行時沒有工作台開啟提醒。");
        expect(snapshot.open.message.includes("上次成功同步") && snapshot.open.message.includes("關閉期間新增或修改"), "工作台開啟提醒沒有顯示上次同步與遺漏文字。");
        expect(snapshot.open.warning.includes("耗用磁碟") && snapshot.open.warning.includes("CPU"), "工作台開啟提醒沒有保留 C:\\ 成本警告文字。");
        expect(snapshot.open.actionsDisabled === false, "工作台開啟提醒四個動作全部停用。");
        expect(snapshot.catchup.hidden === true, "daemon 未執行時不應同時顯示 startup catch-up 提醒。");

        await cdp.evaluate("window.__uiSmoke.failNextWorkbenchOpenMode = true; window.__uiSmoke.delayNextSettingsMs = 250;");
        await cdp.evaluate(`(() => {
          const node = document.getElementById("settings-workbench-open-mode");
          if (!(node instanceof HTMLSelectElement)) return false;
          node.value = "off";
          node.dispatchEvent(new Event("change", { bubbles: true }));
          return true;
        })()`);
        await sleep(50);
        snapshot = await settingSnapshot(cdp);
        expect(snapshot.openMode?.disabled === true, "工作台開啟策略保存期間沒有停用選擇器。");
        await waitFor(async () => {
          const current = await settingSnapshot(cdp);
          return current.openMode?.value === "ask" && !current.openMode?.disabled;
        }, 30_000);
        snapshot = await settingSnapshot(cdp);
        expect(snapshot.status.includes("煙霧測試模擬工作台開啟策略保存失敗"), "工作台開啟策略保存失敗沒有顯示明確錯誤。");

        await click(cdp, "#workbench-open-later");
        await waitFor(async () => (await settingSnapshot(cdp)).open?.hidden === true);
        expect((await indexStatus(cdp)).autoupdate?.enabled === false, "稍後再說不應啟動 daemon。");

        await chooseMode("off");
        await chooseMode("ask");
        await waitFor(async () => (await settingSnapshot(cdp)).open?.hidden === false);
        await click(cdp, "#workbench-open-start");
        await waitFor(async () => {
          const current = await indexStatus(cdp);
          return current?.autoupdate?.live?.mode === "background"
            && current.autoupdate.live.startupCatchup?.mode === "auto"
            && ["running", "complete"].includes(current.autoupdate.live.startupCatchup?.state);
        }, 30_000);
        await waitFor(async () => (await settingSnapshot(cdp)).open?.hidden === true, 30_000);
        snapshot = await settingSnapshot(cdp);
        expect(snapshot.open?.hidden === true, "明確開啟背景更新並補捉後提醒沒有隱藏。");
        expect(snapshot.status.includes("啟動背景更新") || snapshot.status.includes("開啟背景更新"), "明確開啟後沒有通知。");
        stopCliAutoupdate(fixture);
        await waitForStopped();

        await chooseMode("off");
        await chooseMode("ask");
        await waitFor(async () => (await settingSnapshot(cdp)).open?.hidden === false);
        await click(cdp, "#workbench-open-index");
        await waitFor(async () => (await indexStatus(cdp)).indexing?.state === "complete", 30_000);
        await waitFor(async () => (await settingSnapshot(cdp)).open?.hidden === true, 30_000);
        snapshot = await settingSnapshot(cdp);
        expect(snapshot.open?.hidden === true, "只做一次完整校正後提醒沒有隱藏。");
        expect((await indexStatus(cdp)).autoupdate?.enabled === false, "只做一次完整校正不應啟動 daemon。");

        await chooseMode("off");
        await chooseMode("ask");
        await waitFor(async () => (await settingSnapshot(cdp)).open?.hidden === false);
        await click(cdp, "#workbench-open-disable");
        await waitFor(async () => {
          const current = await settingSnapshot(cdp);
          const status = await indexStatus(cdp);
          return current.openMode?.value === "off" && current.open?.hidden === true && status.workbenchOpenMode === "off";
        }, 30_000);
        await chooseMode("ask");
        expect((await settingSnapshot(cdp)).openMode?.value === "ask", "工作台開啟提醒策略無法在設定恢復 ask。");
        await chooseMode("off");

        await chooseMode("auto");
        await cdp.evaluate("document.getElementById('settings-dialog')?.close()");
        await reloadWorkbench(cdp);
        await waitFor(async () => {
          const current = await indexStatus(cdp);
          return current?.autoupdate?.live?.mode === "background"
            && current.autoupdate.live.startupCatchup?.mode === "auto";
        }, 30_000);
        await waitFor(async () => (await settingSnapshot(cdp)).open?.hidden === true, 30_000);
        snapshot = await settingSnapshot(cdp);
        expect(snapshot.open?.hidden === true, "workbenchOpenMode auto 啟動後仍顯示工作台開啟提醒。");
        stopCliAutoupdate(fixture);
        await waitForStopped();

        await click(cdp, "#settings-toggle");
        await waitFor(() => cdp.evaluate("document.getElementById('settings-dialog')?.open === true"));
        await chooseMode("off");
        await cdp.evaluate("document.getElementById('settings-dialog')?.close()");
        await reloadWorkbench(cdp);
        await waitForStopped();
        expect((await settingSnapshot(cdp)).open?.hidden === true, "workbenchOpenMode off 仍顯示提醒。");

        await click(cdp, "#settings-toggle");
        await waitFor(() => cdp.evaluate("document.getElementById('settings-dialog')?.open === true"));
        await chooseMode("ask");
        await chooseStartupMode("ask");
        await cdp.evaluate("document.getElementById('settings-dialog')?.close()");
        await writeFile(path.join(fixture.root, `workbench-open-pending-${viewport.width}.txt`), "UI_SMOKE_WORKBENCH_OPEN_PENDING\n");
        startCliAutoupdate(fixture, "ask");
        await reloadWorkbench(cdp);
        await waitFor(async () => (await indexStatus(cdp)).autoupdate?.live?.mode === "background", 30_000);
        snapshot = await settingSnapshot(cdp);
        expect(snapshot.open?.hidden === true, "daemon 已執行時不應顯示工作台開啟提醒。");
        await noBrowserErrorsSince(cdp, start, "工作台開啟模式 ask／四動作／auto／off");
      } finally {
        try { stopCliAutoupdate(fixture); } catch { /* 主斷言保留；清理合成 daemon。 */ }
        await cdp.evaluate("document.getElementById('settings-dialog')?.close()");
      }
    });

    await check(`${label} 前景 watch 拒絕遠端關閉且保留實際狀態`, async () => {
      const start = browserEvents.length;
      const foreground = spawn(process.execPath, [cli, "watch", fixture.root, "--debounce", "200", "--rescan", "60000"], {
        cwd: project,
        env: syntheticEnvironment(fixture),
        stdio: "ignore",
        windowsHide: true,
      });
      try {
        await waitFor(async () => {
          const current = await indexStatus(cdp);
          return current?.autoupdate?.live?.mode === "foreground";
        }, 30_000);
        await click(cdp, "#settings-toggle");
        await waitFor(() => cdp.evaluate("document.getElementById('settings-dialog')?.open === true"));
        await click(cdp, "#settings-autoupdate-refresh");
        await waitFor(async () => (await settingSnapshot(cdp)).auto?.ariaChecked === "true");
        await click(cdp, "#settings-autoupdate");
        await waitFor(async () => {
          const current = await settingSnapshot(cdp);
          return !current.auto?.disabled && current.auto?.ariaChecked === "true";
        }, 30_000);
        const rejected = await settingSnapshot(cdp);
        expect(rejected.status.includes("原終端按 Ctrl+C"), "前景 watch 拒絕遠端關閉時沒有明確提示。");
        const current = await indexStatus(cdp);
        expect(current?.autoupdate?.enabled === true && current.autoupdate.live?.mode === "foreground", "前景 watch 拒絕後 API 狀態不一致。");
        await noBrowserErrorsExcept(cdp, start, "前景 watch 遠端關閉", event => event.message.includes("/api/settings"));
      } finally {
        await cdp.evaluate("document.getElementById('settings-dialog')?.close()");
        if (foreground.exitCode === null) {
          foreground.kill("SIGINT");
          await Promise.race([waitForExit(foreground), sleep(2_000)]);
        }
        await sleep(500);
      }
    });

    await prepareIndexingFixture(fixture);
    await check(`${label} 索引進行中切換背景更新仍保持 API parity`, async () => {
      const start = browserEvents.length;
      try {
        await click(cdp, "#settings-toggle");
        await waitFor(() => cdp.evaluate("document.getElementById('settings-dialog')?.open === true"));
        await click(cdp, "#settings-autoupdate-refresh");
        await waitFor(async () => {
          const current = await indexStatus(cdp);
          return current?.autoupdate?.enabled === false;
        }, 30_000);
        const response = await cdp.evaluate(`(async () => {
          const token = decodeURIComponent(location.hash.slice(1));
          const result = await fetch("/api/index", {
            method: "POST",
            headers: { "X-LocalDocSearch-Token": token, "content-type": "application/json" },
            body: JSON.stringify({}),
          });
          return { status: result.status, data: await result.json() };
        })()`);
        expect(response.status === 202, `索引開始回應不是 202：${response.status}`);
        await click(cdp, "#settings-autoupdate");
        try {
          await waitFor(async () => {
            const current = await settingSnapshot(cdp);
            return current.auto?.ariaChecked === "true" && !current.auto?.disabled;
          }, 60_000);
        } catch (error) {
          const setting = await settingSnapshot(cdp);
          const index = await indexStatus(cdp);
          throw new Error(`索引中開啟背景更新逾時：${JSON.stringify({ setting, index })}；${errorText(error)}`);
        }
        const current = await indexStatus(cdp);
        expect(current?.autoupdate?.enabled === true, "索引進行中切換後 API autoupdate 沒有 enabled。");
        expect(current?.indexing && typeof current.indexing.state === "string", "索引進度狀態缺少 state。");
        await noBrowserErrorsSince(cdp, start, "索引進行中 Toggle Switch");
      } finally {
        try {
          const snapshot = await settingSnapshot(cdp);
          if (snapshot.auto?.ariaChecked === "true") {
            await click(cdp, "#settings-autoupdate");
            await waitFor(async () => (await settingSnapshot(cdp)).auto?.ariaChecked === "false", 30_000);
          }
          await waitFor(async () => (await indexStatus(cdp)).indexing?.state !== "running", 30_000);
        } catch { /* 失敗訊息由主斷言保留；工作台關閉時會停止合成索引。 */ }
        await cdp.evaluate("document.getElementById('settings-dialog')?.close()");
      }
    });


    await check(`${label} 多段落結果與上下文操作截圖已保存`, async () => {
      await click(cdp, "#nav-documents");
      await waitFor(() => visible(cdp, "#documents-page"));
      await setSearchMode(cdp, "all-terms");
      await inputAndSearch(cdp, "private node");
      await waitFor(() => cdp.evaluate(`Boolean(Array.from(document.querySelectorAll("#document-list .document-row")).find(node => node.querySelector(".document-title")?.textContent === "multi-passage-lines.txt"))`));
      const selected = await cdp.evaluate(`(() => {
        let count = 0;
        for (const title of ["single-passage.txt", "multi-passage-lines.txt"]) {
          const row = Array.from(document.querySelectorAll("#document-list .document-row")).find(node => node.querySelector(".document-title")?.textContent === title);
          const control = row?.querySelector('button[data-action="context"]');
          if (control instanceof HTMLElement && control.textContent === "加入上下文") { control.click(); count += 1; }
        }
        return count;
      })()`);
      expect(selected === 2, `截圖前無法加入兩個上下文檔案：${selected}`);
      await waitFor(() => cdp.evaluate("document.getElementById('nav-context-count')?.textContent === '2'"));
      const capture = async names => {
        const screenshot = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
        for (const name of names) {
          const file = path.join(outputDir, name);
          writeFileSync(file, Buffer.from(screenshot.result.data, "base64"));
          expect(existsSync(file) && readFileSync(file).length > 0, `找不到截圖檔案：${file}`);
          console.log(`  截圖：${file}`);
        }
      };
      if (viewport.width === 1920) {
        await click(cdp, "#view-table");
        await waitFor(() => cdp.evaluate("!document.getElementById('document-table-wrap')?.hidden"));
        await capture([`after-table-${label}.png`]);
        await click(cdp, "#view-list");
        await waitFor(() => visible(cdp, "#document-list"));
      }
      await capture([`ui-smoke-${label}.png`, `after-${label}.png`]);
    });
  } catch (error) {
    results.push({ status: "fail", label: `${label} 煙霧測試執行`, message: truncate(errorText(error)) });
    console.log(`[FAIL] ${label} 煙霧測試執行：${truncate(errorText(error))}`);
  } finally {
    let cleanupError;
    if (fixture) {
      try { stopCliAutoupdate(fixture); } catch (error) { cleanupError = error; console.error(`[CLEANUP] autoupdate stop 失敗：${errorText(error)}`); }
    }
    if (cdp) {
      try { await cdp.evaluate("document.getElementById('settings-dialog')?.close()"); } catch { /* 頁面已關閉 */ }
      try { cdp.close(); } catch (error) { cleanupError ??= error; }
    }
    try { await stopChrome(chrome, chromeProfile); } catch (error) { cleanupError ??= error; }
    try { await stopProcess(workbench?.child); } catch (error) { cleanupError ??= error; }
    try { if (fixture) await removeDirectory(fixture.temp, `fixture ${label}`); } catch (error) { cleanupError ??= error; }
    if (cleanupError) throw cleanupError;
  }
}

async function main() {
  if (typeof WebSocket !== "function") {
    throw new Error("目前 Node.js 沒有內建 WebSocket；請使用 Node.js 22 以上執行 UI 煙霧測試。");
  }
  if (!existsSync(cli)) {
    throw new Error("找不到 dist/src/cli.js；請先在此 worktree 執行 npm run build，再執行 node scripts/ui-smoke.mjs。");
  }
  const chromePath = findChrome();
  if (!chromePath) {
    throw new Error("找不到本機 Chrome／Chromium。請安裝 Google Chrome，或設定 SEEKAH_CHROME_PATH／CHROME_PATH 後重試；此煙霧測試需要本機瀏覽器，已以非 0 結束。");
  }
  console.log(`Chrome：${chromePath}`);
  console.log(`合成資料與暫存索引只會建立在暫存目錄；輸出目錄：${outputDir}`);
  let executionError;
  try {
    for (const viewport of [{ width: 1920, height: 1080 }, { width: 1440, height: 900 }, { width: 1180, height: 800 }]) {
      await runViewport(viewport, chromePath);
    }
  } catch (error) {
    executionError = error;
  }
  let processError;
  try { await assertNoSyntheticProcesses(); } catch (error) { processError = error; }
  if (executionError || processError) {
    throw new Error([executionError, processError].filter(Boolean).map(errorText).join("；"));
  }
  console.log("[PASS] smoke 暫存資料庫無殘留程序");
  const failed = results.filter(item => item.status === "fail");
  const passed = results.filter(item => item.status === "pass");
  const warnings = browserEvents.filter(event => !event.failure);
  console.log("\n== UI 煙霧測試結果 ==");
  console.log(`通過：${passed.length}`);
  console.log(`失敗：${failed.length}`);
  console.log(`截圖與輸出目錄：${outputDir}`);
  if (warnings.length) console.log(`瀏覽器非 error 警告／資訊事件：${warnings.length}`);
  console.log("通過清單：");
  for (const item of passed) console.log(`- ${item.label}`);
  console.log("失敗清單：");
  if (!failed.length) console.log("- （無）");
  for (const item of failed) console.log(`- ${item.label}：${item.message}`);
  if (failed.length) process.exitCode = 1;
}

try {
  await main();
} catch (error) {
  console.error(`UI 煙霧測試無法執行：${errorText(error)}`);
  console.error(`若訊息要求 Chrome，請確認本機 Chrome 路徑；輸出目錄（若已建立）：${outputDir}`);
  process.exitCode = 1;
}
