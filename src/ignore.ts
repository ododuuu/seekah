import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

export const IGNORE_FILE = ".localdocsearchignore";

export class IgnoreConfigurationError extends Error {}

interface IgnoreRule {
  directoryOnly: boolean;
  regex: RegExp;
}

function escapeRegex(character: string): string {
  return /[\\^$.*+?()[\]{}|]/.test(character) ? `\\${character}` : character;
}

function globRegex(pattern: string): string {
  let result = "";
  for (let index = 0; index < pattern.length; index++) {
    const character = pattern[index]!;
    if (character === "*") {
      if (pattern[index + 1] === "*") {
        index++;
        if (pattern[index + 1] === "/") {
          index++;
          result += "(?:.*/)?";
        } else {
          result += ".*";
        }
      } else {
        result += "[^/]*";
      }
    } else if (character === "?") {
      result += "[^/]";
    } else {
      result += escapeRegex(character);
    }
  }
  return result;
}

export class IgnoreRules {
  private constructor(private readonly rules: IgnoreRule[]) {}
  readonly patterns: string[] = [];
  sourcePath: string | null = null;

  static parse(content: string): IgnoreRules {
    const rules: IgnoreRule[] = [];
    const patterns: string[] = [];
    for (const sourceLine of content.split(/\r?\n/u)) {
      let pattern = sourceLine.trim();
      if (!pattern || pattern.startsWith("#")) continue;
      patterns.push(pattern);
      if (pattern.startsWith("!")) {
        throw new IgnoreConfigurationError(`${IGNORE_FILE} 尚不支援以 ! 重新納入路徑：${sourceLine}`);
      }
      pattern = pattern.replaceAll("\\", "/").replace(/^\.\//u, "");
      const anchored = pattern.startsWith("/");
      if (anchored) pattern = pattern.slice(1);
      const directoryOnly = pattern.endsWith("/");
      pattern = pattern.replace(/\/+$/u, "");
      if (!pattern) continue;
      const body = globRegex(pattern);
      const prefix = anchored || pattern.includes("/") ? "^" : "(?:^|/)";
      const suffix = directoryOnly ? "(?:$|/)" : "$";
      rules.push({ directoryOnly, regex: new RegExp(`${prefix}${body}${suffix}`, "iu") });
    }
    const parsed = new IgnoreRules(rules);
    parsed.patterns.push(...patterns);
    return parsed;
  }

  matches(relativePath: string, isDirectory: boolean): boolean {
    const normalized = relativePath.replaceAll(path.sep, "/").replaceAll("\\", "/");
    return this.rules.some(rule => (!rule.directoryOnly || isDirectory) && rule.regex.test(normalized));
  }
}

function parseIgnoreFile(root: string, read: () => string): IgnoreRules {
  try {
    const rules = IgnoreRules.parse(read());
    rules.sourcePath = path.join(root, IGNORE_FILE);
    return rules;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return IgnoreRules.parse("");
    if (error instanceof IgnoreConfigurationError) throw error;
    throw new IgnoreConfigurationError(`無法讀取 ${path.join(root, IGNORE_FILE)}：${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function loadIgnoreRules(root: string): Promise<IgnoreRules> {
  let content: string;
  try {
    content = await readFile(path.join(root, IGNORE_FILE), "utf8");
  } catch (error) {
    return parseIgnoreFile(root, () => { throw error; });
  }
  return parseIgnoreFile(root, () => content);
}

/** 監看層在事件 callback 內同步判斷排除，不能等待 IO。 */
export function loadIgnoreRulesSync(root: string): IgnoreRules {
  return parseIgnoreFile(root, () => readFileSync(path.join(root, IGNORE_FILE), "utf8"));
}
