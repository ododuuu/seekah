import { mkdirSync, realpathSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";

export class IndexBusyError extends Error {
  readonly code = "INDEX_BUSY";
  constructor() {
    super("另一個索引寫入正在進行，請稍後重試；搜尋仍可使用。");
    this.name = "IndexBusyError";
  }
}

function isSqliteBusyMessage(value: unknown): boolean {
  return value === "database is locked" || value === "database table is locked";
}

export function isSqliteBusy(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  if (isSqliteBusyMessage(Reflect.get(error, "errstr"))
    || isSqliteBusyMessage(Reflect.get(error, "message"))) return true;
  const errcode = Reflect.get(error, "errcode");
  if (typeof errcode === "number" && ((errcode & 0xff) === 5 || (errcode & 0xff) === 6)) return true;
  const code = Reflect.get(error, "code");
  return typeof code === "string" && /^SQLITE_(?:BUSY|LOCKED)(?:_|$)/u.test(code);
}

// 留在本機的協調資料庫，不保存文件文字，也不以檔案是否存在判斷忙碌。
export function acquireWriteLock(databasePath: string): () => void {
  const directory = path.dirname(path.resolve(databasePath));
  mkdirSync(directory, { recursive: true });
  const canonical = (() => {
    try { return realpathSync(databasePath); }
    catch { return path.join(realpathSync(directory), path.basename(databasePath)); }
  })();
  // Node.js 22.16.0 起可在開庫時安裝 busy timeout；目標 22.17.0 已支援，
  // 但目前 @types/node 尚未包含該欄位。開庫即設為 0，避免 Windows 在
  // 第一個 BEGIN IMMEDIATE 前沿用非零等待狀態。
  const options = { timeout: 0 } as ConstructorParameters<typeof DatabaseSync>[1];
  const lock = new DatabaseSync(`${canonical}.writer.sqlite`, options);
  try {
    // 必須分開執行：先安裝零等待 busy handler，再嘗試取得交易鎖。
    // Windows 上若合併交給 sqlite3_exec，競爭程序可能沿用非零等待設定。
    lock.exec("PRAGMA busy_timeout = 0");
    lock.exec("BEGIN IMMEDIATE");
  } catch (error) {
    lock.close();
    if (isSqliteBusy(error)) throw new IndexBusyError();
    throw error;
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    try { lock.exec("ROLLBACK"); } finally { lock.close(); }
  };
}
