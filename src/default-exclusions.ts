import { lstat } from "node:fs/promises";
import { lstatSync as lstatSyncFs } from "node:fs";
import path from "node:path";
import { loadIgnoreRules, loadIgnoreRulesSync, type IgnoreRules } from "./ignore.js";
import { canonicalizeRootInput, coversPath, parseFsPath, samePath, runtimePathPlatform, type PathPlatform } from "./root-plan.js";
import { isIndexArtifact } from "./index-artifacts.js";
import type { IndexStore } from "./store.js";

export type ExclusionSource = "builtin" | "volume-default" | "user-rule" | "link" | "index-artifact" | "not-excluded";

export interface DefaultExclusionRule {
  id: string;
  pattern: string;
  name: string;
  reason: string;
  warning: string;
  source: "builtin" | "volume-default";
}

export interface ExclusionExplanation {
  excluded: boolean;
  source: ExclusionSource;
  ruleId: string | null;
  matchedRule: string | null;
  base: string | null;
}

export interface ExclusionScope {
  base: string;
  rules: IgnoreRules;
}

const GENERIC_RULES: DefaultExclusionRule[] = [
  {
    id: "builtin:.git",
    pattern: "**/.git/**",
    name: ".git 版本控制資料",
    reason: "版本控制內部資料不是一般文件搜尋範圍。",
    warning: "若要查診斷資料，請直接以較窄目錄作為根目錄。",
    source: "builtin",
  },
  {
    id: "builtin:node-modules",
    pattern: "**/node_modules/**",
    name: "node_modules 套件資料",
    reason: "套件安裝內容數量大且通常不是使用者文件。",
    warning: "套件附帶的 README 需要以較窄目錄單獨索引。",
    source: "builtin",
  },
  {
    id: "builtin:localdocsearch",
    pattern: "**/.localdocsearch/**",
    name: ".localdocsearch 內部資料",
    reason: "Seekah 內部資料不應回饋成來源文件。",
    warning: "這是產品資料，不是可搜尋的來源文件。",
    source: "builtin",
  },
  {
    id: "builtin:office-temp",
    pattern: "**/~$*",
    name: "Office 暫存檔",
    reason: "Office 暫存檔通常是不完整或短暫的內容。",
    warning: "正式文件請等待 Office 完成寫入後再搜尋。",
    source: "builtin",
  },
];

const SYSTEM_RULES: DefaultExclusionRule[] = [
  {
    id: "builtin:$recycle-bin",
    pattern: "$Recycle.Bin/**",
    name: "$Recycle.Bin 回收筒資料",
    reason: "回收筒內容與 metadata 不是穩定的來源文件範圍。",
    warning: "已刪除但仍在回收筒的文件不會出現在搜尋結果。",
    source: "builtin",
  },
  {
    id: "builtin:system-volume-information",
    pattern: "System Volume Information/**",
    name: "System Volume Information 系統資料",
    reason: "磁碟區 metadata、還原點與索引服務資料不是一般文件。",
    warning: "需要系統診斷資料時，請遵守 Windows 權限與政策另行處理。",
    source: "builtin",
  },
];

const VOLUME_RULES: DefaultExclusionRule[] = [
  {
    id: "volume-default:windows",
    pattern: "Windows/**",
    name: "Windows 系統目錄",
    reason: "作業系統檔案、更新元件、logs 與高頻變動資料會造成大量噪音。",
    warning: "系統維運報告或範例文件可能被略過；需要時請移除父 volume root，改索引窄根目錄。",
    source: "volume-default",
  },
  {
    id: "volume-default:program-files",
    pattern: "Program Files/**",
    name: "Program Files 程式資料",
    reason: "64-bit 安裝程式、DLL、cache 與資源通常不是使用者文件。",
    warning: "軟體附帶 manuals 或 README 可能被略過；請改索引該文件所在窄根目錄。",
    source: "volume-default",
  },
  {
    id: "volume-default:program-files-x86",
    pattern: "Program Files (x86)/**",
    name: "Program Files (x86) 程式資料",
    reason: "32-bit 安裝程式與依賴資料通常不是使用者文件。",
    warning: "32-bit 軟體附帶文件可能被略過；請改索引該文件所在窄根目錄。",
    source: "volume-default",
  },
  {
    id: "volume-default:program-data",
    pattern: "ProgramData/**",
    name: "ProgramData 機器層級資料",
    reason: "服務資料、installer／updater cache、logs 與暫存檔通常不適合文件搜尋。",
    warning: "企業應用程式的報表、範本或 logs 可能被略過；請改索引明確的窄根目錄。",
    source: "volume-default",
  },
  {
    id: "volume-default:users-profile-appdata",
    pattern: "Users/<profile>/AppData/**",
    name: "使用者 AppData 資料",
    reason: "瀏覽器、IDE、套件 cache、session、設定與 token 會造成隱私風險及事件洪水。",
    warning: "AppData 內刻意保存的範本或報告可能被略過；請移除父根後直接索引指定窄目錄。",
    source: "volume-default",
  },
  {
    id: "volume-default:perflogs",
    pattern: "PerfLogs/**",
    name: "PerfLogs 效能記錄",
    reason: "Windows 效能記錄通常不是一般文件，且可能無權限讀取。",
    warning: "維運診斷 logs 可能被略過；請改索引明確的窄根目錄。",
    source: "volume-default",
  },
];

