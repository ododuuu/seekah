import { formatExclusionPolicySummary, type ExclusionPolicy } from "./describe-exclusion.js";
import { readExclusionPolicies } from "./exclusion-visibility.js";
import { previewStatusList } from "./status-preview.js";
import type { Diagnostic, SyncSummary } from "./model.js";
import type {
  ExtensionStats, IndexFormatStatus, IndexStore, StorageFootprint, StoredIssue,
} from "./store.js";

export const STATUS_JSON_SCHEMA_VERSION = 1 as const;
export const STATUS_TEXT_UPGRADE_NOTE = "此數由已存 metadata 推導，不是磁碟精確剩餘工作量。";

export interface StatusJsonList<T> {
  items: T[];
  total: number;
  truncated: boolean;
}

export interface StatusJsonRoot {
  path: string;
  lastAttemptedSync: string | null;
  lastSuccessfulSync: string | null;
  lastSyncComplete: boolean | null;
  recentSync: {
    summary: SyncSummary | null;
    diagnostics: StatusJsonList<Diagnostic>;
    errors: StatusJsonList<string>;
    notices: StatusJsonList<string>;
  };
  exclusion: {
    policy: ExclusionPolicy;
    summary: string;
  };
}

export interface StatusJson {
  schemaVersion: typeof STATUS_JSON_SCHEMA_VERSION;
  databasePath: string;
  readOnly: true;
  format: IndexFormatStatus;
  textUpgrade: {
    pending: number;
    byExtension: { extension: string; count: number }[];
    note: string;
  };
  storage: StorageFootprint;
  roots: StatusJsonRoot[];
  counts: Record<string, number>;
  documentIssues: {
    total: number;
    items: StoredIssue[];
  };
  extensionStats: {
    included: boolean;
    items: ExtensionStats[];
  };
  options: {
    issues: boolean;
    types: boolean;
  };
}

export interface StatusJsonOptions {
  includeIssues: boolean;
  includeTypes: boolean;
}

function diagnosticList(items: readonly Diagnostic[], includeItems: boolean): StatusJsonList<Diagnostic> {
  return {
    items: includeItems ? [...items] : [],
    total: items.length,
    truncated: false,
  };
}

function stringList(items: readonly string[]): StatusJsonList<string> {
  const preview = previewStatusList(items);
  return {
    items: preview.items,
    total: preview.total,
    truncated: preview.truncated,
  };
}

export function buildStatusJson(
  store: IndexStore,
  roots: readonly string[],
  options: StatusJsonOptions,
): StatusJson {
  const format = store.formatStatus();
  const policies = readExclusionPolicies(store, roots);
  const policyByRoot = new Map(policies.map(policy => [policy.root, policy]));
  const rootStatus = roots.map(root => {
    const report = store.getLastSyncReport(root);
    const policy = policyByRoot.get(root) ?? {
      root,
      rules: [],
      ignoreFiles: [],
    } satisfies ExclusionPolicy;
    return {
      path: root,
      lastAttemptedSync: report.attemptedAt,
      lastSuccessfulSync: report.successfulAt,
      lastSyncComplete: report.complete,
      recentSync: {
        summary: report.summary,
        diagnostics: diagnosticList(report.diagnostics, options.includeIssues),
        errors: stringList(report.errors),
        notices: stringList(report.notices),
      },
      exclusion: {
        policy,
        summary: formatExclusionPolicySummary(policy),
      },
    } satisfies StatusJsonRoot;
  });
  const documentIssues = store.documentIssues();
  return {
    schemaVersion: STATUS_JSON_SCHEMA_VERSION,
    databasePath: store.databasePath,
    readOnly: true,
    format,
    textUpgrade: {
      pending: format.textUpgradePending,
      byExtension: format.textUpgradeByExtension,
      note: STATUS_TEXT_UPGRADE_NOTE,
    },
    storage: store.storageFootprint(),
    roots: rootStatus,
    counts: store.counts(),
    documentIssues: {
      total: documentIssues.length,
      items: options.includeIssues ? documentIssues : [],
    },
    extensionStats: {
      included: options.includeTypes,
      items: options.includeTypes ? store.extensionStats() : [],
    },
    options: {
      issues: options.includeIssues,
      types: options.includeTypes,
    },
  };
}

export function serializeVersionedJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function serializeVersionedJsonError(code: string, message: string): string {
  return serializeVersionedJson({
    schemaVersion: STATUS_JSON_SCHEMA_VERSION,
    error: { code, message },
  });
}
