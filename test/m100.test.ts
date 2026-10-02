import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { IndexStore } from "../src/store.js";
import { sync } from "../src/sync.js";

interface McpResponse {
  id?: number;
  error?: unknown;
  result?: {
    structuredContent?: Record<string, unknown>;
    content?: Array<{ type?: string; text?: string }>;
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

test("M100 stdio explain_path needs no Workbench token and only returns the queried root result", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "lds-m100-mcp-trust-"));
  const data = path.join(temp, "data");
  const rootA = path.join(temp, "first-root");
  const rootB = path.join(temp, "second-root");
  const queried = path.join(rootA, "private", "secret.txt");
  const other = path.join(rootB, "other.txt");
  const databasePath = path.join(data, "LocalDocSearch", "index.db");
  await mkdir(rootA, { recursive: true });
  await mkdir(rootB, { recursive: true });
  await mkdir(path.dirname(queried), { recursive: true });
  await writeFile(path.join(rootA, ".localdocsearchignore"), "private/\n");
  await writeFile(queried, "m100-private-body");
  await writeFile(other, "m100-other-body");
  const store = new IndexStore(databasePath);
  try {
    await sync(rootA, store);
    await sync(rootB, store);
  } finally {
    store.close();
  }

  try {
    const messages = [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "m100", version: "1" } } },
      { jsonrpc: "2.0", method: "notifications/initialized", params: {} },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "explain_path", arguments: { path: queried } } },
    ];
    const child = spawnSync(process.execPath, [path.resolve("dist/src/cli.js"), "mcp"], {
      encoding: "utf8",
      env: { ...process.env, LOCALDOCSEARCH_DATA_DIR: data },
      input: `${messages.map(message => JSON.stringify(message)).join("\n")}\n`,
      timeout: 10_000,
    });
    assert.equal(child.status, 0, child.stderr);
    const responses = child.stdout.trim().split(/\r?\n/u).filter(Boolean).map(line => JSON.parse(line) as McpResponse);
    const response = responses.find(item => item.id === 2);
    assert.ok(response);
    assert.equal(response.error, undefined);
    const structured = response.result?.structuredContent
      ?? JSON.parse(response.result?.content?.find(item => item.type === "text")?.text ?? "{}");
    assert.equal(structured.state, "excluded");
    assert.equal(structured.root, path.resolve(rootA));
    assert.equal(structured.path, path.resolve(queried));
    assert.equal("roots" in structured, false);
    const serialized = JSON.stringify(response);
    assert.doesNotMatch(serialized, new RegExp(escapeRegExp(path.resolve(rootB)), "u"));
    assert.doesNotMatch(serialized, /m100-private-body|m100-other-body/u);
    assert.doesNotMatch(serialized, /X-LocalDocSearch-Token/u);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
