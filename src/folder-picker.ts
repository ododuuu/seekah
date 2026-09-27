import { execFile as nodeExecFile } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(nodeExecFile);
const WINDOWS_PICKER_SCRIPT = [
  "Add-Type -AssemblyName System.Windows.Forms",
  "[System.Windows.Forms.Application]::EnableVisualStyles()",
  "$dialog = New-Object System.Windows.Forms.FolderBrowserDialog",
  "$dialog.Description = '選擇要索引的資料夾'",
  "$dialog.ShowNewFolderButton = $false",
  "try { if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($dialog.SelectedPath) } } finally { $dialog.Dispose() }",
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
    const selected = result.stdout.trim();
    return selected || null;
  } catch {
    throw new FolderPickerError("FOLDER_PICKER_FAILED", "無法開啟本機資料夾選擇器；請改用 CLI index <資料夾路徑>。" );
  }
}
