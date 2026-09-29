import { IndexBusyError, isSqliteBusy } from "./write-lock.js";

/** SQLite SQLITE_READONLY_ROLLBACK */
export const SQLITE_READONLY_ROLLBACK = 776;
/** SQLite SQLITE_READONLY_CANTINIT */
export const SQLITE_READONLY_CANTINIT = 1288;
/** SQLite SQLITE_CANTOPEN_DIRTYWAL */
export const SQLITE_CANTOPEN_DIRTYWAL = 1294;

export const INDEX_BUSY_CLIENT_MESSAGE = "INDEX_BUSY：索引目前由另一個程序使用，請稍後重試。";

export const INDEX_RECOVERY_REQUIRED_MESSAGE =
  "INDEX_RECOVERY_REQUIRED：索引有未完成交易，需要由下一次 index 安全回復；請勿刪除 journal 或 WAL。";

export type IndexClientErrorKind = "busy" | "recovery";

export function isRecoveryRequired(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const errcode = Reflect.get(error, "errcode");
  return errcode === SQLITE_READONLY_ROLLBACK
    || errcode === SQLITE_READONLY_CANTINIT
    || errcode === SQLITE_CANTOPEN_DIRTYWAL;
}

export function classifyIndexClientError(error: unknown): IndexClientErrorKind | undefined {
  if (typeof error === "string") {
    if (error.includes("database is locked")) return "busy";
    if (error.includes("INDEX_RECOVERY_REQUIRED")) return "recovery";
    return undefined;
  }
  if (isRecoveryRequired(error)) return "recovery";
  if (error instanceof IndexBusyError || isSqliteBusy(error)) return "busy";
  if (error instanceof Error && error.message.includes("database is locked")) return "busy";
  return undefined;
}

export function describeIndexClientError(error: unknown): string | undefined {
  const kind = classifyIndexClientError(error);
  if (kind === "busy") return INDEX_BUSY_CLIENT_MESSAGE;
  if (kind === "recovery") return INDEX_RECOVERY_REQUIRED_MESSAGE;
  return undefined;
}

export function sanitizeRecentError(entry: string): string {
  return describeIndexClientError(entry) ?? entry;
}
