import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const workbenchSource = readFileSync(path.resolve("src/workbench-app.ts"), "utf8");
const smokeSource = readFileSync(path.resolve("scripts/ui-smoke.mjs"), "utf8");

function assertContextContract(source: string, smoke: string = smokeSource): void {
  assert.match(source, /--context-width: 338px/u, "桌面上下文側欄沒有固定寬度。");
  assert.match(source, /grid-template-columns: var\(--sidebar-width\) minmax\(0, 1fr\) var\(--context-width\)/u, "工作台沒有右側第三欄。");
  assert.match(source, /\.app-shell\.context-panel-collapsed\s*\{\s*grid-template-columns:\s*var\(--sidebar-width\)\s+minmax\(0, 1fr\)\s+0;\s*\}/u, "上下文側欄沒有可收合版面。");
  assert.match(source, /\.context-panel \{/u, "缺少常駐上下文側欄樣式。");
  assert.match(source, /contextPanelCollapsed/u, "缺少 session-local 收合狀態。");
  assert.match(source, /function contextPathValues\(\)/u, "缺少路徑清單產生器。");
  assert.match(source, /function isAbsoluteDocumentPath\(value\)/u, "缺少絕對路徑驗證。");
  assert.match(source, /!paths\.includes\(path\)/u, "路徑清單沒有去重。");
  assert.match(source, /paths\.join\("\\\\n"\)/u, "路徑 prompt 沒有每行一個路徑。");
  assert.match(source, /function copyContextPaths\(\)/u, "缺少複製全部路徑操作。");
  assert.match(source, /context-copy-paths/u, "缺少側欄複製按鈕。");
  assert.match(source, /copy-context-paths/u, "缺少結果頁批次複製按鈕。");
  assert.match(source, /未自動送出/u, "沒有明確禁止自動送出。");
  assert.match(source, /context-indexed-list/u, "缺少索引文件側欄清單。");
  assert.match(source, /context-temporary-list/u, "缺少臨時文件側欄清單。");
  assert.match(source, /item\.selected && item\.status === "indexed"/u, "臨時文件沒有排除不可用路徑。");
  assert.doesNotMatch(source, /context-close/u, "仍殘留遮罩抽屜關閉控制。");
  assert.doesNotMatch(source, /const scrim =/u, "仍殘留上下文遮罩。");
  assert.match(smoke, /context-panel-collapsed/u, "UI smoke 沒有驗證側欄收合。");
  assert.match(smoke, /context-copy-paths/u, "UI smoke 沒有驗證側欄複製。");
  assert.match(smoke, /clipboardText === \$\{JSON\.stringify\(fixture\.multiPath\)\}/u, "UI smoke 沒有驗證純絕對路徑剪貼簿。");
  assert.match(smoke, /#context-clear-selection/u, "UI smoke 沒有驗證側欄清空選取。");
}

test("M89 上下文常駐側欄與純路徑 prompt 契約", () => {
  assertContextContract(workbenchSource);
});

test("M89 reverse 移除路徑純文字、側欄或收合契約時必須失敗", () => {
  assertContextContract(workbenchSource);

  const withoutPathJoin = workbenchSource.replace(/paths\.join\("\\\\n"\)/u, "paths.join(\",\")");
  assert.throws(() => assertContextContract(withoutPathJoin), /每行|prompt/u);

  const withoutPanel = workbenchSource.replaceAll("context-panel", "legacy-context");
  assert.throws(() => assertContextContract(withoutPanel), /側欄|第三欄/u);

  const withoutCollapse = workbenchSource.replaceAll("contextPanelCollapsed", "legacyPanelState");
  assert.throws(() => assertContextContract(withoutCollapse), /session-local|收合/u);

  const withoutSmokeCopy = smokeSource.replaceAll("context-copy-paths", "removed-context-copy");
  assert.throws(() => assertContextContract(workbenchSource, withoutSmokeCopy), /UI smoke|複製/u);
});
