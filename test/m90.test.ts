import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const workbenchSource = readFileSync(path.resolve("src/workbench-app.ts"), "utf8");
const smokeSource = readFileSync(path.resolve("scripts/ui-smoke.mjs"), "utf8");

function assertActionContract(source: string, smoke: string = smokeSource): void {
  for (const label of ["開啟", "顯示所在位置", "釘選", "取消釘選", "加入分類", "加入上下文", "複製路徑", "複製檔名"]) {
    assert.match(source, new RegExp(label, "u"), `結果操作缺少 ${label}。`);
  }
  assert.match(source, /function resultActions\(item\)/u, "缺少共用結果操作群組。");
  assert.match(source, /make\("div", "document-actions"\)/u, "結果操作沒有共用群組容器。");
  assert.match(source, /\.copy-actions \{ display: contents; \}/u, "複製控制仍被包成第二組操作列。");
  assert.match(source, /\.document-actions \{[\s\S]*?flex-wrap: nowrap;[\s\S]*?gap: 6px/u, "結果操作列沒有單列與統一 gap。");
  assert.match(source, /\.document-actions \.btn \{ flex: 0 0 auto; height: 30px; min-height: 30px; \}/u, "結果操作按鈕沒有統一高度。");
  assert.doesNotMatch(source, /\.link-action\s*\{/u, "仍殘留無框文字連結操作樣式。");
  assert.match(source, /open\.dataset\.action = "open"/u, "缺少開啟 action。");
  assert.match(source, /reveal\.dataset\.action = "reveal"/u, "缺少顯示所在位置 action。");
  assert.match(source, /const pinned = isLibraryPinned\(item\)/u, "釘選按鈕沒有讀取目前狀態。");
  assert.match(source, /pinned \? "取消釘選" : "釘選"/u, "釘選按鈕沒有依狀態切換中文文案。");
  assert.match(source, /pin\.dataset\.action = "pin"/u, "缺少釘選 action。");
  assert.match(source, /group\.dataset\.action = "group"/u, "缺少分類 action。");
  assert.match(source, /toggle\.dataset\.action = "context"/u, "缺少上下文 action。");
  assert.match(source, /\/api\/library\/pinned/u, "缺少釘選 API 呼叫點。");
  assert.match(source, /\/api\/library\/groups\/" \+ encodeURIComponent[\s\S]*? \+ "\/items/u, "缺少分類 items API 呼叫點。");
  assert.match(source, /method: "POST"/u, "library API 沒有使用 POST。");
  assert.match(source, /const pinned = action === "pin" \? !isLibraryPinned\(item\)/u, "釘選 payload 沒有反映切換狀態。");
  assert.match(source, /const method = action === "pin" \? \(pinned \? "PUT" : "DELETE"\) : "POST"/u, "釘選沒有使用 pi2 PUT／DELETE API。");
  assert.match(source, /const requestBody = action === "pin" && !pinned/u, "取消釘選沒有使用 pi2 identity payload。");
  assert.match(source, /pendingPinned\.set\(mutation\.key, mutation\);\s*applyPinnedState\(body, pinned\)/u, "釘選切換沒有先更新本機狀態。");
  assert.match(source, /libraryActionChain = libraryActionChain\.then\(operation, operation\)/u, "釘選／分類操作沒有依序執行。");
  assert.match(source, /await refreshLibrary\(\);[\s\S]*?pendingPinned\.delete\(mutation\.key\)/u, "釘選 API 成功後沒有同步並解除暫存狀態。");
  assert.match(source, /sortMode: "relevance"/u, "排序沒有預設目前結果：相關性。");
  assert.match(source, /grid-template-columns: fit-content\(110px\)/u, "多段落標籤欄沒有縮至內容寬度上限。");
  assert.match(source, /max-width: none/u, "列表結果區仍固定 max-width。");
  assert.match(source, /--context-width: 320px/u, "上下文欄沒有固定約 320px。");
  assert.match(source, /const actionsCell = make\("td", "document-actions-cell", ""\)/u, "表格沒有獨立操作欄。");
  assert.match(source, /row\.append\(checkCell, titleCell, rootCell, formatCell, locationCell, statusCell, actionsCell\)/u, "表格列沒有把操作放在第七欄。");
  assert.match(source, /cell\.colSpan = 7/u, "表格空狀態沒有同步七欄。");
  assert.match(source, /\["選取", "標題", "根目錄", "格式", "命中位置", "狀態", "操作"\]/u, "表頭沒有操作欄。");
  assert.match(source, /min-width: 1240px/u, "表格寬度不足以容納完整操作列。");
  assert.match(source, /\.documents-table th:nth-child\(7\) \{ width: 480px; \}/u, "表格操作欄沒有保留完整操作列寬度。");
  assert.match(smoke, /expectedLabels = \["複製路徑", "複製檔名", "開啟", "顯示所在位置", "釘選", "加入分類", "加入上下文"\]/u, "UI smoke 沒有驗證完整操作群組。");
  assert.match(smoke, /libraryActions\.length === 3/u, "UI smoke 沒有驗證 pi2 釘選／取消釘選與分類 POST。");
  assert.match(smoke, /document-sort.*selectedOptions/u, "UI smoke 沒有驗證排序下拉文字。");
  assert.match(smoke, /titleCopyButtons === 0/u, "UI smoke 沒有驗證表格標題欄不擁擠。");
  assert.match(smoke, /hasStandaloneDot/u, "UI smoke 沒有驗證勾選欄多餘句點。");
}

test("M90 列表／表格一致快捷操作與 library API 契約", () => {
  assertActionContract(workbenchSource);
});

test("M90 reverse 移除操作、獨立欄或 API 呼叫點時必須失敗", () => {
  assertActionContract(workbenchSource);

  const withoutPin = workbenchSource.replace(/const pinned = isLibraryPinned\(item\);[\s\S]*?pin\.dataset\.action = "pin";/u, "const removedPin = null;");
  assert.throws(() => assertActionContract(withoutPin), /釘選|action/u);
  const withoutOptimisticPin = workbenchSource.replace(/pendingPinned\.set\(mutation\.key, mutation\);\s*applyPinnedState\(body, pinned\)/u, "const removedOptimisticPin = null;");
  assert.throws(() => assertActionContract(withoutOptimisticPin), /本機|切換/u);

  const withoutGroupApi = workbenchSource.replace(/\/api\/library\/groups/gu, "/api/removed/groups");
  assert.throws(() => assertActionContract(withoutGroupApi), /分類|API/u);

  const withoutSort = workbenchSource.replace(/sortMode: "relevance"/u, "sortMode: \"removed\"");
  assert.throws(() => assertActionContract(withoutSort), /排序/u);

  const groupedCopy = workbenchSource.replace(/\.copy-actions \{ display: contents; \}/u, ".copy-actions { display: inline-flex; }");
  assert.throws(() => assertActionContract(groupedCopy), /第二組|操作列/u);

  const titleCrowded = workbenchSource.replace(/const actionsCell = make\("td", "document-actions-cell", ""\)/u, "const actionsCell = document.createElement(\"td\");");
  assert.throws(() => assertActionContract(titleCrowded), /獨立|操作欄/u);

  const sixColumns = workbenchSource.replace(/cell\.colSpan = 7/u, "cell.colSpan = 6");
  assert.throws(() => assertActionContract(sixColumns), /七欄/u);

  const withoutSmokeLibrary = smokeSource.replace(/libraryActions\.length === 3/u, "libraryActions.length === 2");
  assert.throws(() => assertActionContract(workbenchSource, withoutSmokeLibrary), /釘選|library POST/u);
});
