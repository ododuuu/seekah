import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const smokeScript = readFileSync(path.resolve("scripts", "ui-smoke.mjs"), "utf8");
const workbenchSource = readFileSync(path.resolve("src", "workbench-app.ts"), "utf8");

test("M72 UI smoke uses isolated synthetic data and the real CLI index path", () => {
  assert.match(smokeScript, /spawnSync\(process\.execPath, \[cli, "index", root\]/u);
  assert.match(smokeScript, /LOCALDOCSEARCH_DATA_DIR: dataDir/u);
  assert.match(smokeScript, /synthetic-root/u);
  assert.match(smokeScript, /\.localdocsearchignore/u);
  assert.doesNotMatch(smokeScript, /LocalDocSearch-backup-/u);
  assert.doesNotMatch(smokeScript, /C:\\\\Users\\\\mains\\\\AppData\\\\Local\\\\LocalDocSearch/u);
});

test("M72 UI smoke observes browser failures, checks both viewports and saves screenshots", () => {
  for (const marker of [
    "Runtime.exceptionThrown",
    "Runtime.consoleAPICalled",
    "Log.entryAdded",
    'await cdp.send("Runtime.enable")',
    'await cdp.send("Log.enable")',
    'Page.captureScreenshot',
    '"--headless=new"',
    "1440, height: 900",
    "1180, height: 800",
  ]) assert.match(smokeScript, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"), `煙霧腳本缺少 ${marker}`);
  assert.match(smokeScript, /找不到本機 Chrome／Chromium/u);
  assert.match(smokeScript, /process\.exitCode = 1/u);
});

test("M72 narrow desktop keeps the search toolbar controls readable at 1180px", () => {
  assert.match(workbenchSource, /@media \(max-width: 1320px\) \{[\s\S]*?\.topbar \{ grid-template-columns: 204px minmax\(300px, 1fr\) auto; gap: 18px; \}[\s\S]*?\.document-query \{ flex: 1 1 300px; \}[\s\S]*?\.document-query select, \.scope-summary select \{ max-width: 126px; \}/u);
});
