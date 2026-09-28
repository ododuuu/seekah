import path from "node:path";
import { loadIgnoreRules, loadIgnoreRulesSync, type IgnoreRules } from "./ignore.js";
import { isWindowsVolumeSystemPath } from "./builtin-paths.js";
import { coversPath, samePath } from "./root-plan.js";
import type { IndexStore } from "./store.js";

const BUILTIN_DIRECTORIES: Record<string, true> = {
  ".git": true,
  node_modules: true,
  ".localdocsearch": true,
};

type Scope = { base: string; rules: IgnoreRules };

/**
 * 與完整掃描相同的排除結果：任一上層目錄或路徑本身被排除即排除（SPEC §53.1）。
 * `isDirectory` 為 undefined 表示路徑已不存在、型態未知：當作檔案或目錄任一被排除即排除。
 */
export class RootExclusion {
  private constructor(readonly root: string, private readonly scopes: Scope[]) {}

  /** 只有內建規則，用於使用者規則檔設定錯誤時。 */
  static builtinOnly(root: string): RootExclusion {
    return new RootExclusion(root, []);
  }

  static async load(root: string, store: IndexStore): Promise<RootExclusion> {
    const scopes: Scope[] = [{ base: root, rules: await loadIgnoreRules(root) }];
    for (const base of store.ignoreBases(root)) scopes.push({ base, rules: await loadIgnoreRules(base) });
    return new RootExclusion(root, scopes);
  }

  static loadSync(root: string, store: IndexStore): RootExclusion {
    const scopes: Scope[] = [{ base: root, rules: loadIgnoreRulesSync(root) }];
    for (const base of store.ignoreBases(root)) scopes.push({ base, rules: loadIgnoreRulesSync(base) });
    return new RootExclusion(root, scopes);
  }

  excludes(absPath: string, isDirectory: boolean | undefined): boolean {
    if (samePath(absPath, this.root) || !coversPath(this.root, absPath)) return false;
    const parts = path.relative(this.root, absPath).split(/[\\/]+/u).filter(Boolean);
    let current = this.root;
    for (let index = 0; index < parts.length; index++) {
      current = path.join(current, parts[index]!);
      const leaf = index === parts.length - 1;
      if (!leaf || isDirectory !== false) {
        if (this.excludesDirectory(current, parts[index]!)) return true;
      }
      if (leaf && isDirectory !== true && this.excludesFile(current, parts[index]!)) return true;
    }
    return false;
  }

  private excludesDirectory(fullPath: string, name: string): boolean {
    if (BUILTIN_DIRECTORIES[name.toLowerCase()] === true || isWindowsVolumeSystemPath(fullPath)) return true;
    return this.matchesRules(fullPath, true);
  }

  private excludesFile(fullPath: string, name: string): boolean {
    if (name.startsWith("~$")) return true;
    return this.matchesRules(fullPath, false);
  }

  private matchesRules(fullPath: string, isDirectory: boolean): boolean {
    return this.scopes.some(scope => (samePath(scope.base, this.root) || coversPath(scope.base, fullPath))
      && !samePath(scope.base, fullPath)
      && scope.rules.matches(path.relative(scope.base, fullPath), isDirectory));
  }
}
