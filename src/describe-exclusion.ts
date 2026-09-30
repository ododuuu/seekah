import type { ExclusionCleanupSummary, DocumentStatus } from "./model.js";
import type { DefaultExclusionRule, ExclusionExplanation, ExclusionSource } from "./default-exclusions.js";

export type ExclusionPathState =
  | "excluded"
  | "indexed"
  | "unindexed"
  | "parse-failed"
  | "filename-only"
  | "outside-root";

export interface ExclusionPathResult {
  path: string;
  root: string | null;
  state: ExclusionPathState;
  exists?: boolean;
  source: ExclusionSource | null;
  ruleId: string | null;
  matchedRule: string | null;
  matchedPath: string | null;
  base: string | null;
  documentStatus: DocumentStatus | null;
  errorCode: string | null;
}

export interface ExclusionPolicyRule extends DefaultExclusionRule {
  lastSkipped?: number;
}

export interface ExclusionIgnoreFile {
  base: string;
  path: string;
  exists: boolean;
  patterns: string[];
  errorCode?: string;
}

export interface ExclusionPolicy {
  root: string;
  rules: ExclusionPolicyRule[];
  ignoreFiles: ExclusionIgnoreFile[];
  skippedByRule?: Record<string, number>;
  exclusionCleanup?: ExclusionCleanupSummary;
}

export function pathResultFromExplanation(
  pathResult: Omit<ExclusionPathResult, "source" | "ruleId" | "matchedRule" | "matchedPath" | "base">,
  explanation: ExclusionExplanation,
): ExclusionPathResult {
  return {
    ...pathResult,
    source: explanation.excluded ? explanation.source : null,
    ruleId: explanation.excluded ? explanation.ruleId : null,
    matchedRule: explanation.excluded ? explanation.matchedRule : null,
    matchedPath: explanation.excluded ? explanation.matchedPath : null,
    base: explanation.excluded ? explanation.base : null,
  };
}

function sourceLabel(source: ExclusionSource | null): string {
  switch (source) {
    case "builtin": return "內建規則";
    case "volume-default": return "磁碟根預設規則";
    case "user-rule": return "使用者 .localdocsearchignore 規則";
    case "link": return "連結／junction 規則";
    case "index-artifact": return "索引內部檔案規則";
    case "not-excluded": return "未命中排除規則";
    default: return "未提供";
  }
}

function statusLabel(status: DocumentStatus | null): string {
  switch (status) {
    case "indexed": return "已索引";
    case "no_text": return "已索引但沒有文字內容";
    case "unsupported": return "不支援格式";
    case "too_large": return "檔案太大";
    case "encrypted": return "檔案加密";
    case "error": return "解析失敗";
    default: return "未提供";
  }
}

function excludedAlternative(result: ExclusionPathResult): string {
  switch (result.source) {
    case "user-rule":
      return `移除或調整 ${result.base ?? "對應根目錄"} 下的 .localdocsearchignore 規則後重新同步；此入口不會替你修改規則。`;
    case "link":
      return "改以非 link／junction 的實體來源或實體窄根目錄索引；不追蹤連結，以避免循環與越界。";
    case "index-artifact":
      return "不要把 Seekah 索引資料夾當來源根目錄；若要索引原始資料，請選取原始文件所在的窄根目錄。";
    case "volume-default":
      return "移除涵蓋它的父 volume root 後，直接登錄文件所在的窄根目錄；父根存在時，窄根目錄不能 override 磁碟預設規則。";
    default:
      return "直接登錄文件所在的較窄根目錄；仍受內建規則、格式限制與檔案大小限制，不能用 ! 規則重新納入。";
  }
}

