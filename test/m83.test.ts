import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const workbenchSource = readFileSync(path.resolve("src/workbench-app.ts"), "utf8");
const smokeSource = readFileSync(path.resolve("scripts/ui-smoke.mjs"), "utf8");

function assertThemeContract(source: string): void {
  assert.match(source, /const THEME_MODES = Object\.freeze\(\["auto", "light", "dark"\]\)/u, "主題狀態順序或白名單遺失。");
  assert.match(source, /theme-button/u, "頂列沒有主題按鈕。");
  assert.match(source, /const THEME_LABELS = Object\.freeze\(\{ auto: "自動", light: "淺色", dark: "深色" \}\)/u, "主題中文標籤遺失。");
  assert.match(source, /document\.documentElement\.dataset\.theme = next/u, "主題沒有套用到 document root。");
  assert.match(source, /history\.replaceState\(null, "", url\.pathname \+ url\.search \+ url\.hash\)/u, "主題沒有透過 URL query 保存且保留 fragment。");
  assert.match(source, /const value = new URL\(location\.href\)\.searchParams\.get\("theme"\)/u, "主題沒有從 URL query 讀取。");
  assert.match(source, /applyTheme\(readThemeMode\(\), false\)/u, "初始主題沒有在工作台建立後套用。");
  assert.match(source, /:root\[data-theme="light"\]/u, "缺少 explicit light CSS。");
  assert.match(source, /:root\[data-theme="dark"\]/u, "缺少 explicit dark CSS。");
  assert.match(source, /@media \(prefers-color-scheme: dark\)/u, "缺少 auto 系統偏好 CSS。");
  assert.match(smokeSource, /theme-button/u, "UI smoke 沒有實際操作主題按鈕。");
  assert.match(smokeSource, /width: 1920, height: 1080/u, "UI smoke 沒有驗證 1920 桌面寬度。");
  assert.match(smokeSource, /reloadWorkbench\(cdp\)/u, "UI smoke 沒有驗證重新載入後主題偏好。");
  assert.match(smokeSource, /token fragment 保留/u, "UI smoke 沒有驗證 token fragment 保留。");
  assert.doesNotMatch(source, /localStorage|sessionStorage|document\.cookie|indexedDB/iu, "主題實作不可使用 browser storage。");

}

test("M83 workbench 主題使用 auto/light/dark 白名單並保留 token fragment", () => {
  assertThemeContract(workbenchSource);
});

test("M83 reverse 移除主題狀態、root 套用或 query 保存時契約必須失敗", () => {
  const withoutModes = workbenchSource.replace(/const THEME_MODES = Object\.freeze\(\["auto", "light", "dark"\]\)/u, "const THEME_MODES = Object.freeze([\"auto\"])");
  assert.throws(() => assertThemeContract(withoutModes), /主題|theme/u);

  const withoutRootApply = workbenchSource.replace(/document\.documentElement\.dataset\.theme = next/u, "state.themeMode = next");
  assert.throws(() => assertThemeContract(withoutRootApply), /root|套用/u);

  const withoutUrlPersistence = workbenchSource.replace(/history\.replaceState\(null, "", url\.pathname \+ url\.search \+ url\.hash\)/u, "location.href = url.href");
  assert.throws(() => assertThemeContract(withoutUrlPersistence), /URL|保存|fragment/u);
});
