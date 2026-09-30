import assert from "node:assert/strict";
import test from "node:test";
import { workbenchHtml } from "../src/workbench-app.js";

/**
 * 回歸：0.44.0 的排除可見性提交曾在初始 state 物件中誤刪 supportedExtensions、addRootDraft、
 * selectedRoots、selectedTrash，導致工作台載入時 `state.supportedExtensions.map` 丟 TypeError，
 * 畫面永遠停在「讀取中…」，選資料夾也失敗。靜態元素測試抓不到這類問題。
 */
function readStateLiteral(html: string): Set<string> {
  const match = /const state = \{([\s\S]*?)\n {2}\};/u.exec(html);
  assert.ok(match, "找不到工作台 state 初始物件");
  return new Set(Array.from(match[1]!.matchAll(/^\s{4}(\w+):/gmu), item => item[1]!));
}

test("0.44.0 workbench state declares every field that is read as a collection or measured before assignment", () => {
  const html = workbenchHtml("fixed-nonce");
  const declared = readStateLiteral(html);
  // 只要對某個 state 欄位呼叫集合方法或讀 length／size，就必須有初始值，否則初始化時會 TypeError。
  const collectionUse = /\bstate\.(\w+)\.(?:map|forEach|filter|some|every|find|join|slice|concat|includes|clear|add|has|delete|get|set|values|keys|entries|length|size)\b/gu;
  const offenders = new Set<string>();
  for (const item of html.matchAll(collectionUse)) {
    if (!declared.has(item[1]!)) offenders.add(item[1]!);
  }
  assert.deepEqual([...offenders].sort(), [], "這些 state 欄位被當成集合使用，但沒有在初始 state 宣告");
});

test("0.44.0 workbench state keeps the fields that 0.43.0 declared", () => {
  const declared = readStateLiteral(workbenchHtml("fixed-nonce"));
  for (const field of ["supportedExtensions", "addRootDraft", "selectedRoots", "selectedTrash", "selected", "imported", "indexStatus", "exclusions", "exclusionPreview", "exclusionPreviewReady"]) {
    assert.ok(declared.has(field), `state 缺少 ${field}`);
  }
});