/** 所有 CLI、工作台、TUI、MCP 路徑說明共用的純文字函式。 */
export function formatExclusionExplanation(result: ExclusionPathResult): string {
  const header = `路徑：${result.path}`;
  switch (result.state) {
    case "excluded": {
      const rule = result.matchedRule ?? result.ruleId ?? "未提供";
      const ancestor = result.matchedPath ?? "未提供";
      const indexState = result.documentStatus ? `目前索引狀態：${statusLabel(result.documentStatus)}。` : "";
      return `${header}\n已排除：來源為${sourceLabel(result.source)}；命中規則 ${rule}；命中的檔案或祖先路徑：${ancestor}。${indexState}\n若真的需要索引：${excludedAlternative(result)}`;
    }
    case "indexed":
      return `${header}\n已索引：目前索引狀態為${statusLabel(result.documentStatus)}。`;
    case "parse-failed":
      return `${header}\n解析失敗：錯誤碼 ${result.errorCode ?? "未提供"}。`;
    case "filename-only":
      return `${header}\n僅檔名可搜尋：${statusLabel(result.documentStatus)}；不會提供正文內容。`;
    case "outside-root":
      return `${header}\n不在任何已登錄根目錄內：目前沒有可用的索引範圍。`;
    case "unindexed":
      return `${header}\n尚未索引：目前索引沒有此路徑的文件項目${result.exists === false ? "，檔案目前不存在或尚未被確認" : ""}。`;
  }
}

export function formatExclusionPolicyLines(policy: ExclusionPolicy): string[] {
  const lines = [`根目錄：${policy.root}`, `預設排除規則：${policy.rules.length || "無"}`];
  for (const rule of policy.rules) {
    const count = rule.lastSkipped === undefined ? "未提供" : String(rule.lastSkipped);
    lines.push(`  - ${rule.name}（${rule.pattern}）；理由：${rule.reason}；警告：${rule.warning}；最近略過：${count}`);
  }
  if (!policy.rules.length) lines.push("  （無）");
  lines.push(".localdocsearchignore：");
  if (!policy.ignoreFiles.length) {
    lines.push("  （無有效作用域）");
  } else {
    for (const file of policy.ignoreFiles) {
      if (file.errorCode) lines.push(`  - ${file.path}：規則無法讀取（${file.errorCode}）`);
      else if (!file.exists) lines.push(`  - ${file.path}：不存在`);
      else lines.push(`  - ${file.path}：${file.patterns.length ? file.patterns.join("、") : "存在但沒有規則"}`);
    }
  }
  if (policy.skippedByRule === undefined) {
    lines.push("逐規則最近略過：未提供。");
  } else {
    const counts = Object.entries(policy.skippedByRule).sort(([left], [right]) => left.localeCompare(right));
    lines.push(`逐規則最近略過：${counts.length ? counts.map(([id, count]) => `${id}=${count}`).join("、") : "無"}。`);
  }
  if (policy.exclusionCleanup) {
    lines.push(`既有索引排除清理：已移除 ${policy.exclusionCleanup.removed}；待清理 ${policy.exclusionCleanup.pending}。`);
  } else {
    lines.push("既有索引排除清理：未提供。");
  }
  return lines;
}

export function formatExclusionPolicySummary(policy: ExclusionPolicy): string {
  const names = policy.rules.length ? policy.rules.map(rule => rule.name).join("、") : "無";
  const defaultCounts = policy.rules.length
    ? policy.rules.map(rule => `${rule.id}=${rule.lastSkipped === undefined ? "未提供" : rule.lastSkipped}`)
    : [];
  const knownRuleIds = new Set(policy.rules.map(rule => rule.id));
  const extraCounts = policy.skippedByRule === undefined
    ? []
    : Object.entries(policy.skippedByRule)
      .filter(([id]) => !knownRuleIds.has(id))
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([id, count]) => `${id}=${count}`);
  const counts = policy.skippedByRule === undefined
    ? (defaultCounts.length ? defaultCounts.join("、") : "無")
    : [...defaultCounts, ...extraCounts].join("、") || "無";
  const cleanup = policy.exclusionCleanup
    ? `清理 已移除 ${policy.exclusionCleanup.removed}／待清理 ${policy.exclusionCleanup.pending}`
    : "清理 未提供";
  return `預設排除：${names}；最近逐規則略過：${counts}；${cleanup}。`;
}

export type ZeroResultEntry = "cli" | "tui" | "workbench";

export function formatZeroResultExclusionHint(entry: ZeroResultEntry): string {
  switch (entry) {
    case "cli":
      return "可能有位置依預設排除規則不索引；可執行 seekah explain <路徑> 檢查為何搜不到（相容別名：docsearch explain <路徑>）。";
    case "tui":
      return "可能有位置依預設排除規則不索引；請使用 /explain <路徑> 檢查。";
    case "workbench":
      return "可能有位置依預設排除規則不索引；請在下方輸入檔案路徑檢查。";
  }
}
