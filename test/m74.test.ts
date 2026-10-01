import assert from "node:assert/strict";
import test from "node:test";
import { workbenchHtml } from "../src/workbench-app.js";

function assertCopySelectionContract(html: string): void {
  assert.match(html, /\.document-title, \.document-title\.btn, \.table-title, \.table-title\.btn,[\s\S]*?-webkit-user-select\s*:\s*text;[\s\S]*?user-select\s*:\s*text;/u, "結果文字必須明確允許選取。");
  assert.match(html, /\.result-passage-label[\s\S]*?user-select\s*:\s*none;/u, "多段落位置／詞標籤可禁止選取，但結果文字不可被禁止。");
  assert.match(html, /function hasSelectionWithin\(element\)/u, "檔名開啟缺少 selection guard helper。");
  assert.match(html, /window\.getSelection\(\)/u, "檔名開啟缺少 Selection API 檢查。");
  assert.match(html, /range\.commonAncestorContainer/u, "selection guard 未檢查 range 共同祖先。");
  assert.match(html, /if \(element instanceof Element && hasSelectionWithin\(element\)\) return;/u, "檔名 click 未使用 selection guard。");
  assert.match(html, /copyControl\("複製路徑"/u, "缺少複製路徑按鈕。");
  assert.match(html, /copyControl\("複製檔名"/u, "缺少複製檔名按鈕。");
  assert.match(html, /navigator\.clipboard\.writeText/u, "缺少 Clipboard API 優先路徑。");
  assert.match(html, /document\.execCommand\("copy"\)/u, "缺少剪貼簿後備路徑。");
  assert.match(html, /setAttribute\("aria-live", "polite"\)/u, "複製回饋缺少 aria-live。");
  assert.match(html, /document\.createTextNode/u, "片段高亮必須使用安全 DOM 節點。");
  assert.doesNotMatch(html, /innerHTML|outerHTML|insertAdjacentHTML/u, "工作台不得以 HTML 字串插入結果文字。");
}

test("M74 workbench result text supports selection, guarded opening and clipboard controls", () => {
  assertCopySelectionContract(workbenchHtml("m74-nonce"));
});

test("M74 reverse checks fail when selection, copy or selectable-text contracts are removed", () => {
  const html = workbenchHtml("m74-reverse-nonce");
  const withoutGuard = html.replace(/\s*if \(element instanceof Element && hasSelectionWithin\(element\)\) return;/u, "");
  assert.throws(() => assertCopySelectionContract(withoutGuard), /selection guard/u);

  const withoutCopy = html.replace(/copyControl\("複製路徑", documentPathValue\(item\)\), copyControl\("複製檔名", documentFilenameValue\(item\)\)/u, "");
  assert.throws(() => assertCopySelectionContract(withoutCopy), /複製路徑|複製檔名/u);

  const withoutSelection = html.replace(/user-select: text;/u, "user-select: none;");
  assert.throws(() => assertCopySelectionContract(withoutSelection), /user-select|選取/u);
});
