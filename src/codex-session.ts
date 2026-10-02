import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { documentReference } from "./document-reference.js";
import type { IndexStore, StoredDocumentRow } from "./store.js";

export const CODEX_REFERENCE_SOURCES = ["seekah-prompt", "user-provided", "seekah-mcp", "codex-tool"] as const;
export type CodexReferenceSource = (typeof CODEX_REFERENCE_SOURCES)[number];
export type CodexReferenceConfidence = "high" | "medium" | "low";
export type CodexReferenceDisplay = "normal" | "low-confidence-missing";
export type CodexSessionParseMode = "structured" | "message-path-fallback";

export interface CodexSessionReference {
  path: string;
  source: CodexReferenceSource;
  sources: CodexReferenceSource[];
  confidence: CodexReferenceConfidence;
  display: CodexReferenceDisplay;
  exists: boolean;
  occurrences: number;
  eventTypes: string[];
  indexed: boolean;
  indexedPath?: string;
  seekahReference?: string;
  indexedStatus?: string;
}

export type CodexSessionParseStatus = "parsed" | "skipped";

export interface CodexSession {
  id: string;
  cwd: string | null;
  startedAt: string | null;
  lastEventAt: string | null;
  eventCount: number;
  invalidLineCount: number;
  eventTypes: Record<string, number>;
  parseMode: CodexSessionParseMode;
  parseStatus: CodexSessionParseStatus;
  skipReason?: "file-too-large";
  references: CodexSessionReference[];
}

export interface CodexSessionParserOptions {
  codexHome?: string;
  environment?: NodeJS.ProcessEnv;
  maxSessions?: number;
  maxReferencesPerSession?: number;
  maxFileBytes?: number;
  maxLineLength?: number;
  cache?: CodexSessionCache;
}

export interface CodexSessionCacheEntry {
  mtimeMs: number;
  size: number;
  session: CodexSession;
}

export type CodexSessionCache = Map<string, CodexSessionCacheEntry>;

export interface CodexSessionFile {
  path: string;
  mtimeMs: number;
  size: number;
  session: CodexSession;
}

export interface CodexSessionSummary extends Omit<CodexSession, "references"> {
  referenceCount: number;
  visibleReferenceCount: number;
  lowReferenceCount: number;
  sourceCounts: Record<CodexReferenceSource, number>;
}

