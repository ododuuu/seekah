import { loadIgnoreRules, loadIgnoreRulesSync } from "./ignore.js";
import {
  listDefaultExclusions,
  matchExclusion,
  type DefaultExclusionRule,
  type ExclusionExplanation,
  type ExclusionScope,
} from "./default-exclusions.js";
import type { IndexStore } from "./store.js";

/**
 * 與完整掃描、校正、watcher 及局部更新共用的 immutable 排除 context。
 * `isDirectory` 為 undefined 表示路徑已不存在、型態未知：當作檔案或目錄任一被排除即排除。
 */
export class RootExclusion {
  private constructor(
    readonly root: string,
    private readonly scopes: readonly ExclusionScope[],
    private readonly databasePath?: string,
  ) {}

  /** 只有內建規則，用於使用者規則檔設定錯誤時；volume-default 仍保留。 */
  static builtinOnly(root: string, databasePath?: string): RootExclusion {
    return new RootExclusion(root, [], databasePath);
  }

  static async load(root: string, store: IndexStore): Promise<RootExclusion> {
    return RootExclusion.loadWithExtraIgnoreBases(root, store.ignoreBases(root), store.databasePath);
  }

  static async loadWithExtraIgnoreBases(
    root: string,
    extraIgnoreBases: readonly string[] = [],
    databasePath?: string,
  ): Promise<RootExclusion> {
    const scopes: ExclusionScope[] = [{ base: root, rules: await loadIgnoreRules(root) }];
    for (const base of extraIgnoreBases) scopes.push({ base, rules: await loadIgnoreRules(base) });
    return new RootExclusion(root, scopes, databasePath);
  }

  static loadSync(root: string, store: IndexStore): RootExclusion {
    return RootExclusion.loadSyncWithExtraIgnoreBases(root, store.ignoreBases(root), store.databasePath);
  }

  static loadSyncWithExtraIgnoreBases(
    root: string,
    extraIgnoreBases: readonly string[] = [],
    databasePath?: string,
  ): RootExclusion {
    const scopes: ExclusionScope[] = [{ base: root, rules: loadIgnoreRulesSync(root) }];
    for (const base of extraIgnoreBases) scopes.push({ base, rules: loadIgnoreRulesSync(base) });
    return new RootExclusion(root, scopes, databasePath);
  }

  excludes(absPath: string, isDirectory: boolean | undefined, isLink = false): boolean {
    return this.explain(absPath, isDirectory, isLink).excluded;
  }

  explain(absPath: string, isDirectory: boolean | undefined, isLink = false): ExclusionExplanation {
    return matchExclusion(this.root, absPath, isDirectory, this.scopes, this.databasePath, isLink);
  }

  defaultRules(): DefaultExclusionRule[] {
    return listDefaultExclusions(this.root);
  }
}
