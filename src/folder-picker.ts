import { execFile as nodeExecFile } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(nodeExecFile);

/**
 * 以 Base64（UTF-8 位元組）輸出路徑，不依賴主控台字碼頁。
 * 從 Node 隱藏視窗啟動 PowerShell 時，輸出使用 OEM 字碼頁（繁體中文 Windows 是 CP950／Big5），
 * 直接寫出路徑再以 UTF-8 解碼會讓 `D:\備份` 變成亂碼（0.44.2 修正）。
 */
export function pickerOutputStatement(valueExpression: string): string {
  return `[Console]::Out.Write([Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes(${valueExpression})))`;
}

/** 解碼 `pickerOutputStatement` 的輸出；空輸出代表使用者取消。 */
export function decodePickerOutput(stdout: string): string | null {
  const text = stdout.trim();
  if (!text) return null;
  const decoded = Buffer.from(text, "base64").toString("utf8");
  return decoded || null;
}

const WINDOWS_PICKER_SCRIPT = [
  "Add-Type -AssemblyName System.Windows.Forms",
  "[System.Windows.Forms.Application]::EnableVisualStyles()",
  "$dialog = New-Object System.Windows.Forms.FolderBrowserDialog",
  "$dialog.Description = '選擇要索引的資料夾'",
  "$dialog.ShowNewFolderButton = $false",
  `try { if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { ${pickerOutputStatement("$dialog.SelectedPath")} } } finally { $dialog.Dispose() }`,
].join(";");

export class FolderPickerError extends Error {
  readonly code: "FOLDER_PICKER_UNSUPPORTED" | "FOLDER_PICKER_FAILED";

  constructor(code: "FOLDER_PICKER_UNSUPPORTED" | "FOLDER_PICKER_FAILED", message: string) {
    super(message);
    this.name = "FolderPickerError";
    this.code = code;
  }
}

export async function selectFolder(platform: NodeJS.Platform = process.platform): Promise<string | null> {
  if (platform !== "win32") {
    throw new FolderPickerError("FOLDER_PICKER_UNSUPPORTED", "此平台尚未提供本機資料夾選擇器；請改用 CLI index <資料夾路徑>。" );
  }
  try {
    const result = await execFile("powershell.exe", [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-STA",
      "-Command",
      WINDOWS_PICKER_SCRIPT,
    ], { encoding: "utf8", windowsHide: true, maxBuffer: 32 * 1024 });
    return decodePickerOutput(result.stdout);
  } catch {
    throw new FolderPickerError("FOLDER_PICKER_FAILED", "無法開啟本機資料夾選擇器；請改用 CLI index <資料夾路徑>。" );
  }
}
