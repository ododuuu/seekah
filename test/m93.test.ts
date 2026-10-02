import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const workbenchSource = readFileSync(path.resolve("src/workbench-app.ts"), "utf8");
const smokeSource = readFileSync(path.resolve("scripts/ui-smoke.mjs"), "utf8");

function assertLibraryContract(source: string, smoke: string): void {
  for (const id of [
    "nav-library-recent", "nav-library-pinned", "nav-library-groups", "nav-library-saved-searches",
    "library-recent-page", "library-pinned-page", "library-groups-page", "library-saved-searches-page",
    "library-create-group", "library-save-search",
  ]) {
    assert.match(source, new RegExp(id, "u"), `文件庫 UI 缺少 ${id}。`);
  }
  for (const route of ["library-recent", "library-pinned", "library-groups", "library-saved-searches"]) {
    assert.match(source, new RegExp(`navigate\\("${route}"\\)`), `文件庫沒有 ${route} 導覽。`);
    assert.match(source, new RegExp(`dataset\\.page = "${route}"`), `文件庫沒有 ${route} 頁面。`);
  }
  for (const endpoint of [
    "/api/library/recent", "/api/library/pinned", "/api/library/groups", "/api/library/saved-searches",
  ]) assert.match(source, new RegExp(endpoint, "u"), `文件庫沒有呼叫 ${endpoint}。`);
  assert.match(source, /void recordLibraryAction\(item, "select"\)/u, "結果選取沒有記錄最近文件。");
  assert.match(source, /function runSavedSearch\(item\)/u, "已存搜尋沒有重新執行函式。");
  assert.match(source, /void search\(1\)/u, "已存搜尋沒有沿用既有搜尋入口。");
  for (const selector of [
    "nav-library-recent", "nav-library-pinned", "nav-library-groups", "nav-library-saved-searches",
    "library-create-group", "library-save-search",
  ]) assert.match(smoke, new RegExp(selector, "u"), `UI smoke 沒有涵蓋 ${selector}。`);
  assert.match(smoke, /重新搜尋/u, "UI smoke 沒有驗證已存搜尋重新執行。");
}

test("M93 工作台文件庫導覽、操作與已存搜尋重新執行契約存在", () => {
  assertLibraryContract(workbenchSource, smokeSource);
});

test("M93 reverse 移除文件庫導覽或選取接線時契約必須失敗", () => {
  const withoutNav = workbenchSource.replaceAll("nav-library-recent", "nav-library-missing");
  assert.throws(() => assertLibraryContract(withoutNav, smokeSource), /文件庫 UI|導覽/u);

  const withoutSelectionEvent = workbenchSource.replaceAll('void recordLibraryAction(item, "select");', "");
  assert.throws(() => assertLibraryContract(withoutSelectionEvent, smokeSource), /選取|最近/u);

  const withoutSmoke = smokeSource.replaceAll("nav-library-recent", "nav-library-missing");
  assert.throws(() => assertLibraryContract(workbenchSource, withoutSmoke), /smoke|涵蓋/u);
});
