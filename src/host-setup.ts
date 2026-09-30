import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { MCP_APP_HTML, MCP_APP_MIME_TYPE, MCP_APP_RESOURCE_URI } from "./mcp-app.js";
import { createMcpServer, MCP_TOOL_NAMES } from "./mcp.js";
import { IndexStore } from "./store.js";

export interface CommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
  errorCode?: string;
}

export type CommandRunner = (command: string, args: readonly string[]) => CommandResult;

function runCommand(command: string, args: readonly string[]): CommandResult {
  const result = spawnSync(command, [...args], { encoding: "utf8", shell: false });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    ...(result.error && "code" in result.error && typeof result.error.code === "string" ? { errorCode: result.error.code } : {}),
  };
}

function comparablePath(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLocaleLowerCase("en-US") : resolved;
}

function isSameRegistration(value: unknown, nodePath: string, cliPath: string): boolean {
  if (!value || typeof value !== "object") return false;
  const transport = (value as { transport?: unknown }).transport;
  if (!transport || typeof transport !== "object") return false;
  const typed = transport as { type?: unknown; command?: unknown; args?: unknown };
  if (typed.type !== "stdio" || typeof typed.command !== "string" || !Array.isArray(typed.args)) return false;
  const args = typed.args.filter((item): item is string => typeof item === "string");
  return args.length === 2
    && comparablePath(typed.command) === comparablePath(nodePath)
    && comparablePath(args[0]!) === comparablePath(cliPath)
    && args[1] === "mcp";
}

export interface SetupCodexOptions {
  cliPath: string;
  nodePath?: string;
  dryRun?: boolean;
  runner?: CommandRunner;
  write?: (text: string) => void;
  writeError?: (text: string) => void;
}

export function setupCodex(options: SetupCodexOptions): number {
  const nodePath = path.resolve(options.nodePath ?? process.execPath);
  const cliPath = path.resolve(options.cliPath);
  const write = options.write ?? console.log;
  const writeError = options.writeError ?? console.error;
  const registration = { name: "localdocsearch", command: nodePath, args: [cliPath, "mcp"] };
  if (options.dryRun) {
    write("預覽：不會修改 Codex 設定。");
    write(JSON.stringify(registration, null, 2));
    return 0;
  }
  if (!existsSync(cliPath)) {
    writeError(`SETUP_CLI_MISSING：找不到已建置的 CLI：${cliPath}`);
    return 3;
  }
  const runner = options.runner ?? runCommand;
  const current = runner("codex", ["mcp", "get", "localdocsearch", "--json"]);
  if (current.errorCode === "ENOENT") {
    writeError("SETUP_CODEX_MISSING：找不到 codex 命令；請先安裝或更新 Codex CLI。");
    return 3;
  }
  if (current.status === 0) {
    let parsed: unknown;
    try { parsed = JSON.parse(current.stdout); }
    catch {
      writeError("SETUP_CODEX_RESPONSE_INVALID：Codex 回傳的既有 MCP 設定不是有效 JSON。");
      return 4;
    }
    if (isSameRegistration(parsed, nodePath, cliPath)) {
      write("Codex 已註冊相同的 localdocsearch，不需變更。");
      return 0;
    }
    writeError("SETUP_CONFLICT：Codex 已有同名 localdocsearch，但指向不同安裝；為避免覆寫，未修改設定。請先人工核對並執行 codex mcp remove localdocsearch。");
    return 3;
  }
  const lookupText = `${current.stdout}\n${current.stderr}`;
  if (current.status !== 1 || !/No MCP server named|not found/iu.test(lookupText)) {
    writeError("SETUP_CODEX_QUERY_FAILED：無法安全確認既有 Codex MCP 設定，未進行註冊。");
    return 4;
  }
  const added = runner("codex", ["mcp", "add", "localdocsearch", "--", nodePath, cliPath, "mcp"]);
  if (added.errorCode === "ENOENT") {
    writeError("SETUP_CODEX_MISSING：找不到 codex 命令；請先安裝或更新 Codex CLI。");
    return 3;
  }
  if (added.status !== 0) {
    writeError(`SETUP_CODEX_ADD_FAILED：Codex MCP 註冊失敗（exit ${added.status ?? "unknown"}）。`);
    return 4;
  }
  write("已將 localdocsearch 註冊到 Codex。請重新開啟工作階段，並用 /mcp 核對連線狀態。");
  return 0;
}

function versionAtLeast(actual: string, minimum: readonly [number, number, number]): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)/u.exec(actual);
  if (!match) return false;
  const current = [Number(match[1]), Number(match[2]), Number(match[3])] as const;
  for (let index = 0; index < minimum.length; index++) {
    if (current[index]! > minimum[index]!) return true;
    if (current[index]! < minimum[index]!) return false;
  }
  return true;
}

export interface DoctorOptions {
  databasePath: string;
  cliPath: string;
  nodeVersion?: string;
  exists?: (target: string) => boolean;
  write?: (text: string) => void;
}

export function runDoctor(options: DoctorOptions): number {
  const write = options.write ?? console.log;
  const exists = options.exists ?? existsSync;
  let failures = 0;
  const report = (ok: boolean, label: string, detail: string) => {
    write(`${ok ? "[通過]" : "[失敗]"} ${label}：${detail}`);
    if (!ok) failures++;
  };
  const nodeVersion = options.nodeVersion ?? process.versions.node;
  report(versionAtLeast(nodeVersion, [22, 17, 0]), "Node.js", `目前 ${nodeVersion}；最低 22.17.0`);
  report(exists(options.cliPath), "CLI build", path.resolve(options.cliPath));
  if (!exists(options.databasePath)) {
    report(false, "本機索引", "尚未建立；請先執行 docsearch index <root>");
  } else {
    let store: IndexStore | undefined;
    try {
      store = new IndexStore(options.databasePath, { readOnly: true });
      const status = store.formatStatus();
      const roots = store.roots();
      report(!status.needsUpgrade, "唯讀索引", status.needsUpgrade
        ? `格式需要升級（block 索引 ${status.blockIndexCompletedDocuments}/${status.totalDocuments}）；請執行 index`
        : `${roots.length} 個根目錄，可唯讀開啟`);
    } catch {
      report(false, "唯讀索引", "無法以唯讀模式開啟；請執行 docsearch status 查看診斷");
    } finally {
      store?.close();
    }
  }
  try {
    createMcpServer(options.databasePath);
    const validApp = MCP_APP_RESOURCE_URI.startsWith("ui://")
      && MCP_APP_MIME_TYPE === "text/html;profile=mcp-app"
      && MCP_APP_HTML.includes("ui/update-model-context")
        && MCP_TOOL_NAMES.length === 5;
    report(validApp, "MCP／App", `${MCP_TOOL_NAMES.length} 個工具與 1 個本機 UI resource 可註冊`);
  } catch {
    report(false, "MCP／App", "server 或 UI resource 註冊失敗");
  }
  write(failures ? `診斷完成：${failures} 項必要條件未通過。` : "診斷完成：本機必要條件全部通過。");
  return failures ? 3 : 0;
}
