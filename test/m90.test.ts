import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const workbenchSource = readFileSync(path.resolve("src/workbench-app.ts"), "utf8");
const smokeSource = readFileSync(path.resolve("scripts/ui-smoke.mjs"), "utf8");

function assertActionContract(source: string, smoke: string = smokeSource): void {
  for (const label of ["開啟", "顯示所在位置", "Pin", "加入分類", "加入上下文", "複製路徑", "複製檔名"]) {
    assert.match(source, new RegExp(label, "u"), `結果操作缺少 ${label}。`);
  }
  assert.match(source, /function resultActions\(item\)/u, "缺少共用結果操作群組。");
  assert.match(source, /make\("div", "document-actions"\)/u, "結果操作沒有共用群組容器。");
  assert.match(source, /\.result-action\.btn \{ min-height: 28px/u, "結果操作按鈕沒有一致樣式。");
  assert.doesNotMatch(source, /\.link-action\s*\{/u, "仍殘留無框文字連結操作樣式。");
  assert.match(source, /open\.dataset\.action = "open"/u, "缺少開啟 action。");
  assert.match(source, /reveal\.dataset\.action = "reveal"/u, "缺少顯示所在位置 action。");
  assert.match(source, /pin\.dataset\.action = "pin"/u, "缺少 Pin action。");
  assert.match(source, /group\.dataset\.action = "group"/u, "缺少分類 action。");
  assert.match(source, /toggle\.dataset\.action = "context"/u, "缺少上下文 action。");
  assert.match(source, /\/api\/library\/pins/u, "缺少 Pin API 呼叫點。");
  assert.match(source, /\/api\/library\/groups/u, "缺少分類 API 呼叫點。");
  assert.match(source, /method: "POST"/u, "library API 沒有使用 POST。");
  assert.match(source, /pinned: true/u, "Pin payload 沒有明確 pinned true。");
  assert.match(source, /const actionsCell = make\("td", "document-actions-cell", ""\)/u, "表格沒有獨立操作欄。");
  assert.match(source, /row\.append\(checkCell, titleCell, rootCell, formatCell, locationCell, statusCell, actionsCell\)/u, "表格列沒有把操作放在第七欄。");
  assert.match(source, /cell\.colSpan = 7/u, "表格空狀態沒有同步七欄。");
  assert.match(source, /\["選取", "標題", "根目錄", "格式", "命中位置", "狀態", "操作"\]/u, "表頭沒有操作欄。");
  assert.match(smoke, /expectedLabels = \["複製路徑", "複製檔名", "開啟", "顯示所在位置", "Pin", "加入分類", "加入上下文"\]/u, "UI smoke 沒有驗證完整操作群組。");
  assert.match(smoke, /libraryActions\.length === 2/u, "UI smoke 沒有驗證兩個 library POST。");
  assert.match(smoke, /titleCopyButtons === 0/u, "UI smoke 沒有驗證表格標題欄不擁擠。");
  assert.match(smoke, /hasStandaloneDot/u, "UI smoke 沒有驗證勾選欄多餘句點。");
}

test("M90 列表／表格一致快捷操作與 library API 契約", () => {
  assertActionContract(workbenchSource);
});

test("M90 reverse 移除操作、獨立欄或 API 呼叫點時必須失敗", () => {
  assertActionContract(workbenchSource);

  const withoutPin = workbenchSource.replace(/const pin = button\("Pin"[\s\S]*?pin\.dataset\.action = "pin";/u, "const removedPin = null;");
  assert.throws(() => assertActionContract(withoutPin), /Pin|action/u);

  const withoutGroupApi = workbenchSource.replace(/\/api\/library\/groups/gu, "/api/removed/groups");
  assert.throws(() => assertActionContract(withoutGroupApi), /分類|API/u);

  const titleCrowded = workbenchSource.replace(/const actionsCell = make\("td", "document-actions-cell", ""\)/u, "const actionsCell = document.createElement(\"td\");");
  assert.throws(() => assertActionContract(titleCrowded), /獨立|操作欄/u);

  const sixColumns = workbenchSource.replace(/cell\.colSpan = 7/u, "cell.colSpan = 6");
  assert.throws(() => assertActionContract(sixColumns), /七欄/u);

  const withoutSmokeLibrary = smokeSource.replace(/libraryActions\.length === 2/u, "libraryActions.length === 1");
  assert.throws(() => assertActionContract(workbenchSource, withoutSmokeLibrary), /library POST/u);
});
