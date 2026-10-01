import assert from "node:assert/strict";
import { execFile as nodeExecFile } from "node:child_process";
import test from "node:test";
import { promisify } from "node:util";
import { decodePickerOutput, pickerOutputStatement } from "../src/folder-picker.js";

const execFile = promisify(nodeExecFile);

/**
 * 回歸：資料夾選擇器曾直接用 `[Console]::Out.Write(路徑)` 輸出，從 Node 隱藏視窗啟動 PowerShell 時
 * 輸出為 OEM 字碼頁（繁體中文 Windows 是 CP950），再以 UTF-8 解碼，`D:\備份` 變成亂碼。
 */
test("0.44.2 folder picker output survives the console code page for CJK and emoji paths", { skip: process.platform !== "win32" }, async () => {
  const samples = ["D:\\備份", "C:\\Users\\王偉晨\\文件 與 資料", "E:\\𠮷野家\\測試😀", "D:\\Plain ASCII"];
  for (const sample of samples) {
    // 與選擇器相同：從 Node 啟動 PowerShell，輸出經 pickerOutputStatement。
    const quoted = `'${sample.replaceAll("'", "''")}'`;
    const result = await execFile("powershell.exe", [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-STA", "-Command", pickerOutputStatement(quoted),
    ], { encoding: "utf8", windowsHide: true, maxBuffer: 32 * 1024 });
    assert.equal(decodePickerOutput(result.stdout), sample, `路徑 ${sample} 經選擇器輸出後必須逐字相同`);
  }
});

test("0.44.2 decodePickerOutput treats empty output as a cancelled dialog", () => {
  assert.equal(decodePickerOutput(""), null);
  assert.equal(decodePickerOutput("  \r\n"), null);
  assert.equal(decodePickerOutput(Buffer.from("D:\\備份", "utf8").toString("base64") + "\r\n"), "D:\\備份");
});
