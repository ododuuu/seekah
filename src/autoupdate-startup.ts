import { execFile as nodeExecFile } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { AutoupdateError } from "./autoupdate-control.js";
import { dataDirectory, defaultDatabasePath } from "./store.js";

const execFile = promisify(nodeExecFile);
const STARTUP_DIRECTORY_PARTS = ["Microsoft", "Windows", "Start Menu", "Programs", "Startup"] as const;
const STARTUP_SHORTCUT_NAME = "Seekah Autoupdate.lnk";
const STARTUP_MARKER_SUFFIX = ".seekah-owner.json";
const STARTUP_MARKER_SCHEMA = 1;

interface StartupOwnerMarker {
  schemaVersion: number;
  product: "seekah";
  shortcutPath: string;
  databasePath: string;
  nodePath: string;
  cliPath: string;
}

export interface StartupShortcutPaths {
  directory: string;
  shortcutPath: string;
  markerPath: string;
}

export interface StartupCommandOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  homedir?: string;
  databasePath?: string;
  nodePath?: string;
  cliPath?: string;
  runPowerShell?: (executable: string, args: readonly string[], env: NodeJS.ProcessEnv) => Promise<void>;
}

export interface StartupCommandResult {
  code: number;
  text: string;
}

function isWindows(options: StartupCommandOptions): boolean {
  return (options.platform ?? process.platform) === "win32";
}

export function startupShortcutPaths(options: Pick<StartupCommandOptions, "env" | "homedir"> = {}): StartupShortcutPaths {
  const env = options.env ?? process.env;
  const home = options.homedir ?? os.homedir();
  const appData = env.APPDATA?.trim() || path.join(home, "AppData", "Roaming");
  const directory = path.join(appData, ...STARTUP_DIRECTORY_PARTS);
  const shortcutPath = path.join(directory, STARTUP_SHORTCUT_NAME);
  return { directory, shortcutPath, markerPath: `${shortcutPath}${STARTUP_MARKER_SUFFIX}` };
}

function powershellPath(env: NodeJS.ProcessEnv): string {
  const systemRoot = env.SystemRoot ?? env.SYSTEMROOT ?? "C:\\Windows";
  return path.win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

function quoteWindowsArgument(value: string): string {
  let result = '"';
  let slashes = 0;
  for (const character of value) {
    if (character === "\\") {
      slashes++;
    } else if (character === '"') {
      result += "\\".repeat(slashes * 2 + 1) + '"';
      slashes = 0;
    } else {
      result += "\\".repeat(slashes) + character;
      slashes = 0;
    }
  }
  return result + "\\".repeat(slashes * 2) + '"';
}

function shortcutArguments(cliPath: string, dataDir: string): string {
  return [quoteWindowsArgument(cliPath), "autoupdate", "start", "--data-dir", quoteWindowsArgument(dataDir)].join(" ");
}

function markerFromFile(paths: StartupShortcutPaths): StartupOwnerMarker | undefined {
  if (!existsSync(paths.markerPath)) return undefined;
  try {
    const marker = JSON.parse(readFileSync(paths.markerPath, "utf8")) as Partial<StartupOwnerMarker>;
    if (marker.schemaVersion !== STARTUP_MARKER_SCHEMA || marker.product !== "seekah" || marker.shortcutPath !== paths.shortcutPath) return undefined;
    return marker as StartupOwnerMarker;
  } catch {
    return undefined;
  }
}

function pathExistsAsFile(filePath: string): boolean {
  try { return lstatSync(filePath).isFile(); }
  catch { return false; }
}

function hasForeignEntry(paths: StartupShortcutPaths): boolean {
  return existsSync(paths.shortcutPath) && !markerFromFile(paths);
}

function ensureNoConflict(paths: StartupShortcutPaths): StartupOwnerMarker | undefined {
  const owner = markerFromFile(paths);
  if (hasForeignEntry(paths)) {
    throw new AutoupdateError("AUTOUPDATE_STARTUP_CONFLICT", `Startup 捷徑已存在但不是 Seekah 建立：${paths.shortcutPath}`);
  }
  if (existsSync(paths.markerPath) && !owner) {
    throw new AutoupdateError("AUTOUPDATE_STARTUP_CONFLICT", `Startup 擁有權標記無法驗證：${paths.markerPath}`);
  }
  return owner;
}

async function createShortcut(paths: StartupShortcutPaths, nodePath: string, cliPath: string, dataDir: string,
  env: NodeJS.ProcessEnv, runPowerShell: StartupCommandOptions["runPowerShell"]): Promise<void> {
  const executable = powershellPath(env);
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$shell = New-Object -ComObject WScript.Shell",
    "$shortcut = $shell.CreateShortcut($env:SEEKAH_STARTUP_SHORTCUT)",
    "$shortcut.TargetPath = $env:SEEKAH_STARTUP_NODE",
    "$shortcut.Arguments = $env:SEEKAH_STARTUP_ARGUMENTS",
    "$shortcut.WorkingDirectory = $env:SEEKAH_STARTUP_WORKING_DIRECTORY",
    "$shortcut.Description = 'Seekah autoupdate startup'",
    "$shortcut.Save()",
  ].join("\n");
  const commandEnv = {
    ...env,
    SEEKAH_STARTUP_SHORTCUT: paths.shortcutPath,
    SEEKAH_STARTUP_NODE: nodePath,
    SEEKAH_STARTUP_ARGUMENTS: shortcutArguments(cliPath, dataDir),
    SEEKAH_STARTUP_WORKING_DIRECTORY: path.dirname(cliPath),
  };
  const args = ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")];
  if (runPowerShell) await runPowerShell(executable, args, commandEnv);
  else await execFile(executable, args, { env: commandEnv, windowsHide: true, timeout: 15_000, maxBuffer: 16_384 });
}

