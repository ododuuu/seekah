import assert from "node:assert/strict";
import test from "node:test";
import { workbenchHtml } from "../src/workbench-app.js";

function assertPassageUiContract(html: string): void {
  assert.match(html, /function makeResultPassages\(item\)/u, "缺少結果多段落 helper。");
  assert.match(html, /Array\.isArray\(item && item\.passages\)/u, "結果列沒有安全讀取 passages。");
  assert.match(html, /if \(passages\.length > 1\) \{/u, "缺少多於一段才呈現的邊界。");
  assert.match(html, /make\("ul", "result-passages", ""\)/u, "多段落沒有使用清單語意。");
  assert.match(html, /make\("li", "result-passage", ""\)/u, "每個 passage 沒有使用 li。");
  assert.match(html, /list\.setAttribute\("aria-label", "搜尋命中段落"\)/u, "多段落清單缺少可及性名稱。");
  assert.match(html, /entry\.setAttribute\("aria-label"/u, "每個 passage 缺少可讀 aria label。");
  assert.match(html, /appendHighlighted\(snippet, snippetText, terms\)/u, "passage snippet 沒有使用詞標籤高亮。");
  assert.match(html, /還有 " \+ omittedTerms \+ " 個詞未列出/u, "缺少 omittedTerms 提示。");
  assert.match(html, /\.result-passage-label[\s\S]{0,260}-webkit-user-select: none;/u, "passage 標籤必須不可選取。");
  assert.match(html, /if \(passages\.length > 1\) row\.append\(passageBlock\);/u, "列表沒有以多段落取代單一代表片段。");
  assert.match(html, /if \(passageBlock\) titleCell\.append\(passageBlock\);/u, "表格沒有呈現多段落／省略提示。");
  assert.ok((html.match(/resultCopyActions\(item\)/gu) ?? []).length >= 2, "列表／表格既有複製控制不可移除。");
  assert.match(html, /document\.createTextNode/u, "多段落文字必須由安全 DOM 節點建立。");
  assert.doesNotMatch(html, /innerHTML|outerHTML|insertAdjacentHTML/u, "工作台不得以 HTML 字串插入結果文字。");
}

test("M78 workbench list and table render safe selectable multi-passage results", () => {
  assertPassageUiContract(workbenchHtml("m78-nonce"));
});

test("M78 reverse checks fail when multi-passage UI contracts are removed", () => {
  const html = workbenchHtml("m78-reverse-nonce");
  const withoutBoundary = html.replace(/if \(passages\.length > 1\) row\.append\(passageBlock\);/u, "row.append(passageBlock);");
  assert.throws(() => assertPassageUiContract(withoutBoundary), /多段落|代表片段/u);

  const withoutListSemantics = html.replace(/make\("ul", "result-passages", ""\)/u, "make(\"div\", \"result-passages\", \"\")");
  assert.throws(() => assertPassageUiContract(withoutListSemantics), /清單|li/u);

  const withoutOmittedNotice = html.replace(/還有 " \+ omittedTerms \+ " 個詞未列出/u, "已省略");
  assert.throws(() => assertPassageUiContract(withoutOmittedNotice), /omittedTerms/u);

  const withoutLabelSelectionBoundary = html.replace(/-webkit-user-select: none;/u, "-webkit-user-select: text;");
  assert.throws(() => assertPassageUiContract(withoutLabelSelectionBoundary), /不可選取/u);
});
