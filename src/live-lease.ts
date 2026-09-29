import { mkdirSync, realpathSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { isSqliteBusy } from "./write-lock.js";

export class LiveBusyError extends Error {
  readonly code = "LIVE_INSTANCE_ACTIVE";
  constructor(message = "相同索引已有持續更新實例正在執行。") {
    super(message);
    this.name = "LiveBusyError";
  }
}

export function canonicalIndexPath(databasePath: string): string {
  const directory = path.dirname(path.resolve(databasePath));
  mkdirSync(directory, { recursive: true });
  try { return realpathSync(databasePath); }
  catch { return path.join(realpathSync(directory), path.basename(databasePath)); }
}

export function liveLeasePath(databasePath: string): string {
  return `${canonicalIndexPath(databasePath)}.live.sqlite`;
}

/** 獨立於 writer lock 的持續更新單例；待機時仍可持有，但不得因此持有索引寫入鎖。 */
export function acquireLiveLease(databasePath: string): () => void {
  const canonical = canonicalIndexPath(databasePath);
  const options = { timeout: 0 } as ConstructorParameters<typeof DatabaseSync>[1];
  const lock = new DatabaseSync(`${canonical}.live.sqlite`, options);
  try {
    lock.exec("PRAGMA busy_timeout = 0");
    lock.exec("BEGIN IMMEDIATE");
  } catch (error) {
    lock.close();
    if (isSqliteBusy(error)) throw new LiveBusyError();
    throw error;
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    try { lock.exec("ROLLBACK"); } finally { lock.close(); }
  };
}