const GENERIC_BY_SEGMENT: Record<string, string> = {
  ".git": "builtin:.git",
  "node_modules": "builtin:node-modules",
  ".localdocsearch": "builtin:localdocsearch",
};

const RULES_BY_ID = new Map([...GENERIC_RULES, ...SYSTEM_RULES, ...VOLUME_RULES].map(rule => [rule.id, rule]));

function canonicalRoot(root: string, platform: PathPlatform): string {
  return platform === "win32" ? canonicalizeRootInput(root, platform).path : root;
}

export function isLocalWindowsVolumeRoot(root: string, platform: PathPlatform = runtimePathPlatform()): boolean {
  if (platform !== "win32") return false;
  try {
    const parsed = parseFsPath(canonicalRoot(root, platform), platform);
    return parsed.drive !== null && parsed.parts.length === 0;
  } catch {
    return false;
  }
}

function isWindowsVolumeRoot(root: string, platform: PathPlatform): boolean {
  if (platform !== "win32") return false;
  try {
    const parsed = parseFsPath(canonicalRoot(root, platform), platform);
    return parsed.parts.length === 0 && (parsed.drive !== null || parsed.uncHost !== null);
  } catch {
    return false;
  }
}

function relativeParts(root: string, absPath: string, platform: PathPlatform): string[] | undefined {
  const normalizedRoot = canonicalRoot(root, platform);
  if (!coversPath(normalizedRoot, absPath, platform) || samePath(normalizedRoot, absPath, platform)) return undefined;
  try {
    const rootParsed = parseFsPath(normalizedRoot, platform);
    const pathParsed = parseFsPath(absPath, platform);
    if (rootParsed.drive !== pathParsed.drive || rootParsed.uncHost !== pathParsed.uncHost || rootParsed.uncShare !== pathParsed.uncShare) return undefined;
    return pathParsed.parts.slice(rootParsed.parts.length);
  } catch {
    return undefined;
  }
}

function lower(value: string, platform: PathPlatform): string {
  return platform === "win32" ? value.toLowerCase() : value;
}

function matchRule(ruleId: string, base: string): ExclusionExplanation {
  const rule = RULES_BY_ID.get(ruleId);
  return {
    excluded: true,
    source: rule?.source ?? "builtin",
    ruleId,
    matchedRule: rule?.pattern ?? ruleId,
    base,
  };
}

function notExcluded(): ExclusionExplanation {
  return { excluded: false, source: "not-excluded", ruleId: null, matchedRule: null, base: null };
}

export function listDefaultExclusions(root: string, platform: PathPlatform = runtimePathPlatform()): DefaultExclusionRule[] {
  const rules = [...GENERIC_RULES];
  if (isWindowsVolumeRoot(root, platform)) rules.push(...SYSTEM_RULES);
  if (isLocalWindowsVolumeRoot(root, platform)) rules.push(...VOLUME_RULES);
  return rules.map(rule => ({ ...rule }));
}

