import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { search } from "../src/search.js";
import {
  autoupdateStartupDisable,
  autoupdateStartupEnable,
  autoupdateStartupStatus,
  startupShortcutPaths,
} from "../src/autoupdate-startup.js";
import { IndexStore } from "../src/store.js";

async function startupFixture() {
  const temp = await mkdtemp(path.join(os.tmpdir(), "lds-m37-startup-"));
  const appData = path.join(temp, "Roaming 資料 (1) & $x");
  const dataDir = path.join(temp, "index data");
  const databasePath = path.join(dataDir, "LocalDocSearch", "index.db");
  const env = { APPDATA: appData, SystemRoot: "C:\\Windows" };
  const calls: Array<{ executable: string; args: readonly string[]; env: NodeJS.ProcessEnv }> = [];
  const runPowerShell = async (executable: string, args: readonly string[], commandEnv: NodeJS.ProcessEnv) => {
    calls.push({ executable, args, env: commandEnv });
    await mkdir(path.dirname(commandEnv.SEEKAH_STARTUP_SHORTCUT!), { recursive: true });
    await writeFile(commandEnv.SEEKAH_STARTUP_SHORTCUT!, "fake Windows shortcut");
  };
  return { temp, env, databasePath, calls, runPowerShell };
}

test("0.37.0 startup enable is owned, idempotent, path-safe, and disable is repeatable", async t => {
  const h = await startupFixture();
  t.after(() => rm(h.temp, { recursive: true, force: true }));
  const options = {
    platform: "win32" as const,
    env: h.env,
    homedir: h.temp,
    databasePath: h.databasePath,
    nodePath: "C:\\Program Files\\nodejs\\node.exe",
    cliPath: "C:\\Seekah (正式)\\dist\\src\\cli.js",
    runPowerShell: h.runPowerShell,
  };
  const first = await autoupdateStartupEnable(options);
  assert.match(first.text, /已啟用/u);
  assert.equal(h.calls.length, 1);
  const script = Buffer.from(h.calls[0]!.args.at(-1)!, "base64").toString("utf16le");
  assert.doesNotMatch(script, /Program Files|正式|index data/u);
  assert.equal(h.calls[0]!.env.SEEKAH_STARTUP_ARGUMENTS?.includes("--data-dir"), true);
  assert.equal(autoupdateStartupStatus(options).code, 0);
  assert.match(autoupdateStartupStatus(options).text, /已啟用/u);
  const second = await autoupdateStartupEnable(options);
  assert.match(second.text, /已更新/u);
  assert.equal(h.calls.length, 2);
  assert.equal(autoupdateStartupDisable(options).code, 0);
  assert.equal(autoupdateStartupDisable(options).code, 0);
  assert.match(autoupdateStartupStatus(options).text, /未啟用/u);
});

test("0.37.0 startup refuses an unowned same-name entry and reports non-Windows status", async t => {
  const h = await startupFixture();
  t.after(() => rm(h.temp, { recursive: true, force: true }));
  const options = { platform: "win32" as const, env: h.env, homedir: h.temp, databasePath: h.databasePath, runPowerShell: h.runPowerShell };
  const paths = startupShortcutPaths(options);
  await mkdir(paths.directory, { recursive: true });
  await writeFile(paths.shortcutPath, "foreign");
  await assert.rejects(() => autoupdateStartupEnable(options), error => {
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
    assert.equal(code, "AUTOUPDATE_STARTUP_CONFLICT");
    return true;
  });
  const unsupported = autoupdateStartupStatus({ platform: "linux", env: h.env, homedir: h.temp, databasePath: h.databasePath });
  assert.equal(unsupported.code, 0);
  assert.match(unsupported.text, /不支援/u);
});

test("0.37.0 all-terms Bloom pruning preserves filename hits and mixed long-short cross-payload hits", async t => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "lds-m37-all-terms-"));
  const store = new IndexStore(path.join(temp, "index.db"));
  t.after(() => { store.close(); return rm(temp, { recursive: true, force: true }); });
  store.upsert({
    path: path.join(temp, "複製回本機 安裝.txt"), filename: "複製回本機 安裝.txt", extension: ".txt", sizeBytes: 1,
    modifiedAtMs: 1, status: "indexed", errorCode: null, errorMessage: null,
    blocks: [{ ordinal: 0, heading: null, content: "無關內容", locationKind: "line", locationValue: "1" }],
  });
  store.upsert({
    path: path.join(temp, "mixed.txt"), filename: "mixed.txt", extension: ".txt", sizeBytes: 1,
    modifiedAtMs: 2, status: "indexed", errorCode: null, errorMessage: null,
    blocks: [
      { ordinal: 0, heading: null, content: "複製回本機", locationKind: "line", locationValue: "1" },
      { ordinal: 1, heading: null, content: "安裝", locationKind: "line", locationValue: "2" },
    ],
  });
  const hits = search(store, "複製回本機 安裝", 20, undefined, undefined, "all-terms");
  assert.deepEqual(hits.map(hit => path.basename(hit.path)), ["複製回本機 安裝.txt", "mixed.txt"]);
  const missing = search(store, "複製回本機 安裝 不存在", 20, undefined, undefined, "all-terms");
  assert.equal(missing.length, 0);
});
