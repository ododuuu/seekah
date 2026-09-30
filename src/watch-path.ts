import path from "node:path";
import { isWindowsVolumeSystemPath } from "./builtin-paths.js";
import { runtimePathPlatform, type PathPlatform } from "./root-plan.js";
import type { RootExclusion } from "./root-exclusion.js";
const IGNORED_SEGMENT = /(?:^|[\\/])(?:\.git|node_modules|\.localdocsearch)(?:[\\/]|$)/i;

export function shouldIgnoreWatchPath(
  relativeOrAbsolute: string,
  root?: string,
  platform: PathPlatform = runtimePathPlatform(),
  exclusion?: RootExclusion,
  isDirectory?: boolean,
  isLink = false,
): boolean {
  const flavor = platform === "win32" ? path.win32 : path.posix;
  if (exclusion) {
    const candidate = root ? flavor.resolve(root, relativeOrAbsolute) : relativeOrAbsolute;
    return exclusion.excludes(candidate, isDirectory, isLink);
  }
  const normalized = relativeOrAbsolute.replace(/\\/g, "/");
  if (IGNORED_SEGMENT.test(normalized)) return true;
  const base = path.posix.basename(normalized);
  if (base.startsWith("~$")) return true;
  if (!root) return isWindowsVolumeSystemPath(relativeOrAbsolute, platform);
  return isWindowsVolumeSystemPath(flavor.resolve(root, relativeOrAbsolute), platform);
}
