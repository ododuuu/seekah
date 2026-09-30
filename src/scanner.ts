import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { loadIgnoreRules, type IgnoreRules } from "./ignore.js";
import { canonicalizeRootInput, RootError } from "./root-plan.js";
import { emptySkippedCounts, type Diagnostic, type SkippedCounts } from "./model.js";
import { throwIfAborted, type ProgressUpdate } from "./progress.js";
import { isWindowsVolumeSystemRoot } from "./builtin-paths.js";
import { RootExclusion } from "./root-exclusion.js";

export interface ScanResult {
  paths: string[];
  errors: string[];
  diagnostics: Diagnostic[];
  protectedScopes: string[];
  skipped: SkippedCounts;
  ignoreFile: string | null;
  ignorePatterns: string[];
  extraIgnoreFiles: string[];
}

export interface ScanOptions {
  signal?: AbortSignal;
  onProgress?: (update: ProgressUpdate) => void;
  extraIgnoreBases?: readonly string[];
  start?: string;
  exclusion?: RootExclusion;
  databasePath?: string;
}

function countSkipped(result: ScanResult, exclusion: ReturnType<RootExclusion["explain"]>): void {
  const ruleId = exclusion.ruleId ?? exclusion.source;
  result.skipped.byRule[ruleId] = (result.skipped.byRule[ruleId] ?? 0) + 1;
  if (exclusion.source === "user-rule") result.skipped.user++;
  else if (exclusion.source === "link") result.skipped.link++;
  else result.skipped.builtin++;
}

export async function scan(root: string, options: ScanOptions = {}): Promise<ScanResult> {
  const ignoreRules = await loadIgnoreRules(root);
  const extraRules: { base: string; rules: IgnoreRules }[] = [];
  const extraIgnoreFiles: string[] = [];
  for (const base of options.extraIgnoreBases ?? []) {
    const rules = await loadIgnoreRules(base);
    extraRules.push({ base, rules });
    if (rules.sourcePath) extraIgnoreFiles.push(rules.sourcePath);
  }
  const exclusion = options.exclusion
    ?? await RootExclusion.loadWithExtraIgnoreBases(root, options.extraIgnoreBases ?? [], options.databasePath);
  const start = options.start ?? root;
  const result: ScanResult = { paths: [], errors: [], diagnostics: [], protectedScopes: [],
    skipped: emptySkippedCounts(),
    ignoreFile: ignoreRules.sourcePath, ignorePatterns: [...ignoreRules.patterns, ...extraRules.flatMap(item => item.rules.patterns)],
    extraIgnoreFiles };
  const pending = [start];
  while (pending.length > 0) {
    throwIfAborted(options.signal);
    const directory = pending.pop()!;
    options.onProgress?.({ stage: "scan", message: `掃描目錄；已找到 ${result.paths.length} 份檔案`, current: result.paths.length, path: directory });
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      const diagnostic: Diagnostic = { stage: "scan", path: directory, code: "SCAN_READ_FAILED", message: "無法讀取目錄" };
      result.diagnostics.push(diagnostic);
      result.errors.push(`${directory}: ${diagnostic.message}`);
      result.protectedScopes.push(directory);
      continue;
    }
    for (const entry of entries) {
      const fullPath = path.join(directory, entry.name);
      const explanation = exclusion.explain(fullPath, entry.isDirectory(), entry.isSymbolicLink());
      if (explanation.excluded) {
        countSkipped(result, explanation);
      } else if (entry.isDirectory()) {
        pending.push(fullPath);
      } else if (entry.isFile()) {
        result.paths.push(fullPath);
      }
    }
  }
  result.paths.sort();
  return result;
}

export async function validateRoot(input: string): Promise<string> {
  const candidate = process.platform === "win32" ? canonicalizeRootInput(input, "win32").path : input;
  const root = path.resolve(candidate);
  if (isWindowsVolumeSystemRoot(root)) {
    throw new RootError(`不能將 Windows 系統目錄設為索引根目錄：${root}`);
  }
  let info;
  try {
    info = await stat(root);
  } catch {
    throw new RootError(`找不到根目錄：${root}`);
  }
  if (!info.isDirectory()) throw new RootError(`指定路徑不是目錄：${root}`);
  return root;
}

export { RootError };
