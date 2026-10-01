import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const workbenchSource = readFileSync(path.resolve("src/workbench-app.ts"), "utf8");
const smokeSource = readFileSync(path.resolve("scripts/ui-smoke.mjs"), "utf8");

function section(source: string, start: string, end: string): string {
  const startAt = source.indexOf(start);
  const endAt = source.indexOf(end, startAt + start.length);
  assert.ok(startAt >= 0, `找不到區段起點：${start}`);
  assert.ok(endAt > startAt, `找不到區段終點：${end}`);
  return source.slice(startAt, endAt);
}

test("M75 settings 布林控制使用 Toggle Switch 而不是 checkbox", () => {
  const settingsDom = section(workbenchSource, "const settingsDialog =", "const exclusionPolicySection =");
  for (const id of [
    "settings-delete-confirmation",
    "settings-autoupdate",
    "settings-autoupdate-startup",
    "settings-total-exact",
  ]) {
    assert.match(settingsDom, new RegExp(`settingSwitch\\(\\"${id}\\"`), `${id} 沒有使用共用 Toggle Switch。`);
  }
  assert.doesNotMatch(settingsDom, /type\s*=\s*["']checkbox["']/u, "設定頁布林控制仍殘留 checkbox。\n" + settingsDom);
  assert.match(workbenchSource, /node\.type = "button"/u);
  assert.match(workbenchSource, /node\.setAttribute\("role", "switch"\)/u);
  assert.match(workbenchSource, /node\.setAttribute\("aria-checked", "false"\)/u);
  assert.match(workbenchSource, /node\.setAttribute\("aria-labelledby", labelId\)/u);
  assert.match(workbenchSource, /node\.setAttribute\("aria-describedby", stateText\.id\)/u);
});

test("M75 Toggle Switch 提供鍵盤、狀態文字、淺深色與 focus 視覺契約", () => {
  assert.match(workbenchSource, /event\.key !== " " && event\.key !== "Enter"/u);
  assert.match(workbenchSource, /event\.preventDefault\(\);[\s\S]{0,100}node\.click\(\)/u);
  assert.match(workbenchSource, /busy \? "處理中…" : enabled \? "已開啟" : "已關閉"/u);
  assert.match(workbenchSource, /\.setting-switch\[aria-checked="true"\]/u);
  assert.match(workbenchSource, /\.setting-switch::after/u);
  assert.match(workbenchSource, /@media \(prefers-color-scheme: dark\)/u);
  assert.match(workbenchSource, /\.setting-switch:focus-visible/u);
});

test("M75 背景更新切換直接採用 POST response 並保護 stale refresh", () => {
  const autoSave = section(workbenchSource, "async function saveAutoupdate(enabled)", "async function saveAutoupdateStartup(enabled)");
  const startupSave = section(workbenchSource, "async function saveAutoupdateStartup(enabled)", "async function saveAutoupdateParameters()");
  assert.match(autoSave, /state\.autoupdateSaving = true/u);
  assert.match(autoSave, /applyAutoupdateResponse\(data\)/u);
  assert.doesNotMatch(autoSave, /await refreshStatus\(\)/u, "背景更新切換仍等待 refreshStatus。\n" + autoSave);
  assert.match(autoSave, /const previous = state\.autoupdateEnabled/u);
  assert.match(autoSave, /state\.autoupdateEnabled = previous/u);
  assert.match(startupSave, /state\.autoupdateStartupSaving = true/u);
  assert.match(startupSave, /applyAutoupdateStartupResponse\(data\)/u);
  assert.doesNotMatch(startupSave, /await refreshStatus\(\)/u, "登入啟動切換仍等待 refreshStatus。\n" + startupSave);
  assert.match(startupSave, /const previous = state\.autoupdateStartupEnabled/u);
  assert.match(startupSave, /state\.autoupdateStartupEnabled = previous/u);
  assert.match(workbenchSource, /statusRevision: 0/u);
  assert.match(workbenchSource, /preserveSettingResponses\(indexStatus, revision\)/u);
  assert.match(workbenchSource, /revision !== state\.statusRevision/u);
  assert.match(workbenchSource, /current\.autoupdate\s*\?/u);
});

test("M75 UI smoke 以隔離資料驗證狀態、API parity、處理中與失敗回復", () => {
  assert.match(smokeSource, /APPDATA: path\.join\(temp, "appdata"\)/u);
  assert.match(smokeSource, /function settingSnapshot\(cdp\)/u);
  assert.match(smokeSource, /ariaChecked/u);
  assert.match(smokeSource, /處理中…/u);
  assert.match(smokeSource, /indexStatus\(cdp\)/u);
  assert.match(smokeSource, /failNextAutoupdate/u);
  assert.match(smokeSource, /煙霧測試模擬設定失敗/u);
  assert.match(smokeSource, /delayNextIndexStatusMs = 2500/u);
  assert.match(smokeSource, /autoupdate\?\.enabled === true/u);
  assert.match(smokeSource, /autoupdate\?\.enabled === false/u);
  assert.match(smokeSource, /startCliAutoupdate/u);
  assert.match(smokeSource, /前景 watch 拒絕遠端關閉/u);
  assert.match(smokeSource, /prepareIndexingFixture/u);
  assert.match(smokeSource, /noBrowserErrorsExcept/u);
});
