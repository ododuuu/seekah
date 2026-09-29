/** SQLite SQLITE_READONLY_ROLLBACK */
export const SQLITE_READONLY_ROLLBACK = 776;
/** SQLite SQLITE_READONLY_CANTINIT */
export const SQLITE_READONLY_CANTINIT = 1288;
/** SQLite SQLITE_CANTOPEN_DIRTYWAL */
export const SQLITE_CANTOPEN_DIRTYWAL = 1294;

export const INDEX_RECOVERY_REQUIRED_MESSAGE =
  "INDEX_RECOVERY_REQUIRED：索引有未完成交易，需要由下一次 index 安全回復；請勿刪除 journal 或 WAL。";

export function isRecoveryRequired(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const errcode = Reflect.get(error, "errcode");
  return errcode === SQLITE_READONLY_ROLLBACK
    || errcode === SQLITE_READONLY_CANTINIT
    || errcode === SQLITE_CANTOPEN_DIRTYWAL;
}
