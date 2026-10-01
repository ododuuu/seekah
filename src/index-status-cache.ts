import { statSync } from "node:fs";
import path from "node:path";

export interface IndexStatusCacheStore {
  readonly databasePath: string;
  dataVersion(): number;
}

interface CacheEntry<T> {
  dataVersion: number;
  databaseSignature: string;
  fileSignatures: Map<string, string>;
  value: T;
}

const MAX_STATUS_ENTRIES = 16;
const MAX_EXCLUSION_ENTRIES = 32;
const EXCLUSION_POLICY_VERSION = 1;
const statusEntries = new Map<string, CacheEntry<unknown>>();
const exclusionEntries = new Map<string, CacheEntry<unknown>>();

function fileSignature(filePath: string): string {
  try {
    const info = statSync(filePath);
    return `present:${info.mtimeMs}:${info.size}`;
  } catch (error) {
    let code = "unknown";
    if (error instanceof Error && "code" in error) code = String(error.code);
    return code === "ENOENT" ? "missing" : `error:${code}`;
  }
}

function databaseSignature(databasePath: string): string {
  return [databasePath, `${databasePath}-wal`].map(filePath => fileSignature(filePath)).join("|");
}

function collectFileSignatures(paths: readonly string[]): Map<string, string> {
  const signatures = new Map<string, string>();
  for (const filePath of paths) signatures.set(filePath, fileSignature(filePath));
  return signatures;
}

function filesUnchanged(signatures: ReadonlyMap<string, string>): boolean {
  for (const [filePath, signature] of signatures) {
    if (fileSignature(filePath) !== signature) return false;
  }
  return true;
}

function remember<T>(entries: Map<string, CacheEntry<unknown>>, limit: number, key: string, entry: CacheEntry<T>): void {
  entries.delete(key);
  entries.set(key, entry);
  while (entries.size > limit) entries.delete(entries.keys().next().value!);
}

export function cachedIndexStatus<T extends object>(
  store: IndexStatusCacheStore,
  compute: () => T,
  dependencyPaths: (value: T) => readonly string[],
): T {
  const key = path.resolve(store.databasePath);
  const dataVersion = store.dataVersion();
  const dbSignature = databaseSignature(store.databasePath);
  const cached = statusEntries.get(key);
  if (cached && cached.dataVersion === dataVersion && cached.databaseSignature === dbSignature
    && filesUnchanged(cached.fileSignatures)) {
    return structuredClone(cached.value) as T;
  }
  const value = compute();
  const cachedValue = structuredClone(value);
  remember(statusEntries, MAX_STATUS_ENTRIES, key, {
    dataVersion,
    databaseSignature: databaseSignature(store.databasePath),
    fileSignatures: collectFileSignatures(dependencyPaths(value)),
    value: cachedValue,
  });
  return structuredClone(cachedValue);
}

export function cachedExclusionPolicies<T>(
  store: IndexStatusCacheStore,
  roots: readonly string[] | undefined,
  compute: () => T,
  dependencyPaths: (value: T) => readonly string[],
): T {
  const databaseKey = path.resolve(store.databasePath);
  const rootKey = roots ? JSON.stringify(roots) : "*";
  const key = `${databaseKey}\0${EXCLUSION_POLICY_VERSION}\0${rootKey}`;
  const dataVersion = store.dataVersion();
  const dbSignature = databaseSignature(store.databasePath);
  const cached = exclusionEntries.get(key);
  if (cached && cached.dataVersion === dataVersion && cached.databaseSignature === dbSignature
    && filesUnchanged(cached.fileSignatures)) {
    return structuredClone(cached.value) as T;
  }
  const value = compute();
  const cachedValue = structuredClone(value);
  remember(exclusionEntries, MAX_EXCLUSION_ENTRIES, key, {
    dataVersion,
    databaseSignature: databaseSignature(store.databasePath),
    fileSignatures: collectFileSignatures(dependencyPaths(value)),
    value: cachedValue,
  });
  return structuredClone(cachedValue);
}

export function invalidateIndexStatusCache(databasePath: string): void {
  const key = path.resolve(databasePath);
  statusEntries.delete(key);
  const prefix = `${key}\0`;
  for (const exclusionKey of exclusionEntries.keys()) {
    if (exclusionKey.startsWith(prefix)) exclusionEntries.delete(exclusionKey);
  }
}

export function clearIndexStatusCache(): void {
  statusEntries.clear();
  exclusionEntries.clear();
}
