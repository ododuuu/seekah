import { existsSync, lstatSync } from "node:fs";
import path from "node:path";
import { IGNORE_FILE, loadIgnoreRulesSync } from "./ignore.js";
import { listDefaultExclusions } from "./default-exclusions.js";
import { RootExclusion } from "./root-exclusion.js";
import { coversPath, resolveUserRootPath, samePath, runtimePathPlatform } from "./root-plan.js";
import type { DocumentStatus } from "./model.js";
import type { IndexStore } from "./store.js";
import { cachedExclusionPolicies } from "./index-status-cache.js";
import {
  pathResultFromExplanation,
  type ExclusionIgnoreFile,
  type ExclusionPathResult,
  type ExclusionPolicy,
  type ExclusionPolicyRule,
} from "./describe-exclusion.js";

const FILENAME_ONLY_STATUSES = new Set<DocumentStatus>(["unsupported", "too_large", "encrypted"]);

function historicalRuleCounts(store: IndexStore, root: string): Record<string, number> | undefined {
  const summary = store.getLastSyncReport(root).summary as { skipped?: { byRule?: unknown } } | null;
  const byRule = summary?.skipped?.byRule;
  if (!byRule || typeof byRule !== "object" || Array.isArray(byRule)) return undefined;
  const result: Record<string, number> = {};
  for (const [ruleId, count] of Object.entries(byRule as Record<string, unknown>)) {
    if (typeof count === "number" && Number.isFinite(count) && count >= 0) result[ruleId] = count;
  }
  return result;
}

function ignoreFilePolicy(base: string): ExclusionIgnoreFile {
  const filePath = path.join(base, IGNORE_FILE);
  const exists = existsSync(filePath);
  try {
    const rules = loadIgnoreRulesSync(base);
    return { base, path: filePath, exists, patterns: [...rules.patterns] };
  } catch {
    return { base, path: filePath, exists, patterns: [], errorCode: "IGNORE_CONFIGURATION_ERROR" };
  }
}

function uniqueBases(root: string, extraBases: readonly string[]): string[] {
  const bases: string[] = [];
  for (const base of [root, ...extraBases]) {
    if (!bases.some(item => samePath(item, base))) bases.push(base);
  }
  return bases;
}

export function previewExclusionPolicy(rootInput: string): ExclusionPolicy {
  const root = resolveUserRootPath(rootInput);
  const rules: ExclusionPolicyRule[] = listDefaultExclusions(root);
  return {
    root,
    rules,
    ignoreFiles: [],
  };
}

function buildExclusionPolicy(store: IndexStore, root: string): ExclusionPolicy {
  const counts = historicalRuleCounts(store, root);
  const rules: ExclusionPolicyRule[] = listDefaultExclusions(root).map(rule => ({
    ...rule,
    ...(counts ? { lastSkipped: counts[rule.id] ?? 0 } : {}),
  }));
  const ignoreFiles = uniqueBases(root, store.ignoreBases(root)).map(ignoreFilePolicy);
  const cleanup = store.getLastSyncReport(root).summary?.exclusionCleanup;
  return {
    root,
    rules,
    ignoreFiles,
    ...(counts ? { skippedByRule: counts } : {}),
    ...(cleanup ? { exclusionCleanup: cleanup } : {}),
  };
}

export function readExclusionPolicy(store: IndexStore, root: string): ExclusionPolicy {
  return cachedExclusionPolicies(
    store,
    [root],
    () => [buildExclusionPolicy(store, root)],
    policies => policies.flatMap(policy => policy.ignoreFiles.map(ignoreFile => ignoreFile.path)),
  )[0]!;
}

export function readExclusionPolicies(store: IndexStore, roots?: readonly string[]): ExclusionPolicy[] {
  return cachedExclusionPolicies(
    store,
    roots,
    () => {
      const rootList = roots ?? store.roots();
      return rootList.map(root => buildExclusionPolicy(store, root));
    },
    policies => policies.flatMap(policy => policy.ignoreFiles.map(ignoreFile => ignoreFile.path)),
  );
}

function matchingRoot(store: IndexStore, absPath: string): string | null {
  const roots = store.roots().filter(root => coversPath(root, absPath, runtimePathPlatform()));
  roots.sort((left, right) => right.length - left.length);
  return roots[0] ?? null;
}

function fileFacts(absPath: string): { exists: boolean; isDirectory: boolean | undefined; isLink: boolean } {
  try {
    const info = lstatSync(absPath);
    return { exists: true, isDirectory: info.isDirectory(), isLink: info.isSymbolicLink() };
  } catch {
    return { exists: false, isDirectory: undefined, isLink: false };
  }
}

function documentStatus(store: IndexStore, absPath: string): { status: DocumentStatus | null; errorCode: string | null } {
  const caseInsensitive = runtimePathPlatform() === "win32";
  const row = caseInsensitive ? store.getDocumentCaseInsensitive(absPath) : store.getDocument(absPath);
  const issue = caseInsensitive ? store.getDocumentIssueCaseInsensitive(absPath) : store.getDocumentIssue(absPath);
  const status = row?.status ?? issue?.status ?? null;
  return { status, errorCode: issue?.errorCode ?? null };
}

export function explainPathSync(store: IndexStore, input: string): ExclusionPathResult {
  const absPath = resolveUserRootPath(input);
  const root = matchingRoot(store, absPath);
  if (!root) {
    return {
      path: absPath,
      root: null,
      state: "outside-root",
      source: null,
      ruleId: null,
      matchedRule: null,
      matchedPath: null,
      base: null,
      documentStatus: null,
      errorCode: null,
    };
  }
  const facts = fileFacts(absPath);
  const document = documentStatus(store, absPath);
  let explanation;
  try {
    const exclusion = RootExclusion.loadSync(root, store);
    explanation = exclusion.explain(absPath, facts.isDirectory, facts.isLink);
  } catch {
    return {
      path: absPath,
      root,
      state: "parse-failed",
      exists: facts.exists,
      source: null,
      ruleId: null,
      matchedRule: null,
      matchedPath: null,
      base: null,
      documentStatus: document.status,
      errorCode: "IGNORE_CONFIGURATION_ERROR",
    };
  }
  if (explanation.excluded) {
    return pathResultFromExplanation({
      path: absPath,
      root,
      state: "excluded",
      exists: facts.exists,
      documentStatus: document.status,
      errorCode: document.errorCode,
    }, explanation);
  }
  if (document.status === "error") {
    return { path: absPath, root, state: "parse-failed", exists: facts.exists, source: null, ruleId: null,
      matchedRule: null, matchedPath: null, base: null, documentStatus: document.status, errorCode: document.errorCode };
  }
  if (document.status && FILENAME_ONLY_STATUSES.has(document.status)) {
    return { path: absPath, root, state: "filename-only", exists: facts.exists, source: null, ruleId: null,
      matchedRule: null, matchedPath: null, base: null, documentStatus: document.status, errorCode: document.errorCode };
  }
  if (document.status) {
    return { path: absPath, root, state: "indexed", exists: facts.exists, source: null, ruleId: null,
      matchedRule: null, matchedPath: null, base: null, documentStatus: document.status, errorCode: document.errorCode };
  }
  return { path: absPath, root, state: "unindexed", exists: facts.exists, source: null, ruleId: null,
    matchedRule: null, matchedPath: null, base: null, documentStatus: null, errorCode: null };
}