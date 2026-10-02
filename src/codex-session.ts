import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { documentReference } from "./document-reference.js";
import type { IndexStore, StoredDocumentRow } from "./store.js";

export const CODEX_REFERENCE_SOURCES = ["seekah-prompt", "user-provided", "seekah-mcp", "codex-tool"] as const;
export type CodexReferenceSource = (typeof CODEX_REFERENCE_SOURCES)[number];
export type CodexReferenceConfidence = "high" | "medium" | "low";
export type CodexSessionParseMode = "structured" | "message-path-fallback";

export interface CodexSessionReference {
  path: string;
  source: CodexReferenceSource;
  sources: CodexReferenceSource[];
  confidence: CodexReferenceConfidence;
  occurrences: number;
  eventTypes: string[];
  indexed: boolean;
  indexedPath?: string;
  seekahReference?: string;
  indexedStatus?: string;
}

export interface CodexSession {
  id: string;
  cwd: string | null;
  startedAt: string | null;
  lastEventAt: string | null;
  eventCount: number;
  invalidLineCount: number;
  eventTypes: Record<string, number>;
  parseMode: CodexSessionParseMode;
  references: CodexSessionReference[];
}

export interface CodexSessionParserOptions {
  codexHome?: string;
  environment?: NodeJS.ProcessEnv;
  maxSessions?: number;
  maxReferencesPerSession?: number;
}

export interface CodexSessionSummary extends Omit<CodexSession, "references"> {
  referenceCount: number;
  sourceCounts: Record<CodexReferenceSource, number>;
}

const DEFAULT_MAX_SESSIONS = 200;
const DEFAULT_MAX_REFERENCES = 2_000;
const MAX_ROLLOUT_LINE_LENGTH = 2_000_000;
const SOURCE_PRIORITY = new Map<CodexReferenceSource, number>(CODEX_REFERENCE_SOURCES.map((source, index) => [source, index]));
const HIGH_CONFIDENCE_KEYS = new Set(["path", "file", "file_path", "filepath", "filename", "uri", "attachment", "attachments"]);
const TEXT_KEYS = new Set(["text", "input_text", "content", "message", "prompt", "command", "arguments", "output", "result", "path", "file", "file_path", "filepath", "filename", "uri", "attachment", "attachments"]);
const METADATA_KEYS = new Set(["cwd", "session_id", "sessionId", "call_id", "callId", "id", "timestamp", "created_at", "createdAt", "updated_at", "updatedAt"]);
const TOOL_EVENT_PATTERN = /(?:function_call|tool_call|tool_use|tool_result|tool_output|shell_command|read_file|command_execution|exec_command)/iu;
const USER_EVENT_PATTERN = /(?:user_message|input_message)/iu;
const MCP_NAME_PATTERN = /(?:mcp[\s:_-]*(?:seekah|localdocsearch)|(?:seekah|localdocsearch)[\s:_-]*mcp)/iu;
const ABSOLUTE_PATH_TOKEN = /(?:file:\/\/[^\s"'`<>|]+|[A-Za-z]:[\\/][^\s"'`<>|]+|\\\\[^\s"'`<>|]+|\/(?:[^\s"'`<>|]+\/)*[^\s"'`<>|/]+)/gu;

interface JsonRecord { [key: string]: unknown }
interface MutableReference {
  path: string;
  source: CodexReferenceSource;
  sources: Set<CodexReferenceSource>;
  confidence: CodexReferenceConfidence;
  occurrences: number;
  eventTypes: Set<string>;
  indexed: boolean;
  indexedPath?: string;
  seekahReference?: string;
  indexedStatus?: string;
}
interface MutableSession {
  id: string;
  cwd: string | null;
  startedAt: string | null;
  lastEventAt: string | null;
  eventCount: number;
  invalidLineCount: number;
  eventTypes: Record<string, number>;
  parseMode: CodexSessionParseMode;
  references: Map<string, MutableReference>;
}

function record(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    const result = stringValue(value);
    if (result) return result;
  }
  return null;
}

function nestedRecord(value: unknown): JsonRecord | null {
  const item = record(value);
  if (!item) return null;
  return record(item.payload) ?? record(item.data) ?? record(item.event) ?? item;
}

