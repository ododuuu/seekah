import path from "node:path";
const artifactPathCache = new Map<string, ReadonlySet<string>>();

export function indexArtifactPaths(databasePath: string): string[] {
  const resolved = path.resolve(databasePath);
  const dir = path.dirname(resolved);
  return [
    resolved,
    `${resolved}-wal`, `${resolved}-shm`, `${resolved}-journal`,
    `${resolved}.writer.sqlite`, `${resolved}.writer.sqlite-wal`, `${resolved}.writer.sqlite-shm`, `${resolved}.writer.sqlite-journal`,
    `${resolved}.live.sqlite`, `${resolved}.live.sqlite-wal`, `${resolved}.live.sqlite-shm`, `${resolved}.live.sqlite-journal`,
    `${resolved}.work.sqlite`, `${resolved}.work.sqlite-wal`, `${resolved}.work.sqlite-shm`, `${resolved}.work.sqlite-journal`,
    path.join(dir, "autoupdate.json"),
    path.join(dir, "autoupdate.json.tmp"),
    path.join(dir, "autoupdate.log"),
    path.join(dir, "autoupdate.log.1"),
    path.join(dir, "autoupdate.log.2"),
    path.join(dir, "autoupdate.log.3"),
    path.join(dir, "autoupdate.log.4"),
    path.join(dir, "indexing.json"),
    path.join(dir, "indexing.json.tmp"),
    path.join(dir, "trace.log"),
    path.join(dir, "trace.log.1"),
    path.join(dir, "trace.log.2"),
    path.join(dir, "trace.log.3"),
    path.join(dir, "trace.log.4"),
  ];
}

function cachedArtifactPaths(databasePath: string): ReadonlySet<string> {
  const resolved = path.resolve(databasePath);
  const cached = artifactPathCache.get(resolved);
  if (cached) return cached;
  const paths = new Set(indexArtifactPaths(resolved));
  artifactPathCache.set(resolved, paths);
  return paths;
}

export function isIndexArtifact(filePath: string, databasePath: string): boolean {
  const resolved = path.resolve(filePath);
  if (cachedArtifactPaths(databasePath).has(resolved)) return true;
  const base = path.basename(resolved);
  return base.startsWith("autoupdate-") && (base.endsWith(".sock") || base.endsWith(".sock.tmp"));
}