export function matchDefaultExclusion(
  root: string,
  absPath: string,
  isDirectory: boolean | undefined,
  platform: PathPlatform = runtimePathPlatform(),
): ExclusionExplanation {
  const parts = relativeParts(root, absPath, platform);
  if (!parts) return notExcluded();
  const normalizedParts = parts.map(part => lower(part, platform));
  const volume = isLocalWindowsVolumeRoot(root, platform);
  const volumeRoot = isWindowsVolumeRoot(root, platform);
  for (let index = 0; index < parts.length; index++) {
    const leaf = index === parts.length - 1;
    const segment = normalizedParts[index]!;
    const ruleId = GENERIC_BY_SEGMENT[segment];
    if (ruleId && (!leaf || isDirectory !== false)) return matchRule(ruleId, root);
    if (volumeRoot && index === 0 && (segment === "$recycle.bin" || segment === "system volume information")
      && (!leaf || isDirectory !== false)) {
      return matchRule(segment === "$recycle.bin" ? "builtin:$recycle-bin" : "builtin:system-volume-information", root);
    }
    if (volume && index === 0) {
      const directRule = segment === "windows" ? "volume-default:windows"
        : segment === "program files" ? "volume-default:program-files"
          : segment === "program files (x86)" ? "volume-default:program-files-x86"
            : segment === "programdata" ? "volume-default:program-data"
              : segment === "perflogs" ? "volume-default:perflogs" : undefined;
      if (directRule && (!leaf || isDirectory !== false)) return matchRule(directRule, root);
    }
    if (volume && index === 2 && normalizedParts[0] === "users" && normalizedParts[2] === "appdata"
      && (!leaf || isDirectory !== false)) {
      return matchRule("volume-default:users-profile-appdata", root);
    }
    if (leaf && isDirectory !== true && parts[index]!.startsWith("~$")) return matchRule("builtin:office-temp", root);
  }
  return notExcluded();
}

function relativeForRules(base: string, absPath: string, platform: PathPlatform): string | undefined {
  if (!coversPath(base, absPath, platform) || samePath(base, absPath, platform)) return undefined;
  const flavor = platform === "win32" ? path.win32 : path.posix;
  return flavor.relative(base, absPath).replaceAll("\\", "/");
}

export function matchUserExclusion(
  root: string,
  absPath: string,
  isDirectory: boolean | undefined,
  scopes: readonly ExclusionScope[],
  platform: PathPlatform = runtimePathPlatform(),
): ExclusionExplanation {
  if (!coversPath(root, absPath, platform) || samePath(root, absPath, platform)) return notExcluded();
  for (const scope of scopes) {
    const relative = relativeForRules(scope.base, absPath, platform);
    if (relative === undefined) continue;
    const pattern = scope.rules.matchingPattern(relative, isDirectory);
    if (pattern !== undefined) {
      return {
        excluded: true,
        source: "user-rule",
        ruleId: `user-rule:${scope.base}:${pattern}`,
        matchedRule: pattern,
        base: scope.base,
      };
    }
  }
  return notExcluded();
}

export function matchExclusion(
  root: string,
  absPath: string,
  isDirectory: boolean | undefined,
  scopes: readonly ExclusionScope[],
  databasePath?: string,
  isLink = false,
  platform: PathPlatform = runtimePathPlatform(),
): ExclusionExplanation {
  if (databasePath && isIndexArtifact(absPath, databasePath)) {
    return { excluded: true, source: "index-artifact", ruleId: "index-artifact", matchedRule: null, base: null };
  }
  if (isLink) return { excluded: true, source: "link", ruleId: "link", matchedRule: null, base: null };
  const builtIn = matchDefaultExclusion(root, absPath, isDirectory, platform);
  if (builtIn.excluded) return builtIn;
  return matchUserExclusion(root, absPath, isDirectory, scopes, platform);
}

async function loadScopes(root: string, bases: readonly string[]): Promise<ExclusionScope[]> {
  const scopes: ExclusionScope[] = [{ base: root, rules: await loadIgnoreRules(root) }];
  for (const base of bases) scopes.push({ base, rules: await loadIgnoreRules(base) });
  return scopes;
}

function loadScopesSync(root: string, bases: readonly string[]): ExclusionScope[] {
  const scopes: ExclusionScope[] = [{ base: root, rules: loadIgnoreRulesSync(root) }];
  for (const base of bases) scopes.push({ base, rules: loadIgnoreRulesSync(base) });
  return scopes;
}

function linkSync(absPath: string): boolean {
  try { return lstatSyncFs(absPath).isSymbolicLink(); } catch { return false; }
}

async function linkAsync(absPath: string): Promise<boolean> {
  try { return (await lstat(absPath)).isSymbolicLink(); } catch { return false; }
}

export async function explainExclusion(root: string, absPath: string, store: Pick<IndexStore, "databasePath" | "ignoreBases">): Promise<ExclusionExplanation> {
  const scopes = await loadScopes(root, store.ignoreBases(root));
  return matchExclusion(root, absPath, undefined, scopes, store.databasePath, await linkAsync(absPath));
}

export function explainExclusionSync(root: string, absPath: string, store: Pick<IndexStore, "databasePath" | "ignoreBases">): ExclusionExplanation {
  const scopes = loadScopesSync(root, store.ignoreBases(root));
  return matchExclusion(root, absPath, undefined, scopes, store.databasePath, linkSync(absPath));
}

export function ruleById(id: string): DefaultExclusionRule | undefined {
  const rule = RULES_BY_ID.get(id);
  return rule ? { ...rule } : undefined;
}