function isWindowsAbsolute(value: string): boolean {
  return /^[A-Za-z]:[\\/]/u.test(value) || /^\\\\/u.test(value);
}

function normalizeAbsolutePath(value: string): string | null {
  let candidate = value.trim();
  if (/^file:\/\//iu.test(candidate)) {
    try {
      const url = new URL(candidate);
      candidate = decodeURIComponent(url.pathname);
      if (/^\/[A-Za-z]:[\\/]/u.test(candidate)) candidate = candidate.slice(1);
      if (url.hostname && url.hostname !== "localhost") candidate = `\\\\${url.hostname}${candidate.replaceAll("/", "\\")}`;
    } catch {
      return null;
    }
  }
  candidate = candidate
    .replace(/^['"`]+/u, "")
    .replace(/[,'"`.;:!?)}\]]+$/u, "")
    .trim();
  if (!candidate || candidate.includes("\n") || candidate.includes("\r")) return null;
  if (isWindowsAbsolute(candidate)) return path.win32.normalize(candidate);
  if (candidate.startsWith("/")) return path.posix.normalize(candidate);
  return null;
}

function pathKey(value: string): string {
  const normalized = normalizeAbsolutePath(value) ?? value;
  return isWindowsAbsolute(normalized) ? normalized.toLowerCase() : normalized;
}

function extractAbsolutePaths(text: string): string[] {
  const paths: string[] = [];
  for (const match of text.matchAll(ABSOLUTE_PATH_TOKEN)) {
    const candidate = match[0];
    const index = match.index ?? 0;
    if (candidate.startsWith("/") && (
      text[index - 1] === ":" || text[index - 1] === "/"
      || /(?:https?|ftp):\/\/[^/\s"'`<>|]+$/iu.test(text.slice(0, index))
    )) continue;
    const normalized = normalizeAbsolutePath(candidate);
    if (normalized && !paths.includes(normalized)) paths.push(normalized);
  }
  return paths;
}

function walkStrings(value: unknown, key: string | undefined, output: string[], depth = 0): void {
  if (depth > 8) return;
  if (typeof value === "string") {
    if (!key || TEXT_KEYS.has(key) || key.includes("text") || key.includes("message")) output.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) walkStrings(item, key, output, depth + 1);
    return;
  }
  const item = record(value);
  if (!item) return;
  for (const [childKey, child] of Object.entries(item)) {
    if (METADATA_KEYS.has(childKey)) continue;
    walkStrings(child, childKey, output, depth + 1);
  }
}

function collectExplicitStrings(value: unknown, keys: ReadonlySet<string>, output: string[], depth = 0): void {
  if (depth > 6) return;
  if (typeof value === "string") return;
  if (Array.isArray(value)) {
    for (const item of value) collectExplicitStrings(item, keys, output, depth + 1);
    return;
  }
  const item = record(value);
  if (!item) return;
  for (const [key, child] of Object.entries(item)) {
    if (keys.has(key) && typeof child === "string") output.push(child);
    collectExplicitStrings(child, keys, output, depth + 1);
  }
}

function eventPayload(line: JsonRecord): JsonRecord {
  return nestedRecord(line) ?? line;
}

function canonicalEventType(line: JsonRecord): string {
  const type = stringValue(line.type) ?? "unknown";
  const payload = nestedRecord(line.payload) ?? nestedRecord(line.data) ?? nestedRecord(line.event);
  const subtype = payload ? firstString(payload.type, payload.event_type, payload.kind) : null;
  return subtype && (type === "response_item" || type === "event_msg" || type === "response") ? `${type}/${subtype}` : type;
}

function eventTimestamp(line: JsonRecord, payload: JsonRecord): string | null {
  return firstString(line.timestamp, line.created_at, line.createdAt, payload.timestamp, payload.created_at, payload.createdAt);
}

function sessionMeta(line: JsonRecord, payload: JsonRecord): { id?: string; cwd?: string; startedAt?: string } {
  const source = payload.type === "session_meta" || line.type === "session_meta" ? payload : {};
  const cwd = firstString(source.cwd, source.working_directory, source.workingDirectory);
  const normalizedCwd = cwd ? normalizeAbsolutePath(cwd) : null;
  const id = firstString(source.session_id, source.sessionId);
  const startedAt = firstString(source.timestamp, source.created_at, source.createdAt);
  return {
    ...(id ? { id } : {}),
    ...(normalizedCwd ? { cwd: normalizedCwd } : {}),
    ...(startedAt ? { startedAt } : {}),
  };
}

function roleOf(line: JsonRecord, payload: JsonRecord): string | null {
  return firstString(line.role, payload.role, record(payload.message)?.role);
}

function namedStrings(line: JsonRecord, payload: JsonRecord): string[] {
  const values: string[] = [];
  collectExplicitStrings(line, new Set(["source", "origin", "producer", "server", "server_name", "serverName", "tool", "tool_name", "toolName", "name", "mcp", "integration"]), values);
  collectExplicitStrings(payload, new Set(["source", "origin", "producer", "server", "server_name", "serverName", "tool", "tool_name", "toolName", "name", "mcp", "integration"]), values);
  return values;
}

function isSeekahMcp(line: JsonRecord, payload: JsonRecord, names: readonly string[]): boolean {
  const source = names.join(" ");
  if (MCP_NAME_PATTERN.test(source) || /seekah|localdocsearch/iu.test(source)) return true;
  const eventMarkers = [stringValue(line.type), stringValue(payload.type)].filter(Boolean).join(" ");
  return names.some(value => /^(?:search_documents|prepare_context|index_status|explain_path|open_search_app)$/iu.test(value))
    && /mcp|seekah|localdocsearch/iu.test(`${source} ${eventMarkers}`);
}

function explicitPrompt(line: JsonRecord, payload: JsonRecord, names: readonly string[]): boolean {
  if (names.some(value => /seekah[\s:_-]*(?:prompt|context)|(?:prompt|context)[\s:_-]*seekah/iu.test(value))) return true;
  const source = firstString(line.source, line.origin, payload.source, payload.origin);
  return Boolean(source && /seekah[\s:_-]*prompt/iu.test(source));
}

function textValuesForPathOnly(line: JsonRecord, payload: JsonRecord): string[] {
  const values: string[] = [];
  walkStrings(line.message, "message", values);
  walkStrings(payload.message, "message", values);
  walkStrings(payload.content, "content", values);
  walkStrings(payload.input, "input", values);
  return values;
}

function isPathOnlyPrompt(values: readonly string[]): boolean {
  const lines = values.flatMap(value => value.split(/\r?\n/u).map(item => item.trim()).filter(Boolean));
  return lines.length >= 2 && lines.every(item => Boolean(normalizeAbsolutePath(item.replace(/^['"]|['"]$/gu, ""))));
}

function isStructuredPathKey(key: string | undefined): boolean {
  return Boolean(key && HIGH_CONFIDENCE_KEYS.has(key));
}

function collectPaths(value: unknown, output: Array<{ path: string; structured: boolean }>, key: string | undefined, depth = 0): void {
  if (depth > 8) return;
  if (typeof value === "string") {
    for (const item of extractAbsolutePaths(value)) output.push({ path: item, structured: isStructuredPathKey(key) });
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectPaths(item, output, key, depth + 1);
    return;
  }
  const item = record(value);
  if (!item) return;
  for (const [childKey, child] of Object.entries(item)) {
    if (METADATA_KEYS.has(childKey)) continue;
    collectPaths(child, output, childKey, depth + 1);
  }
}

function isUserEvent(type: string, line: JsonRecord, payload: JsonRecord): boolean {
  const role = roleOf(line, payload)?.toLowerCase();
  return role === "user" || USER_EVENT_PATTERN.test(type);
}

function sourceForEvent(line: JsonRecord, payload: JsonRecord, type: string, names: readonly string[], textValues: readonly string[]): { source: CodexReferenceSource; confidence: CodexReferenceConfidence; fallback: boolean } {
  if (explicitPrompt(line, payload, names)) return { source: "seekah-prompt", confidence: "high", fallback: false };
  if (isSeekahMcp(line, payload, names)) return { source: "seekah-mcp", confidence: "high", fallback: false };
  if (TOOL_EVENT_PATTERN.test(type)) return { source: "codex-tool", confidence: "high", fallback: false };
  if (isUserEvent(type, line, payload)) {
    return isPathOnlyPrompt(textValues)
      ? { source: "seekah-prompt", confidence: "medium", fallback: false }
      : { source: "user-provided", confidence: "medium", fallback: false };
  }
  return { source: "user-provided", confidence: "low", fallback: true };
}

function confidenceRank(value: CodexReferenceConfidence): number {
  return value === "high" ? 3 : value === "medium" ? 2 : 1;
}

function addReference(session: MutableSession, item: { path: string; source: CodexReferenceSource; confidence: CodexReferenceConfidence; eventType: string }, maxReferences: number): void {
  const key = pathKey(item.path);
  const existing = session.references.get(key);
  if (!existing) {
    if (session.references.size >= maxReferences) return;
    session.references.set(key, {
      path: item.path,
      source: item.source,
      sources: new Set([item.source]),
      confidence: item.confidence,
      occurrences: 1,
      eventTypes: new Set([item.eventType]),
      indexed: false,
    });
    return;
  }
  existing.sources.add(item.source);
  existing.occurrences++;
  existing.eventTypes.add(item.eventType);
  if (confidenceRank(item.confidence) > confidenceRank(existing.confidence)) {
    existing.confidence = item.confidence;
    existing.source = item.source;
  } else if (confidenceRank(item.confidence) === confidenceRank(existing.confidence)
    && (SOURCE_PRIORITY.get(item.source) ?? 99) < (SOURCE_PRIORITY.get(existing.source) ?? 99)) {
    existing.source = item.source;
  }
}

function createMutableSession(id: string): MutableSession {
  return { id, cwd: null, startedAt: null, lastEventAt: null, eventCount: 0, invalidLineCount: 0,
    eventTypes: {}, parseMode: "structured", references: new Map() };
}

function finalizeReference(reference: MutableReference): CodexSessionReference {
  const sources = [...reference.sources].sort((left, right) => (SOURCE_PRIORITY.get(left) ?? 99) - (SOURCE_PRIORITY.get(right) ?? 99));
  return {
    path: reference.path,
    source: reference.source,
    sources,
    confidence: reference.confidence,
    occurrences: reference.occurrences,
    eventTypes: [...reference.eventTypes].sort(),
    indexed: reference.indexed,
    ...(reference.indexedPath ? { indexedPath: reference.indexedPath } : {}),
    ...(reference.seekahReference ? { seekahReference: reference.seekahReference } : {}),
    ...(reference.indexedStatus ? { indexedStatus: reference.indexedStatus } : {}),
  };
}

function finalizeSession(session: MutableSession): CodexSession {
  return {
    id: session.id,
    cwd: session.cwd,
    startedAt: session.startedAt,
    lastEventAt: session.lastEventAt,
    eventCount: session.eventCount,
    invalidLineCount: session.invalidLineCount,
    eventTypes: Object.fromEntries(Object.entries(session.eventTypes).sort(([left], [right]) => left.localeCompare(right))),
    parseMode: session.parseMode,
    references: [...session.references.values()].map(finalizeReference),
  };
}

function consumeLine(session: MutableSession, line: string, maxReferences: number): void {
  if (!line.trim()) return;
  if (line.length > MAX_ROLLOUT_LINE_LENGTH) {
    session.invalidLineCount++;
    return;
  }
  let parsed: unknown;
  try { parsed = JSON.parse(line); }
  catch { session.invalidLineCount++; return; }
  const lineRecord = record(parsed);
  if (!lineRecord) { session.invalidLineCount++; return; }
  const payload = eventPayload(lineRecord);
  const type = canonicalEventType(lineRecord);
  session.eventCount++;
  session.eventTypes[type] = (session.eventTypes[type] ?? 0) + 1;
  const timestamp = eventTimestamp(lineRecord, payload);
  if (timestamp) {
    if (!session.startedAt) session.startedAt = timestamp;
    session.lastEventAt = timestamp;
  }
  const meta = sessionMeta(lineRecord, payload);
  if (meta.id && (type === "session_meta" || payload.type === "session_meta")) session.id = meta.id;
  if (meta.cwd && (type === "session_meta" || payload.type === "session_meta")) session.cwd = meta.cwd;
  if (meta.startedAt && !session.startedAt) session.startedAt = meta.startedAt;
  if (type === "session_meta" || payload.type === "session_meta") return;

  const names = namedStrings(lineRecord, payload);
  const pathValues: Array<{ path: string; structured: boolean }> = [];
  collectPaths(lineRecord, pathValues, undefined);
  const textValues = textValuesForPathOnly(lineRecord, payload);
  const classification = sourceForEvent(lineRecord, payload, type, names, textValues);
  for (const item of pathValues) {
    const confidence = classification.fallback ? "low" : item.structured ? "high" : classification.confidence;
    addReference(session, { path: item.path, source: classification.source, confidence, eventType: type }, maxReferences);
    if (classification.fallback) session.parseMode = "message-path-fallback";
  }
}

async function rolloutFiles(codexHome: string): Promise<string[]> {
  const root = path.join(codexHome, "sessions");
  const result: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch { return; }
    for (const entry of entries) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(full);
      else if (entry.isFile() && /^rollout-[^/\\]+\.jsonl$/u.test(entry.name)) result.push(full);
    }
  };
  await visit(root);
  return result.sort((left, right) => right.localeCompare(left));
}

export function resolveCodexHome(explicit?: string, environment: NodeJS.ProcessEnv = process.env): string {
  const value = explicit?.trim() || environment.SEEKAH_CODEX_HOME?.trim() || environment.CODEX_HOME?.trim();
  return path.resolve(value || path.join(os.homedir(), ".codex"));
}

function fallbackSessionId(filePath: string): string {
  return `rollout-${createHash("sha256").update(path.normalize(filePath), "utf8").digest("hex").slice(0, 16)}`;
}

export async function parseCodexRolloutFile(filePath: string, options: Pick<CodexSessionParserOptions, "maxReferencesPerSession"> = {}): Promise<CodexSession> {
  const session = createMutableSession(fallbackSessionId(filePath));
  const input = createReadStream(filePath, { encoding: "utf8" });
  const lines = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) consumeLine(session, line, options.maxReferencesPerSession ?? DEFAULT_MAX_REFERENCES);
  } finally {
    input.destroy();
  }
  return finalizeSession(session);
}

export async function parseCodexSessions(options: CodexSessionParserOptions = {}): Promise<CodexSession[]> {
  const home = resolveCodexHome(options.codexHome, options.environment);
  const files = await rolloutFiles(home);
  const sessions: CodexSession[] = [];
  for (const file of files.slice(0, options.maxSessions ?? DEFAULT_MAX_SESSIONS)) {
    try { sessions.push(await parseCodexRolloutFile(file, options)); }
    catch { /* A deleted or unreadable rollout is not a reason to expose raw filesystem errors. */ }
  }
  return sessions.sort((left, right) => (right.startedAt ?? "").localeCompare(left.startedAt ?? "") || right.id.localeCompare(left.id));
}

function referenceSummary(session: CodexSession): CodexSessionSummary {
  const sourceCounts = Object.fromEntries(CODEX_REFERENCE_SOURCES.map(source => [source, 0])) as Record<CodexReferenceSource, number>;
  for (const reference of session.references) for (const source of reference.sources) sourceCounts[source]++;
  const { references: _references, ...summary } = session;
  return { ...summary, referenceCount: session.references.length, sourceCounts };
}

export function summarizeCodexSessions(sessions: readonly CodexSession[]): CodexSessionSummary[] {
  return sessions.map(referenceSummary);
}

function indexedDocument(store: Pick<IndexStore, "getDocument" | "getDocumentCaseInsensitive">, filePath: string): StoredDocumentRow | undefined {
  const normalized = normalizeAbsolutePath(filePath) ?? filePath;
  return store.getDocument(normalized) ?? store.getDocumentCaseInsensitive(normalized);
}

export function markIndexedCodexReferences(sessions: readonly CodexSession[], store: Pick<IndexStore, "getDocument" | "getDocumentCaseInsensitive">): CodexSession[] {
  return sessions.map(session => ({
    ...session,
    references: session.references.map(reference => {
      const document = indexedDocument(store, reference.path);
      if (!document) return { ...reference, indexed: false };
      return {
        ...reference,
        indexed: true,
        indexedPath: document.path,
        seekahReference: documentReference(document.id, document.path),
        indexedStatus: document.status,
      };
    }),
  }));
}

export function codexSessionById(sessions: readonly CodexSession[], id: string): CodexSession | undefined {
  return sessions.find(session => session.id === id);
}

export function codexReferencePathForTest(value: string): string | null {
  return normalizeAbsolutePath(value);
}