function writeOwnerMarker(paths: StartupShortcutPaths, marker: StartupOwnerMarker): void {
  const temporary = `${paths.markerPath}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(marker)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, paths.markerPath);
}

function resolveOptions(options: StartupCommandOptions): { paths: StartupShortcutPaths; databasePath: string; nodePath: string; cliPath: string; dataDir: string; env: NodeJS.ProcessEnv } {
  const env = options.env ?? process.env;
  const databasePath = path.resolve(options.databasePath ?? defaultDatabasePath());
  const nodePath = path.resolve(options.nodePath ?? process.execPath);
  const cliPath = path.resolve(options.cliPath ?? process.argv[1] ?? "dist/src/cli.js");
  const dataDir = path.dirname(dataDirectory(databasePath));
  return { paths: startupShortcutPaths(options), databasePath, nodePath, cliPath, dataDir, env };
}

export async function autoupdateStartupEnable(options: StartupCommandOptions = {}): Promise<StartupCommandResult> {
  if (!isWindows(options)) throw new AutoupdateError("AUTOUPDATE_STARTUP_UNSUPPORTED", "登入啟動只支援 Windows；請保留手動 autoupdate start。", 3);
  const resolved = resolveOptions(options);
  const owner = ensureNoConflict(resolved.paths);
  try {
    mkdirSync(resolved.paths.directory, { recursive: true });
    await createShortcut(resolved.paths, resolved.nodePath, resolved.cliPath, resolved.dataDir, resolved.env, options.runPowerShell);
    writeOwnerMarker(resolved.paths, {
      schemaVersion: STARTUP_MARKER_SCHEMA,
      product: "seekah",
      shortcutPath: resolved.paths.shortcutPath,
      databasePath: resolved.databasePath,
      nodePath: resolved.nodePath,
      cliPath: resolved.cliPath,
    });
  } catch (error) {
    try { unlinkSync(`${resolved.paths.markerPath}.tmp`); } catch { /* no temporary marker */ }
    const message = error instanceof Error ? error.message : String(error);
    throw new AutoupdateError("AUTOUPDATE_STARTUP_POLICY", `無法註冊目前使用者登入啟動；可能遭公司政策拒絕。${message}`, 3);
  }
  return { code: 0, text: owner ? `已更新 Seekah 登入啟動：${resolved.paths.shortcutPath}` : `已啟用 Seekah 登入啟動：${resolved.paths.shortcutPath}` };
}

export function autoupdateStartupStatus(options: StartupCommandOptions = {}): StartupCommandResult {
  if (!isWindows(options)) return { code: 0, text: "登入啟動：不支援（僅 Windows）；請使用手動 autoupdate start。" };
  const resolved = resolveOptions(options);
  const owner = markerFromFile(resolved.paths);
  if (hasForeignEntry(resolved.paths) || (existsSync(resolved.paths.markerPath) && !owner)) {
    return { code: 3, text: `登入啟動：衝突（未驗證的同名檔案）：${resolved.paths.shortcutPath}` };
  }
  if (!pathExistsAsFile(resolved.paths.shortcutPath) || !owner) {
    return { code: 0, text: `登入啟動：未啟用\n捷徑：${resolved.paths.shortcutPath}` };
  }
  const current = owner.databasePath === resolved.databasePath && owner.nodePath === resolved.nodePath && owner.cliPath === resolved.cliPath;
  return {
    code: 0,
    text: `登入啟動：已啟用${current ? "" : "（路徑需重新 enable）"}\n捷徑：${resolved.paths.shortcutPath}\n索引：${owner.databasePath}`,
  };
}

export function autoupdateStartupDisable(options: StartupCommandOptions = {}): StartupCommandResult {
  if (!isWindows(options)) throw new AutoupdateError("AUTOUPDATE_STARTUP_UNSUPPORTED", "登入啟動只支援 Windows；請保留手動 autoupdate start。", 3);
  const resolved = resolveOptions(options);
  ensureNoConflict(resolved.paths);
  if (!existsSync(resolved.paths.shortcutPath)) {
    if (existsSync(resolved.paths.markerPath)) unlinkSync(resolved.paths.markerPath);
    return { code: 0, text: "Seekah 登入啟動未啟用。" };
  }
  try {
    unlinkSync(resolved.paths.shortcutPath);
    if (existsSync(resolved.paths.markerPath)) unlinkSync(resolved.paths.markerPath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new AutoupdateError("AUTOUPDATE_STARTUP_POLICY", `無法移除 Seekah 登入啟動；捷徑可能被政策或其他程序鎖定。${message}`, 3);
  }
  return { code: 0, text: "已停用 Seekah 登入啟動。" };
}