const DEFAULT_MAX_SESSIONS = 200;
const DEFAULT_MAX_REFERENCES = 2_000;
const DEFAULT_MAX_FILE_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_LINE_LENGTH = 2_000_000;
const MAX_REFERENCE_TEXT_LENGTH = 400;
const MAX_EVENT_TYPE_LENGTH = 128;
const SOURCE_PRIORITY = new Map<CodexReferenceSource, number>(CODEX_REFERENCE_SOURCES.map((source, index) => [source, index]));
const PATH_FIELD_KEYS = new Set(["path", "savedPath", "saved_path", "filePath", "file_path"]);
const TOOL_NAME_KEYS = new Set(["name", "tool_name", "toolName"]);
const AUTO_INJECTED_USER_PREFIXES = [
  /^<environment_context>(?:\s|$)/u,
  /^<turn_aborted>(?:\s|$)/u,
  /^<recommended_plugins>(?:\s|$)/u,
  /^# AGENTS\.md(?:\s|$)/u,
];
const SEEKAH_CONTEXT_MARKER = "# Seekah 上下文";
const MCP_SERVER_NAMES = new Set(["localdocsearch", "seekah"]);
const PATH_BOUNDARY = /[\u0022\u0027\u0060\u003c\u003e\u007c\u0028\u0029\u005b\u005d\u007b\u007d\u3001\u3002\u3009\u300a\u300b\u300d\u3010\u3011\u3014\u3015\u3017\u3019\u301b\u2026\uff0c\uff1a\uff1b\uff01\uff1f]/u;
const ALLOWED_EVENT_TYPES = new Set([
  "unknown", "session_meta", "turn_context", "world_state", "compacted",
  "response", "response_item", "response/message", "response_item/message",
  "response_item/function_call", "response_item/custom_tool_call",
  "response_item/custom_tool_call_output", "response_item/function_call_output",
  "event_msg", "event_msg/thread_settings_applied", "event_msg/item_completed",
  "event_msg/user_message", "event_msg/agent_message", "event_msg/reasoning",
  "event_msg/plan", "event_msg/web_search", "event_msg/context_compaction",
]);
const ABSOLUTE_PATH_TOKEN = /(?:file:\/\/[^\s"'`<>|]+|[A-Za-z]:[\\/][^\s"'`<>|]+|\\\\[^\s"'`<>|]+|\/(?:[^\s"'`<>|]+\/)*[^\s"'`<>|/]+)/gu;

interface JsonRecord { [key: string]: unknown }
interface PathEvidence {
  path: string;
  source: CodexReferenceSource;
  confidence: CodexReferenceConfidence;
}
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
  parseStatus: CodexSessionParseStatus;
  skipReason?: "file-too-large";
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

function eventPayload(line: JsonRecord): JsonRecord {
  return nestedRecord(line) ?? line;
}

function canonicalEventType(line: JsonRecord): string {
  const type = stringValue(line.type) ?? "unknown";
  const payload = nestedRecord(line.payload) ?? nestedRecord(line.data) ?? nestedRecord(line.event);
  const subtype = payload ? firstString(payload.type, payload.event_type, payload.kind) : null;
  const candidate = subtype && (type === "response_item" || type === "event_msg" || type === "response") ? `${type}/${subtype}` : type;
  return candidate.length <= MAX_EVENT_TYPE_LENGTH && ALLOWED_EVENT_TYPES.has(candidate) ? candidate : "unknown";
}

function eventTimestamp(line: JsonRecord, payload: JsonRecord): string | null {
  return firstString(line.timestamp, line.created_at, line.createdAt, payload.timestamp, payload.created_at, payload.createdAt);
}

function isWindowsAbsolute(value: string): boolean {
  return /^[A-Za-z]:[\\/]/u.test(value) || /^\\\\/u.test(value);
}

function trimPathToken(value: string): string {
  let candidate = value.trim();
  const boundary = candidate.search(PATH_BOUNDARY);
  if (boundary >= 0) candidate = candidate.slice(0, boundary);
  candidate = candidate.replace(/[,:;.!?]+$/u, "");
  candidate = candidate.replace(/:(?:\d+)$/u, "");
  return candidate.replace(/[,:;.!?]+$/u, "").trim();
}
function isLikelyBase64Fragment(value: string): boolean {
  const candidate = value.replace(/^\/+/u, "");
  return /^(?:9j\/|iVBORw0KGgo|R0lGOD|JVBER|UEsDB|H4sI|eyJ)/u.test(candidate);
}


function normalizeAbsolutePath(value: string): string | null {
  let candidate = trimPathToken(value);
  if (!candidate || candidate.length > MAX_REFERENCE_TEXT_LENGTH || candidate.includes("\n") || candidate.includes("\r")) return null;
  if (isLikelyBase64Fragment(candidate)) return null;
  if (/^(?:data|https?|ftp):/iu.test(candidate) || /^\/\/[^/]/u.test(candidate)) return null;
  if (/(?:;base64)(?:,|;|$)/iu.test(candidate)) return null;
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
  candidate = trimPathToken(candidate);
  if (!candidate || candidate.length > MAX_REFERENCE_TEXT_LENGTH || candidate.includes("\n") || candidate.includes("\r")) return null;
  if (isWindowsAbsolute(candidate)) return path.win32.normalize(candidate);
  if (candidate.startsWith("/")) return path.posix.normalize(candidate);
  return null;
}

function pathKey(value: string): string {
  const normalized = normalizeAbsolutePath(value) ?? value;
  return isWindowsAbsolute(normalized) ? normalized.toLowerCase() : normalized;
}

function extractAbsolutePaths(text: string): string[] {
  if (text.length > MAX_REFERENCE_TEXT_LENGTH || /[\r\n]/u.test(text)) return [];
  const paths: string[] = [];
  for (const match of text.matchAll(ABSOLUTE_PATH_TOKEN)) {
    const candidate = match[0];
    const index = match.index ?? 0;
    const prefix = text.slice(0, index);
    const lowerPrefix = prefix.toLowerCase();
    const networkStarts = [lowerPrefix.lastIndexOf("http://"), lowerPrefix.lastIndexOf("https://"), lowerPrefix.lastIndexOf("ftp://")];
    const networkStart = Math.max(...networkStarts);
    const dataStart = lowerPrefix.lastIndexOf("data:");
    const base64Start = lowerPrefix.lastIndexOf(";base64");
    const splitNetworkUrl = (lowerPrefix.endsWith("htt") && /^p:[\\/]/iu.test(candidate))
      || (lowerPrefix.endsWith("http") && /^s:[\\/]/iu.test(candidate))
      || (lowerPrefix.endsWith("ft") && /^p:[\\/]/iu.test(candidate));
    const insideNetworkUrl = (networkStart >= 0 && !/\s/u.test(text.slice(networkStart, index))) || splitNetworkUrl;
    const insideDataUri = dataStart >= 0 && !/\s/u.test(text.slice(dataStart, index));
    const insideBase64 = base64Start >= 0 && !/\s/u.test(text.slice(base64Start, index));
    if (insideNetworkUrl || insideDataUri || insideBase64 || isLikelyBase64Fragment(candidate) || candidate.startsWith("//")
      || (candidate.startsWith("/") && (text[index - 1] === ":" || text[index - 1] === "/"))) continue;
    const normalized = normalizeAbsolutePath(candidate);
    if (normalized && !paths.includes(normalized)) paths.push(normalized);
  }
  return paths;
}

function collectAbsolutePaths(value: unknown, output: string[], depth = 0): void {
  if (depth > 8) return;
  if (typeof value === "string") {
    output.push(...extractAbsolutePaths(value));
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectAbsolutePaths(item, output, depth + 1);
    return;
  }
  const item = record(value);
  if (!item) return;
  for (const child of Object.values(item)) collectAbsolutePaths(child, output, depth + 1);
}

function collectPathFields(value: unknown, output: string[], depth = 0): void {
  if (depth > 8) return;
  if (Array.isArray(value)) {
    for (const item of value) collectPathFields(item, output, depth + 1);
    return;
  }
  const item = record(value);
  if (!item) return;
  for (const [key, child] of Object.entries(item)) {
    if (PATH_FIELD_KEYS.has(key)) collectAbsolutePaths(child, output, depth + 1);
    else collectPathFields(child, output, depth + 1);
  }
}

function evidenceFromValue(value: unknown, source: CodexReferenceSource, confidence: CodexReferenceConfidence): PathEvidence[] {
  const paths: string[] = [];
  collectAbsolutePaths(value, paths);
  return paths.map(pathValue => ({ path: pathValue, source, confidence }));
}


function collectTextValues(value: unknown, output: string[], depth = 0): void {
  if (depth > 8) return;
  if (typeof value === "string") {
    output.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectTextValues(item, output, depth + 1);
    return;
  }
  const item = record(value);
  if (!item) return;
  for (const child of Object.values(item)) collectTextValues(child, output, depth + 1);
}

function applyPatchEvidence(value: unknown): PathEvidence[] {
  const texts: string[] = [];
  const paths: string[] = [];
  collectTextValues(value, texts);
  for (const text of texts) {
    for (const match of text.matchAll(/^\s*\*\*\*\s+(?:(?:Update|Add|Delete) File|(?:Move|Copy) to):\s*(.+?)\s*$/gmu)) {
      paths.push(...extractAbsolutePaths(match[1]!));
    }
  }
  collectPathFields(value, paths);
  return uniquePaths(paths).map(pathValue => ({ path: pathValue, source: "codex-tool", confidence: "high" }));
}

function uniquePaths(values: readonly string[]): string[] {
  return [...new Set(values.map(normalizeAbsolutePath).filter((value): value is string => Boolean(value)))];
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

function isAutoInjectedUserText(text: string): boolean {
  const trimmed = text.trimStart();
  return AUTO_INJECTED_USER_PREFIXES.some(prefix => prefix.test(trimmed));
}

function seekahPromptPaths(text: string): string[] {
  const trimmed = text.trim();
  if (trimmed.startsWith(SEEKAH_CONTEXT_MARKER)) {
    const paths: string[] = [];
    for (const line of trimmed.split(/\r?\n/u)) {
      const match = /^##\s+\d+\.\s+(.+?)\s*$/u.exec(line.trim());
      if (match?.[1]) {
        const normalized = normalizeAbsolutePath(match[1]);
        if (normalized) paths.push(normalized);
      }
    }
    return uniquePaths(paths);
  }
  const lines = trimmed.split(/\r?\n/u).map(item => item.trim()).filter(Boolean);
  if (!lines.length) return [];
  const paths = lines.map(normalizeAbsolutePath);
  return paths.every((value): value is string => Boolean(value)) ? uniquePaths(paths) : [];
}

function userMessageEvidence(payload: JsonRecord): PathEvidence[] {
  if (roleOf({}, payload)?.toLowerCase() !== "user") return [];
  if (!Array.isArray(payload.content)) return [];
  const evidence: PathEvidence[] = [];
  for (const rawItem of payload.content) {
    const item = record(rawItem);
    if (!item) continue;
    const contentType = stringValue(item.type)?.toLowerCase();
    const isPlainInputText = contentType === "input_text" || contentType === "input_text:plain" || contentType === "input_text:(plain)";
    if (isPlainInputText) {
      const text = stringValue(item.text);
      if (!text || isAutoInjectedUserText(text)) continue;
      const promptPaths = seekahPromptPaths(text);
      if (promptPaths.length) evidence.push(...promptPaths.map(pathValue => ({ path: pathValue, source: "seekah-prompt" as const, confidence: "high" as const })));
      else evidence.push(...evidenceFromValue(text, "user-provided", "medium"));
    } else if (contentType === "input_image" || contentType === "input_image:(plain)") {
      evidence.push(...evidenceFromValue(item, "user-provided", "medium"));
    }
  }
  return evidence;
}

function isAllowedMcpIdentity(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (MCP_SERVER_NAMES.has(normalized)) return true;
  if (/^mcp__(?:localdocsearch|seekah)(?:__|$)/u.test(normalized)) return true;
  return /(?:^|[@:#_\s-])(?:localdocsearch|seekah)(?:[#:_\s-]|$)/u.test(normalized);
}

function isAllowedMcpNamespace(line: JsonRecord, payload: JsonRecord): boolean {
  return [
    firstString(line.namespace, line.tool_namespace, line.toolNamespace),
    firstString(payload.namespace, payload.tool_namespace, payload.toolNamespace),
    firstString(line.name, payload.name),
  ].filter((value): value is string => Boolean(value)).some(value => /^mcp__(?:localdocsearch|seekah)(?:__|$)/iu.test(value));
}

function toolName(payload: JsonRecord): string | null {
  for (const key of TOOL_NAME_KEYS) {
    const value = stringValue(payload[key]);
    if (value) return value;
  }
  return null;
}

function functionCallEvidence(line: JsonRecord, payload: JsonRecord): PathEvidence[] {
  const name = toolName(payload) ?? stringValue(line.name);
  if (isAllowedMcpNamespace(line, payload)) return evidenceFromValue(payload.arguments, "seekah-mcp", "high");
  if (name?.toLowerCase() === "shell_command") return evidenceFromValue(payload.arguments, "codex-tool", "high");
  return [];
}

function customToolEvidence(payload: JsonRecord): PathEvidence[] {
  const name = toolName(payload)?.toLowerCase();
  if (name === "apply_patch") return applyPatchEvidence(payload.input);
  if (name === "exec") return evidenceFromValue(payload.input, "codex-tool", "high");
  return [];
}

function fileChangeEvidence(item: JsonRecord): PathEvidence[] {
  const paths: string[] = [];
  for (const key of PATH_FIELD_KEYS) {
    if (key in item) collectAbsolutePaths(item[key], paths);
  }
  collectPathFields(item.content, paths);
  const changes = record(item.changes);
  if (changes) {
    for (const key of Object.keys(changes)) {
      const normalized = normalizeAbsolutePath(key);
      if (normalized) paths.push(normalized);
    }
  }
  return uniquePaths(paths).map(pathValue => ({ path: pathValue, source: "codex-tool", confidence: "high" }));
}

function mcpIdentityValues(line: JsonRecord, payload: JsonRecord, item: JsonRecord): string[] {
  return [
    item.type, item.server, item.server_name, item.serverName, item.namespace,
    payload.server, payload.server_name, payload.serverName, payload.namespace,
    line.server, line.server_name, line.serverName, line.namespace,
  ].map(stringValue).filter((value): value is string => Boolean(value));
}

function isMcpToolCallType(value: string | null): boolean {
  return Boolean(value && /^(?:mcp_tool_call|mcptoolcall)(?:[@:#]|$)/iu.test(value));
}

function itemCompletedEvidence(line: JsonRecord, payload: JsonRecord): PathEvidence[] {
  const item = record(payload.item);
  if (!item) return [];
  const itemType = stringValue(item.type);
  if (itemType && /^(?:filechange|file_change)$/iu.test(itemType)) {
    return fileChangeEvidence(item);
  }
  if (itemType && /^(?:commandexecution|command_execution)$/iu.test(itemType)) {
    return evidenceFromValue([item.command, item.parsed_cmd], "codex-tool", "high");
  }
  if (isMcpToolCallType(itemType) && mcpIdentityValues(line, payload, item).some(isAllowedMcpIdentity)) {
    return evidenceFromValue([item.arguments, item.input], "seekah-mcp", "high");
  }
  return [];
}

function isStructuredEventType(type: string): boolean {
  return type === "session_meta" || type === "turn_context" || type === "world_state" || type === "compacted"
    || type === "response_item" || type.startsWith("response_item/")
    || type === "event_msg" || type.startsWith("event_msg/");
}

function structuredEvidence(type: string, line: JsonRecord, payload: JsonRecord): PathEvidence[] {
  if (type === "response_item/message") return userMessageEvidence(payload);
  if (type === "response_item/function_call") return functionCallEvidence(line, payload);
  if (type === "response_item/custom_tool_call") return customToolEvidence(payload);
  if (type === "event_msg/item_completed") return itemCompletedEvidence(line, payload);
  return [];
}

function fallbackMessageEvidence(line: JsonRecord, payload: JsonRecord): PathEvidence[] {
  return evidenceFromValue([line.message, line.text, payload.message, payload.text], "user-provided", "low");
}

function confidenceRank(value: CodexReferenceConfidence): number {
  return value === "high" ? 3 : value === "medium" ? 2 : 1;
}

function addReference(session: MutableSession, item: PathEvidence & { eventType: string }, maxReferences: number): void {
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
    eventTypes: {}, parseMode: "structured", parseStatus: "parsed", references: new Map() };
}

function finalizeReference(reference: MutableReference): CodexSessionReference {
  const sources = [...reference.sources].sort((left, right) => (SOURCE_PRIORITY.get(left) ?? 99) - (SOURCE_PRIORITY.get(right) ?? 99));
  const exists = existsSync(reference.path);
  const display: CodexReferenceDisplay = exists ? "normal" : "low-confidence-missing";
  return {
    path: reference.path,
    source: reference.source,
    sources,
    confidence: reference.confidence,
    display,
    exists,
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
    parseStatus: session.parseStatus,
    ...(session.skipReason ? { skipReason: session.skipReason } : {}),
    references: [...session.references.values()].map(finalizeReference),
  };
}

function consumeLine(session: MutableSession, line: string, maxReferences: number, maxLineLength: number): void {
  if (!line.trim()) return;
  if (line.length > maxLineLength) {
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

  const evidence = structuredEvidence(type, lineRecord, payload);
  const fallback = evidence.length || isStructuredEventType(type) ? [] : fallbackMessageEvidence(lineRecord, payload);
  for (const item of [...evidence, ...fallback]) {
    addReference(session, { ...item, eventType: type }, maxReferences);
  }
  if (fallback.length) session.parseMode = "message-path-fallback";
}

async function consumeRolloutStream(
  input: AsyncIterable<string>,
  session: MutableSession,
  maxReferences: number,
  maxLineLength: number,
): Promise<void> {
  let pending = "";
  let discarding = false;
  for await (const chunk of input) {
    let current = chunk;
    if (discarding) {
      const newline = current.indexOf("\n");
      if (newline < 0) continue;
      current = current.slice(newline + 1);
      discarding = false;
    }
    pending += current;
    let newline = pending.indexOf("\n");
    while (newline >= 0) {
      const line = pending.slice(0, newline).replace(/\r$/u, "");
      consumeLine(session, line, maxReferences, maxLineLength);
      pending = pending.slice(newline + 1);
      newline = pending.indexOf("\n");
    }
    if (pending.length > maxLineLength) {
      session.invalidLineCount++;
      pending = "";
      discarding = true;
    }
  }
  if (!discarding && pending) consumeLine(session, pending.replace(/\r$/u, ""), maxReferences, maxLineLength);
}

interface RolloutFileDescriptor {
  path: string;
  mtimeMs: number;
  size: number;
}

async function rolloutFiles(codexHome: string): Promise<RolloutFileDescriptor[]> {
  const root = path.join(codexHome, "sessions");
  const result: RolloutFileDescriptor[] = [];
  const visit = async (directory: string): Promise<void> => {
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch { return; }
    for (const entry of entries) {
      const full = path.resolve(path.join(directory, entry.name));
      if (entry.isDirectory()) await visit(full);
      else if (entry.isFile() && /^rollout-[^/\\]+\.jsonl$/u.test(entry.name)) {
        try {
          const info = await stat(full);
          result.push({ path: full, mtimeMs: info.mtimeMs, size: info.size });
        } catch { /* A deleted rollout is not a parse failure for other sessions. */ }
      }
    }
  };
  await visit(root);
  return result.sort((left, right) => right.path.localeCompare(left.path));
}

export function resolveCodexHome(explicit?: string, environment: NodeJS.ProcessEnv = process.env): string {
  const value = explicit?.trim() || environment.SEEKAH_CODEX_HOME?.trim() || environment.CODEX_HOME?.trim();
  return path.resolve(value || path.join(os.homedir(), ".codex"));
}

function fallbackSessionId(filePath: string): string {
  return `rollout-${createHash("sha256").update(path.normalize(filePath), "utf8").digest("hex").slice(0, 16)}`;
}

async function parseCodexRolloutDescriptor(
  file: RolloutFileDescriptor,
  options: Pick<CodexSessionParserOptions, "maxReferencesPerSession" | "maxFileBytes" | "maxLineLength"> = {},
): Promise<CodexSession> {
  const session = createMutableSession(fallbackSessionId(file.path));
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  if (file.size > maxFileBytes) {
    session.parseStatus = "skipped";
    session.skipReason = "file-too-large";
    return finalizeSession(session);
  }
  const input = createReadStream(file.path, { encoding: "utf8", highWaterMark: 64 * 1024 });
  try {
    await consumeRolloutStream(input, session, options.maxReferencesPerSession ?? DEFAULT_MAX_REFERENCES, options.maxLineLength ?? DEFAULT_MAX_LINE_LENGTH);
  } finally {
    input.destroy();
  }
  return finalizeSession(session);
}

function cacheKey(filePath: string): string {
  return path.resolve(filePath);
}

async function parseCachedDescriptor(
  file: RolloutFileDescriptor,
  options: Pick<CodexSessionParserOptions, "maxReferencesPerSession" | "maxFileBytes" | "maxLineLength">,
  cache: CodexSessionCache,
): Promise<CodexSession> {
  const key = cacheKey(file.path);
  const cached = cache.get(key);
  if (cached && cached.mtimeMs === file.mtimeMs && cached.size === file.size) return cached.session;
  const session = await parseCodexRolloutDescriptor(file, options);
  cache.set(key, { mtimeMs: file.mtimeMs, size: file.size, session });
  return session;
}

export async function parseCodexRolloutFile(
  filePath: string,
  options: Pick<CodexSessionParserOptions, "maxReferencesPerSession" | "maxFileBytes" | "maxLineLength"> = {},
): Promise<CodexSession> {
  const resolved = cacheKey(filePath);
  const info = await stat(resolved);
  return parseCodexRolloutDescriptor({ path: resolved, mtimeMs: info.mtimeMs, size: info.size }, options);
}

export async function parseCodexRolloutFileCached(
  filePath: string,
  options: Pick<CodexSessionParserOptions, "maxReferencesPerSession" | "maxFileBytes" | "maxLineLength"> = {},
  cache: CodexSessionCache,
): Promise<CodexSession> {
  const resolved = cacheKey(filePath);
  const info = await stat(resolved);
  return parseCachedDescriptor({ path: resolved, mtimeMs: info.mtimeMs, size: info.size }, options, cache);
}

export async function parseCodexSessionFiles(options: CodexSessionParserOptions = {}): Promise<CodexSessionFile[]> {
  const home = resolveCodexHome(options.codexHome, options.environment);
  const files = (await rolloutFiles(home)).slice(0, options.maxSessions ?? DEFAULT_MAX_SESSIONS);
  const sessions: CodexSessionFile[] = [];
  for (const file of files) {
    try {
      const session = options.cache
        ? await parseCachedDescriptor(file, options, options.cache)
        : await parseCodexRolloutDescriptor(file, options);
      sessions.push({ ...file, session });
    } catch { /* A deleted or unreadable rollout is not a reason to expose raw filesystem errors. */ }
  }
  return sessions.sort((left, right) =>
    (right.session.startedAt ?? "").localeCompare(left.session.startedAt ?? "") || right.session.id.localeCompare(left.session.id));
}

export async function parseCodexSessions(options: CodexSessionParserOptions = {}): Promise<CodexSession[]> {
  return (await parseCodexSessionFiles(options)).map(file => file.session);
}

function referenceSummary(session: CodexSession): CodexSessionSummary {
  const sourceCounts = Object.fromEntries(CODEX_REFERENCE_SOURCES.map(source => [source, 0])) as Record<CodexReferenceSource, number>;
  for (const reference of session.references) for (const source of reference.sources) sourceCounts[source]++;
  const lowReferenceCount = session.references.filter(reference => !reference.exists && !reference.indexed).length;
  const { references: _references, ...summary } = session;
  return {
    ...summary,
    referenceCount: session.references.length,
    visibleReferenceCount: session.references.length - lowReferenceCount,
    lowReferenceCount,
    sourceCounts,
  };
}

export function summarizeCodexSessions(sessions: readonly CodexSession[]): CodexSessionSummary[] {
  return sessions.map(referenceSummary);
}

export function codexReferenceBuckets(references: readonly CodexSessionReference[]): {
  references: CodexSessionReference[];
  lowReferences: CodexSessionReference[];
} {
  const visible: CodexSessionReference[] = [];
  const lowReferences: CodexSessionReference[] = [];
  for (const reference of references) {
    if (reference.exists || reference.indexed) visible.push(reference);
    else lowReferences.push(reference);
  }
  return { references: visible, lowReferences };
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
      if (!document) {
        return {
          ...reference,
          indexed: false,
          display: reference.exists ? "normal" : "low-confidence-missing",
          ...(reference.display === "low-confidence-missing" ? { indexedStatus: "low-confidence-missing" } : {}),
        };
      }
      return {
        ...reference,
        display: "normal",
        indexed: true,
        indexedPath: document.path,
        seekahReference: documentReference(document.id, document.path),
        indexedStatus: document.status,
      };
    }),
  }));
}


export function codexReferencePathForTest(value: string): string | null {
  return normalizeAbsolutePath(value);
}
