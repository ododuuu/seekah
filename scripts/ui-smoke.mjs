import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(project, "dist", "src", "cli.js");
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const outputDir = mkdtempSync(path.join(os.tmpdir(), "seekah-ui-smoke-output-"));
const results = [];
const browserEvents = [];

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
  child.kill();
  await Promise.race([waitForExit(child), sleep(2_000)]);
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
  const root = path.join(temp, "synthetic-root");
  const dataDir = path.join(temp, "data");
  const refreshFolder = path.join(root, "refresh-area");
  await mkdir(path.join(root, "excluded"), { recursive: true });
  await mkdir(path.join(refreshFolder, "ignored"), { recursive: true });
  await writeFile(path.join(root, ".localdocsearchignore"), "excluded/\nrefresh-area/ignored/\n");
  await writeFile(path.join(root, "included.txt"), "UI_SMOKE_INCLUDED_NEEDLE\n一般合成文件。\n");
  await writeFile(path.join(root, "ordinary.md"), "普通文件，不含測試查詢。\n");
  await writeFile(path.join(root, "excluded", "secret.txt"), "UI_SMOKE_EXCLUDED_SECRET\n");
  await writeFile(path.join(refreshFolder, "refresh-existing.txt"), "UI_SMOKE_REFRESH_BEFORE\n");
  await writeFile(path.join(refreshFolder, "refresh-removed.txt"), "UI_SMOKE_REFRESH_REMOVED\n");
  await writeFile(path.join(refreshFolder, "ignored", "skip.txt"), "UI_SMOKE_IGNORED\n");
  runIndex(root, dataDir);
  return {
    temp,
    root,
    dataDir,
    refreshFolder,
    indexedPath: path.join(root, "included.txt"),
    excludedPath: path.join(root, "excluded", "secret.txt"),
    outsidePath: path.join(temp, "outside-root.txt"),
  };
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

function startCliAutoupdate(fixture) {
  const result = spawnSync(process.execPath, [cli, "autoupdate", "start", "--data-dir", fixture.dataDir], {
    cwd: project,
    encoding: "utf8",
    timeout: 30_000,
    windowsHide: true,
    env: syntheticEnvironment(fixture),
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`CLI autoupdate start 結束碼 ${result.status ?? "未知"}：${truncate(result.stderr || result.stdout, 1_200)}`);
}

function startWorkbench(dataDir, temp) {
  const child = spawn(process.execPath, [cli, "ui", "--no-open"], {
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
    window.__uiSmoke = {
      selectRoot: null,
      requests: [],
      failNextAutoupdate: false,
      delayNextSettingsMs: 0,
      delayNextIndexStatusMs: 0,
    };
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
      if (requestPath === "/api/settings" && body?.autoupdateEnabled !== undefined && window.__uiSmoke.failNextAutoupdate) {
        window.__uiSmoke.failNextAutoupdate = false;
        const response = new Response(JSON.stringify({ error: "煙霧測試模擬設定失敗。" }), { status: 503, headers: { "content-type": "application/json" } });
        const delay = Number(window.__uiSmoke.delayNextSettingsMs) || 0;
        window.__uiSmoke.delayNextSettingsMs = 0;
        return delay ? await new Promise(resolve => setTimeout(() => resolve(response), delay)) : response;
      }
      if (requestPath === "/api/index-status" && Number(window.__uiSmoke.delayNextIndexStatusMs) > 0) {
        const delay = Number(window.__uiSmoke.delayNextIndexStatusMs);
        window.__uiSmoke.delayNextIndexStatusMs = 0;
        const response = await originalFetch(input, init);
        return await new Promise(resolve => setTimeout(() => resolve(response), delay));
      }
      return originalFetch(input, init);
    };
    return true;
  })()`);
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
  await cdp.evaluate(`(() => { window.__uiSmoke.selectRoot = ${JSON.stringify(root)}; window.__uiSmoke.requests = []; return true; })()`);
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
    workbench = startWorkbench(fixture.dataDir, fixture.temp);
    const url = await waitForWorkbench(workbench);
    port = await unusedPort();
    chromeProfile = await mkdtemp(path.join(outputDir, `chrome-${label}-`));
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
        await waitFor(async () => {
          const current = await settingSnapshot(cdp);
          return current.auto?.ariaChecked === "true" && !current.auto?.disabled;
        }, 30_000);
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


    await check(`${label} 截圖已保存`, async () => {
      await click(cdp, "#nav-documents");
      await waitFor(() => visible(cdp, "#documents-page"));
      await inputAndSearch(cdp, "UI_SMOKE_INCLUDED_NEEDLE");
      await waitFor(() => cdp.evaluate("document.querySelectorAll('#document-list .document-row').length > 0"));
      const screenshot = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
      const file = path.join(outputDir, `ui-smoke-${label}.png`);
      writeFileSync(file, Buffer.from(screenshot.result.data, "base64"));
      expect(existsSync(file) && readFileSync(file).length > 0, `找不到截圖檔案：${file}`);
      console.log(`  截圖：${file}`);
    });
  } catch (error) {
    results.push({ status: "fail", label: `${label} 煙霧測試執行`, message: truncate(errorText(error)) });
    console.log(`[FAIL] ${label} 煙霧測試執行：${truncate(errorText(error))}`);
  } finally {
    if (cdp) {
      try { await settingsPost(cdp, { autoupdateEnabled: false }); } catch { /* 合成 daemon 已停止或頁面已關閉。 */ }
      await sleep(3_000);
      cdp.close();
    }
    await stopProcess(chrome);
    await stopProcess(workbench?.child);
    if (chromeProfile) await rm(chromeProfile, { recursive: true, force: true });
    if (fixture) await rm(fixture.temp, { recursive: true, force: true });
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
  for (const viewport of [{ width: 1440, height: 900 }, { width: 1180, height: 800 }]) {
    await runViewport(viewport, chromePath);
  }
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
