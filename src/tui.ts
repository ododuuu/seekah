import path from "node:path";
import { actOnDocument } from "./open-document.js";
import { copyToClipboard } from "./clipboard.js";
import { prepareSelectedContext, terminalText, type SelectedContextReference } from "./context.js";
import type { SearchMode, SearchResult, SearchResultPage } from "./search.js";
import { formatTotal, SearchIndexChangedError, SearchSession } from "./search-session.js";
import type { IndexStore } from "./store.js";
import { productVersion } from "./version.js";

export type TuiStopReason = "eof" | "sigint" | "sigterm";
export type TuiEvent =
  | { type: "text"; text: string }
  | { type: "up" | "down" | "space" | "enter" | "page-up" | "page-down" | "escape" | "left" | "tab" | "shift-tab" | "backspace" | "resize" }
  | { type: "eof" | "interrupt" | "terminate" };

export type TuiFocus = "input" | "results" | "selected";
export type TuiView = "home" | "results" | "help" | "selected" | "roots" | "context" | "preview" | "status" | "commands";

export interface TuiIO {
  readonly ansi: boolean;
  readonly color?: boolean;
  readonly colorDepth?: number;
  write(text: string): void;
  ask(prompt: string): Promise<string | null>;
  nextEvent?: () => Promise<TuiEvent | null>;
  stopReason?: () => TuiStopReason;
  size?: () => { columns: number; rows: number };
}

export interface TuiKeyDescriptor {
  name?: string;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
}

export function decodeTuiKey(sequence: string, key: TuiKeyDescriptor = {}): TuiEvent | null {
  if (key.ctrl && key.name === "c") return { type: "interrupt" };
  if (key.ctrl && key.name === "d") return { type: "eof" };
  if (key.shift && key.name === "tab") return { type: "shift-tab" };
  const named: Record<string, TuiEvent["type"]> = {
    up: "up", down: "down", left: "left", space: "space", return: "enter", enter: "enter",
    pageup: "page-up", pagedown: "page-down", escape: "escape", tab: "tab", backspace: "backspace",
  };
  const type = key.name ? named[key.name] : undefined;
  if (type) return { type } as TuiEvent;
  const sequences: Record<string, TuiEvent["type"]> = {
    "\u001b[A": "up", "\u001b[B": "down", "\u001b[D": "left", "\u001b[5~": "page-up",
    "\u001b[6~": "page-down", "\u001b[Z": "shift-tab", "\u001b": "escape", "\r": "enter", "\n": "enter", "\t": "tab",
  };
  const sequenceType = sequences[sequence];
  if (sequenceType) return { type: sequenceType } as TuiEvent;
  if (sequence === "\u007f" || sequence === "\b") return { type: "backspace" };
  if (sequence === " ") return { type: "space" };
  if (sequence && !key.ctrl && !key.meta) return { type: "text", text: sequence };
  return null;
}

const rawSequences: Record<string, TuiEvent["type"]> = {
  "\u001b[A": "up", "\u001b[B": "down", "\u001b[D": "left", "\u001b[5~": "page-up",
  "\u001b[6~": "page-down", "\u001b[Z": "shift-tab",
};

/** Raw-mode decoder. It preserves split CSI sequences and delays a lone Esc until flush(). */
export class TuiInputDecoder {
  private buffer = "";

  push(text: string): TuiEvent[] {
    this.buffer += text;
    return this.drain(false);
  }

  flush(): TuiEvent[] {
    return this.drain(true);
  }

  get pending(): boolean {
    return this.buffer.length > 0;
  }

  private drain(flush: boolean): TuiEvent[] {
    const events: TuiEvent[] = [];
    while (this.buffer) {
      if (this.buffer.startsWith("\u0003")) {
        events.push({ type: "interrupt" });
        this.buffer = this.buffer.slice(1);
        continue;
      }
      if (this.buffer.startsWith("\u0004")) {
        events.push({ type: "eof" });
        this.buffer = this.buffer.slice(1);
        continue;
      }
      if (this.buffer.startsWith("\u001b")) {
        const matched = Object.entries(rawSequences).find(([sequence]) => this.buffer.startsWith(sequence));
        if (matched) {
          events.push({ type: matched[1] } as TuiEvent);
          this.buffer = this.buffer.slice(matched[0].length);
          continue;
        }
        if (!flush && (this.buffer === "\u001b" || Object.keys(rawSequences).some(sequence => sequence.startsWith(this.buffer)))) break;
        events.push({ type: "escape" });
        this.buffer = this.buffer.slice(1);
        continue;
      }
      const [character] = this.buffer;
      if (character === "\r" || character === "\n") events.push({ type: "enter" });
      else if (character === "\t") events.push({ type: "tab" });
      else if (character === "\u007f" || character === "\b") events.push({ type: "backspace" });
      else if (character === " ") events.push({ type: "space" });
      else {
        const controlIndex = this.buffer.search(/[\u0003\u0004\u0008\u0009\u000a\u000d\u001b\u007f ]/u);
        const end = controlIndex <= 0 ? this.buffer.length : controlIndex;
        events.push({ type: "text", text: this.buffer.slice(0, end) });
        this.buffer = this.buffer.slice(end);
        continue;
      }
      this.buffer = this.buffer.slice(character.length);
    }
    return events;
  }
}

interface CommandSpec {
  name: string;
  group: string;
  usage: string;
  summary: string;
}

export const tuiCommands: readonly CommandSpec[] = [
  { name: "home", group: "搜尋／縮小", usage: "/home", summary: "首頁與本次搜尋紀錄" },
  { name: "search", group: "搜尋／縮小", usage: "/search <片語>", summary: "精確片語搜尋" },
  { name: "all", group: "搜尋／縮小", usage: "/all <詞1 詞2>", summary: "同一文件包含全部詞" },
  { name: "refine", group: "搜尋／縮小", usage: "/refine <文字>", summary: "在目前完整結果內縮小" },
  { name: "back", group: "搜尋／縮小", usage: "/back", summary: "撤回一層縮小" },
  { name: "reset", group: "搜尋／縮小", usage: "/reset", summary: "重設縮小條件" },
  { name: "next", group: "翻頁", usage: "/next", summary: "結果下一頁" },
  { name: "prev", group: "翻頁", usage: "/prev", summary: "結果上一頁" },
  { name: "open", group: "開啟", usage: "/open <編號|代碼>", summary: "開啟文件" },
  { name: "reveal", group: "開啟", usage: "/reveal <編號|代碼>", summary: "顯示所在資料夾" },
  { name: "select", group: "選取籃／context", usage: "/select <編號|代碼>", summary: "加入上下文選取籃" },
  { name: "unselect", group: "選取籃／context", usage: "/unselect <編號|代碼>", summary: "移除選取" },
  { name: "selected", group: "選取籃／context", usage: "/selected", summary: "查看選取籃" },
  { name: "clear", group: "選取籃／context", usage: "/clear", summary: "清空選取籃" },
  { name: "context", group: "選取籃／context", usage: "/context [1～10]", summary: "預覽並確認複製" },
  { name: "status", group: "狀態", usage: "/status", summary: "索引摘要" },
  { name: "roots", group: "狀態", usage: "/roots", summary: "根目錄清單" },
  { name: "help", group: "說明／退出", usage: "/help", summary: "顯示命令" },
  { name: "quit", group: "說明／退出", usage: "/quit", summary: "離開" },
  { name: "q", group: "說明／退出", usage: "/q", summary: "離開" },
  { name: "exit", group: "說明／退出", usage: "/exit", summary: "離開" },
];

const commandNames: Record<string, true> = Object.fromEntries(tuiCommands.map(command => [command.name, true]));
const dotAliases: Record<string, true> = { help: true, quit: true, q: true, exit: true };
const quitNames: Record<string, true> = { quit: true, q: true, exit: true };

export type ParsedTui =
  | { kind: "empty" }
  | { kind: "search"; query: string }
  | { kind: "slash-menu" }
  | { kind: "command"; name: string; argument: string; notice?: string }
  | { kind: "unknown"; name: string };

export function sanitizeTerminal(text: string): string {
  return [...text].map(char => {
    const code = char.codePointAt(0) ?? 0;
    if (char === "\n" || char === "\r" || char === "\t") return " ";
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f) || (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069)) {
      return `\\u${code.toString(16).padStart(4, "0")}`;
    }
    return char;
  }).join("");
}

function isCombining(code: number): boolean {
  return (code >= 0x0300 && code <= 0x036f) || (code >= 0x1ab0 && code <= 0x1aff)
    || (code >= 0x1dc0 && code <= 0x1dff) || (code >= 0x20d0 && code <= 0x20ff) || (code >= 0xfe20 && code <= 0xfe2f);
}

function isWide(code: number): boolean {
  return (code >= 0x1100 && code <= 0x115f) || code === 0x2329 || code === 0x232a
    || (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) || (code >= 0xac00 && code <= 0xd7a3)
    || (code >= 0xf900 && code <= 0xfaff) || (code >= 0xfe10 && code <= 0xfe19) || (code >= 0xfe30 && code <= 0xfe6f)
    || (code >= 0xff00 && code <= 0xff60) || (code >= 0xffe0 && code <= 0xffe6)
    || (code >= 0x1f300 && code <= 0x1faff) || (code >= 0x20000 && code <= 0x3fffd);
}

export function displayWidth(text: string): number {
  let width = 0;
  for (const char of sanitizeTerminal(text.replace(/\u001b\[[0-9;]*m/gu, ""))) {
    const code = char.codePointAt(0) ?? 0;
    if (!isCombining(code)) width += isWide(code) ? 2 : 1;
  }
  return width;
}

export function clipWidth(text: string, columns: number): string {
  const clean = sanitizeTerminal(text);
  if (columns < 2) return "";
  if (displayWidth(clean) <= columns) return clean;
  let width = 0;
  let out = "";
  for (const char of clean) {
    const code = char.codePointAt(0) ?? 0;
    const next = isCombining(code) ? 0 : isWide(code) ? 2 : 1;
    if (width + next > columns - 1) break;
    out += char;
    width += next;
  }
  return `${out}…`;
}

export function completeTuiCommand(line: string): string[] {
  if (!line.startsWith("/") || /\s/u.test(line)) return [];
  const prefix = line.slice(1).toLowerCase();
  return tuiCommands.filter(command => command.name.startsWith(prefix)).map(command => `/${command.name} `);
}

export function parseTuiInput(raw: string): ParsedTui {
  const input = raw.trim();
  if (!input) return { kind: "empty" };
  const dotted = input.match(/^\.\/([^\s]+)(?:\s+([\s\S]*))?$/u);
  if (dotted) {
    const name = dotted[1]!.toLowerCase();
    const argument = (dotted[2] ?? "").trim();
    if (dotAliases[name] && !argument) {
      return { kind: "command", name, argument: "", notice: `已將 ./${name} 視為 /${name}；標準寫法是 /${name}。` };
    }
    return { kind: "search", query: input };
  }
  if (input === "/") return { kind: "slash-menu" };
  if (!input.startsWith("/")) return { kind: "search", query: input };
  const [rawName, ...rest] = input.slice(1).split(/\s+/u);
  const name = (rawName ?? "").toLowerCase();
  if (!commandNames[name]) return { kind: "unknown", name };
  return { kind: "command", name, argument: rest.join(" ").trim() };
}

function helpLines(): string[] {
  const lines = ["命令以 / 開頭。方向鍵、Space、Enter、PgUp／PgDn 與 Tab 是主要操作；slash command 是相容 fallback。", ""];
  let group = "";
  for (const command of tuiCommands) {
    if (command.group !== group) {
      group = command.group;
      lines.push(`〔${group}〕`);
    }
    lines.push(`${command.usage}  ${command.summary}`);
  }
  lines.push("", "例：複製回本機 安裝", "例：/all 付款 例外", "例：/refine 附件", "例：/context 3", "例：/search ./help");
  return lines;
}

const paletteCommands = ["home", "search", "selected", "context", "status", "quit"];

export interface TuiReducerState {
  view: TuiView;
  focus: TuiFocus;
  cursor: number;
  selectedCursor: number;
  page: number;
  viewPage: number;
  input: string;
  previousView: TuiView;
  previousFocus: TuiFocus;
  previousCursor: number;
}

export interface TuiReducerBounds {
  resultCount: number;
  selectedCount: number;
  pageCount: number;
  viewPageCount: number;
  hasSession: boolean;
}

export function initialTuiState(): TuiReducerState {
  return {
    view: "home", focus: "input", cursor: 0, selectedCursor: 0, page: 1, viewPage: 1, input: "",
    previousView: "home", previousFocus: "input", previousCursor: 0,
  };
}

export function reduceTuiState(state: TuiReducerState, event: TuiEvent, bounds: TuiReducerBounds): TuiReducerState {
  if (["eof", "interrupt", "terminate", "resize"].includes(event.type)) return state;
  if (event.type === "tab" || event.type === "shift-tab") {
    const order: TuiFocus[] = ["input", "results", "selected"];
    const at = order.indexOf(state.focus);
    const delta = event.type === "tab" ? 1 : -1;
    const focus = order[(at + delta + order.length) % order.length]!;
    const view: TuiView = focus === "selected" ? "selected" : focus === "results" && bounds.hasSession ? "results" : state.view === "home" ? "home" : "results";
    return { ...state, focus, view, viewPage: 1 };
  }
  if (event.type === "escape" || event.type === "left") {
    if (["preview", "context", "help", "roots", "status", "commands"].includes(state.view)) {
      return { ...state, view: state.previousView, focus: state.previousFocus, cursor: state.previousCursor, viewPage: 1, input: "" };
    }
    if (state.focus === "selected") return { ...state, view: bounds.hasSession ? "results" : "home", focus: bounds.hasSession ? "results" : "input", viewPage: 1 };
    if (state.focus === "results") return { ...state, focus: "input", view: bounds.hasSession ? "results" : "home" };
    return { ...state, input: "" };
  }
  if (state.focus === "input") {
    if (event.type === "text") return { ...state, input: state.input + event.text };
    if (event.type === "space") return { ...state, input: state.input + " " };
    if (event.type === "backspace") return { ...state, input: [...state.input].slice(0, -1).join("") };
    if ((event.type === "up" || event.type === "down") && bounds.hasSession) {
      return { ...state, focus: "results", view: "results", cursor: event.type === "down" ? Math.min(1, Math.max(0, bounds.resultCount - 1)) : 0 };
    }
    if ((event.type === "page-up" || event.type === "page-down") && ["context", "preview", "help", "roots", "status", "commands"].includes(state.view)) {
      const viewPage = Math.max(1, Math.min(bounds.viewPageCount, state.viewPage + (event.type === "page-down" ? 1 : -1)));
      return { ...state, viewPage };
    }
    return state;
  }
  if (state.focus === "results") {
    if (event.type === "up" || event.type === "down") {
      return { ...state, cursor: Math.max(0, Math.min(Math.max(0, bounds.resultCount - 1), state.cursor + (event.type === "down" ? 1 : -1))) };
    }
    if (event.type === "page-up" || event.type === "page-down") {
      return { ...state, page: Math.max(1, Math.min(bounds.pageCount, state.page + (event.type === "page-down" ? 1 : -1))), cursor: 0 };
    }
  }
  if (state.focus === "selected" && (event.type === "up" || event.type === "down")) {
    return { ...state, selectedCursor: Math.max(0, Math.min(Math.max(0, bounds.selectedCount - 1), state.selectedCursor + (event.type === "down" ? 1 : -1))) };
  }
  if (["context", "preview", "help", "roots", "status", "commands"].includes(state.view)
      && (event.type === "up" || event.type === "down" || event.type === "page-up" || event.type === "page-down")) {
    const delta = event.type === "up" || event.type === "page-up" ? -1 : 1;
    return { ...state, viewPage: Math.max(1, Math.min(bounds.viewPageCount, state.viewPage + delta)) };
  }
  return state;
}

interface SelectedItem extends SelectedContextReference {
  path: string;
  mode: SearchMode;
  snippet?: string;
  location?: string;
}

export interface TuiWorkflowEntry {
  kind: "prompt" | "search" | "selection" | "context" | "notice";
  text: string;
  detail?: string;
}

export interface TuiScreenModel {
  state: TuiReducerState;
  columns: number;
  rows: number;
  color: boolean;
  roots: readonly string[];
  documents: number;
  page: SearchResultPage | null;
  conditions: readonly string[];
  /** `gte` when the fast-mode total is a lower bound (SPEC §52.3). */
  totalRelation?: "eq" | "gte";
  mode: SearchMode;
  selected: readonly SelectedItem[];
  viewLines: readonly string[];
  message: string;
  confirming: boolean;
  workflow: readonly TuiWorkflowEntry[];
  recentQueries?: readonly string[];
  colorDepth?: number;
}


function viewLabel(view: TuiView): string {
  if (view === "help" || view === "commands") return "命令";
  if (view === "selected") return "已選文件";
  if (view === "context") return "選取內容預覽";
  if (view === "preview") return "文件預覽";
  if (view === "roots") return "根目錄";
  if (view === "status") return "索引狀態";
  return "";
}

function footerFor(model: TuiScreenModel): string {
  const { state } = model;
  if (model.confirming) return "yes+Enter 複製 · Esc 取消 · /quit 離開";
  if (state.view === "commands") return "↑↓/Tab 移動 · Enter 執行 · Esc 返回 · q 離開";
  if (["preview", "context", "help", "commands", "roots", "status"].includes(state.view)) return "↑↓/PgUp/PgDn 捲動 · Esc/← 返回 · q 離開";
  if (state.focus === "input") return "Enter 搜尋 · Tab 切換 · / 命令 · Ctrl+C 中止";
  if (state.focus === "selected") return "↑↓ 移動 · Space 取消 · Enter 預覽 · c context · Tab 切換 · q 離開";
  return "↑↓ 移動 · Space 選取 · Enter 預覽 · PgUp/PgDn 翻頁 · Tab 切換 · q 離開";
}

export function renderTuiScreen(model: TuiScreenModel): string {
  const columns = Math.max(20, model.columns || 80);
  const rows = Math.max(8, model.rows || 24);
  const margin = columns >= 100 ? 4 : 2;
  const width = Math.max(8, columns - margin * 2);
  const palette = {
    bg: "31;31;35",
    panel: "39;39;42",
    text: "232;230;227",
    muted: "161;161;170",
    accent: "138;180;248",
    warning: "216;166;87",
  };
  type Tone = "text" | "muted" | "accent" | "warning";
  type Surface = "bg" | "panel";
  const paint = (text: string, tone: Tone = "text", surface: Surface = "bg", bold = false) => {
    if (!model.color) return text;
    const foreground = palette[tone];
    const background = palette[surface];
    const codes = (model.colorDepth ?? 24) >= 24
      ? `38;2;${foreground};48;2;${background}`
      : `${tone === "accent" ? 94 : tone === "warning" ? 93 : tone === "muted" ? 90 : 97};${surface === "bg" ? 40 : 100}`;
    return `\u001b[${bold ? "1;" : ""}${codes}m${text}\u001b[0m`;
  };
  const pad = (text: string, cells: number) => {
    const clipped = clipWidth(text, cells);
    return clipped + " ".repeat(Math.max(0, cells - displayWidth(clipped)));
  };
  const row = (text = "", tone: Tone = "text", surface: Surface = "bg", bold = false) =>
    paint(" ".repeat(margin), tone, surface) + paint(pad(text, width), tone, surface, bold) + paint(" ".repeat(margin), tone, surface);
  const mixed = (parts: ReadonlyArray<{ text: string; tone?: Tone; bold?: boolean }>, surface: Surface = "bg") => {
    let inner = "";
    let used = 0;
    for (const part of parts) {
      const text = clipWidth(part.text, Math.max(0, width - used));
      inner += paint(text, part.tone ?? "text", surface, part.bold);
      used += displayWidth(text);
    }
    inner += paint(" ".repeat(Math.max(0, width - used)), "text", surface);
    return paint(" ".repeat(margin), "text", surface) + inner + paint(" ".repeat(margin), "text", surface);
  };
  const blank = row();
  const root = model.roots.length === 1 ? model.roots[0]! : model.roots.length ? `${model.roots.length} 個根目錄` : "尚無根目錄";
  const mode = model.mode === "all-terms" ? "全部關鍵字" : "精確片語";
  const selectedLabel = `已選 ${model.selected.length}`;
  const headerParts: Array<{ text: string; tone?: Tone; bold?: boolean }> = [
    { text: `seekah ${productVersion}`, tone: "accent", bold: true },
  ];
  if (columns >= 68) headerParts.push({ text: `  ·  ${model.documents} 份文件`, tone: "muted" });
  if (columns >= 80) headerParts.push({ text: `  ·  ${root}`, tone: "muted" });
  headerParts.push({ text: `  ·  ${selectedLabel}`, tone: "text", bold: true });
  if (columns < 60 || rows < 16) {
    const lines = [
      mixed(headerParts),
      blank,
      row("終端空間不足：請放大至至少 60×16。", "warning"),
    ];
    while (lines.length < rows - 3) lines.push(blank);
    lines.push(row(model.message, "muted"), mixed([{ text: "› ", tone: "accent" }, { text: `${model.confirming ? "確認" : "搜尋"} › ${model.state.input}` }], "panel"));
    lines.push(row("/help · /quit 離開 · Ctrl+C 中止", "muted", "panel"));
    return lines.slice(0, rows).join("\n");
  }

  const bodyRows = rows - 5;
  type RenderBlock = { lines: string[]; mandatory?: boolean };
  const workflowBlocks: RenderBlock[] = model.workflow.map((entry, index) => {
    const latest = index === model.workflow.length - 1;
    if (entry.kind === "prompt") {
      return {
        lines: [
          mixed([{ text: "    › ", tone: "accent", bold: true }, { text: entry.text, bold: true }], "panel"),
          mixed([{ text: "      ", tone: "muted" }, { text: entry.detail ?? "使用者查詢", tone: "muted" }], "panel"),
          blank,
        ],
        mandatory: latest,
      };
    }
    const labels: Record<Exclude<TuiWorkflowEntry["kind"], "prompt">, string> = {
      search: "搜尋",
      selection: "選取",
      context: "Context",
      notice: "提示",
    };
    return {
      lines: [
        mixed([
          { text: entry.kind === "notice" ? "! " : "◆ ", tone: entry.kind === "notice" ? "warning" : "accent", bold: true },
          { text: `${labels[entry.kind]}  `, tone: "muted" },
          { text: entry.text, bold: true },
        ]),
        mixed([{ text: "  └ ", tone: "muted" }, { text: entry.detail ?? "", tone: entry.kind === "notice" ? "warning" : "muted" }]),
        blank,
      ],
      mandatory: latest,
    };
  });
  const titleRows = (title: string, right: string, detail: string): string[] => [
    mixed([
      { text: `◆ ${title}`, tone: "accent", bold: true },
      { text: " ".repeat(Math.max(2, width - displayWidth(`◆ ${title}`) - displayWidth(right))) },
      { text: right, tone: "muted" },
    ]),
    row(`  ${detail}`, "muted"),
  ];
  const fileRows = (filePath: string, snippet: string, location: string, checked: boolean, current: boolean, tag = ""): string[] => {
    const parts = filePath.split(/[/\\]/u);
    const name = parts.pop() || filePath;
    const surface: Surface = current ? "panel" : "bg";
    const pointer = current ? "›" : " ";
    return [
      mixed([
        { text: `${pointer} ${name}`, tone: current ? "accent" : "text", bold: true },
        { text: tag ? `  ${tag}` : "", tone: "muted" },
      ], surface),
      mixed([{ text: `  ${checked ? "[x]" : "[ ]"} ${filePath}`, tone: "muted" }], surface),
      mixed([{ text: `    ${location ? `${location} · ` : ""}${snippet}`, tone: "muted" }], surface),
    ];
  };

  const activeLines: string[] = [];
  if (model.state.view === "home") {
    if (!model.workflow.length) {
      activeLines.push(
        mixed([{ text: "seekah", tone: "accent", bold: true }]),
        row("從自己的文件，找到需要的答案。", "muted"),
        blank,
        row("輸入關鍵字後按 Enter；本次完成的操作會依時間顯示在這裡。", "muted"),
      );
    }
  } else if (model.state.view === "results") {
    activeLines.push(...titleRows(
      "搜尋結果",
      `${formatTotal(model.page?.total ?? 0, model.totalRelation ?? "eq")} 份文件`,
      `${model.conditions.join(" → ") || "尚未搜尋"} · ${mode} · 第 ${model.page?.page ?? 1}/${model.page?.pageCount ?? 1} 頁`,
    ));
    if (!model.page?.results.length) activeLines.push(row("找不到符合的文件。試著減少關鍵字。", "muted"));
    const refs = new Set(model.selected.map(item => item.reference));
    for (const [offset, result] of (model.page?.results ?? []).entries()) {
      activeLines.push(...fileRows(
        result.path,
        result.snippet,
        result.location ?? "",
        refs.has(result.reference),
        model.state.focus === "results" && offset === model.state.cursor,
        `${result.extension.replace(/^\./u, "").toUpperCase() || "無副檔名"} · ${result.reason}`,
      ));
    }
  } else if (model.state.view === "selected") {
    activeLines.push(...titleRows("已選文件", `${model.selected.length} 份文件`, "選取跨頁保留 · 最多 20 份"));
    const capacity = Math.max(1, Math.floor((bodyRows - 2) / 3));
    const start = Math.floor(model.state.selectedCursor / capacity) * capacity;
    for (const [offset, item] of model.selected.slice(start, start + capacity).entries()) {
      activeLines.push(...fileRows(
        item.path,
        item.snippet ?? `搜尋：${item.query}`,
        item.location ?? "",
        true,
        model.state.focus === "selected" && start + offset === model.state.selectedCursor,
      ));
    }
    if (!model.selected.length) activeLines.push(row("還沒有選取文件。Tab 回搜尋結果，按 Space 加入。", "muted"));
  } else if (model.state.view === "commands") {
    activeLines.push(...titleRows("命令", "Esc 返回", "選擇操作後按 Enter"));
    const shortcuts: Record<string, string> = { home: "/", search: "/", selected: "Tab", context: "↵", status: "↵", quit: "q" };
    for (const [index, name] of paletteCommands.entries()) {
      const command = tuiCommands.find(item => item.name === name)!;
      const current = index === model.state.cursor;
      activeLines.push(mixed([
        { text: current ? "› " : "  ", tone: current ? "accent" : "text" },
        { text: `/${name.padEnd(12)} ${command.summary}`, tone: current ? "accent" : "text" },
        { text: `  ${shortcuts[name] ?? ""}`, tone: "muted" },
      ], current ? "panel" : "bg"));
    }
  } else {
    const available = Math.max(1, rows - 16);
    const pages = Math.max(1, Math.ceil(model.viewLines.length / available));
    const current = Math.min(pages, model.state.viewPage);
    const detail = model.confirming
      ? "只有輸入完整 yes 才會複製；尚未傳送"
      : "Esc／← 返回";
    activeLines.push(...titleRows(viewLabel(model.state.view), `第 ${current}/${pages} 頁`, detail));
    for (const text of model.viewLines.slice((current - 1) * available, current * available)) activeLines.push(row(`  ${text}`));
  }

  const activeBlock: RenderBlock = { lines: activeLines, mandatory: true };
  const blocks: RenderBlock[] = [];
  const latestSearch = model.state.view === "results"
    ? model.workflow.reduce((found, entry, index) => entry.kind === "search" ? index : found, -1)
    : -1;
  for (const [index, block] of workflowBlocks.entries()) {
    blocks.push(block);
    if (index === latestSearch) blocks.push(activeBlock);
  }
  if (latestSearch < 0) blocks.push(activeBlock);
  let total = blocks.reduce((sum, block) => sum + block.lines.length, 0);
  while (total > bodyRows) {
    const removable = blocks.findIndex(block => !block.mandatory);
    if (removable < 0) break;
    total -= blocks[removable]!.lines.length;
    blocks.splice(removable, 1);
  }
  const body = blocks.flatMap(block => block.lines);
  if (body.length > bodyRows) body.splice(0, body.length - bodyRows);
  while (body.length < bodyRows) body.push(blank);

  const header = mixed(headerParts);
  const messageTone: Tone = /(?:錯|失敗|取消|不可|未知|不足|SEARCH_)/u.test(model.message) ? "warning" : "muted";
  const query = model.state.input || (model.state.focus !== "input" ? model.conditions.at(-1) ?? "" : "");
  const composerLabel = model.confirming ? "確認" : "搜尋";
  const composerDetail = model.confirming
    ? `${footerFor(model)} · 尚未傳送`
    : `${mode} · ${root} · ${footerFor(model)}`;
  return [
    header,
    blank,
    ...body,
    row(model.message, messageTone),
    mixed([{ text: "› ", tone: "accent", bold: true }, { text: `${composerLabel} › ${query}` }], "panel"),
    row(composerDetail, "muted", "panel"),
  ].slice(0, rows).join("\n");
}

function stopCode(io: TuiIO): number {
  const reason = io.stopReason?.() ?? "eof";
  if (reason === "sigint") return 130;
  if (reason === "sigterm") return 143;
  return 0;
}

function resolveReference(value: string, page: SearchResultPage | null): string | null {
  if (/^[1-9]\d*-[0-9a-f]{16}$/u.test(value)) return value;
  if (!/^\d+$/u.test(value) || !page) return null;
  const absolute = Number(value);
  if (absolute >= page.start && absolute <= page.end) return page.results[absolute - page.start]?.reference ?? null;
  return page.results[absolute - 1]?.reference ?? null;
}

export async function runTui(
  store: IndexStore,
  io: TuiIO,
  maximumPageSize = 10,
  clipboardWriter: (text: string) => Promise<void> = copyToClipboard,
): Promise<number> {
  let session: SearchSession | null = null;
  let page: SearchResultPage | null = null;
  let pageSize = maximumPageSize;
  let state = initialTuiState();
  const selected = new Map<string, SelectedItem>();
  const recentQueries: string[] = [];
  const workflow: TuiWorkflowEntry[] = [];
  let message = "輸入關鍵字開始搜尋；/help 顯示全部命令。";
  let viewLines: string[] = [];
  let mode: SearchMode = "phrase";
  let pendingContext: { text: string; createdAt: string; passages: number; mode: SearchMode } | null = null;
  let cleaned = false;

  const appendWorkflow = (...entries: readonly TuiWorkflowEntry[]) => {
    workflow.push(...entries);
    if (workflow.length > 12) workflow.splice(0, workflow.length - 12);
  };
  const restore = () => {
    if (cleaned || !io.ansi) return;
    cleaned = true;
    io.write("\u001b[?1049l\u001b[?25h");
  };
  const size = () => {
    const measured = io.size?.() ?? { columns: 80, rows: 24 };
    return { columns: Math.max(20, measured.columns || 80), rows: Math.max(8, measured.rows || 24) };
  };
  const fittedPageSize = () => Math.max(1, Math.min(maximumPageSize, Math.floor((size().rows - 16) / 4)));
  const refreshPage = (preserveGlobal = false) => {
    if (!session) { page = null; return; }
    const previousGlobal = page && preserveGlobal ? (page.start - 1) + state.cursor : 0;
    pageSize = fittedPageSize();
    const pageCount = Math.max(1, Math.ceil(session.currentTotal / pageSize));
    const nextPage = preserveGlobal ? Math.floor(previousGlobal / pageSize) + 1 : state.page;
    state = { ...state, page: Math.max(1, Math.min(pageCount, nextPage)), cursor: preserveGlobal ? previousGlobal % pageSize : state.cursor };
    page = session.page(state.page, pageSize);
    state = { ...state, cursor: Math.max(0, Math.min(state.cursor, Math.max(0, page.results.length - 1))) };
  };
  const selectedValues = () => [...selected.values()];
  const viewPageCount = () => {
    const rows = size().rows;
    return Math.max(1, Math.ceil(viewLines.length / Math.max(1, rows - 16)));
  };
  const bounds = (): TuiReducerBounds => ({
    resultCount: page?.results.length ?? 0,
    selectedCount: selected.size,
    pageCount: page?.pageCount ?? 1,
    viewPageCount: viewPageCount(),
    hasSession: session !== null,
  });
  const render = () => {
    const measured = size();
    const counts = store.counts();
    const screen = renderTuiScreen({
      state, columns: measured.columns, rows: measured.rows,
      color: io.ansi && io.color !== false,
      colorDepth: io.colorDepth ?? 24, recentQueries, workflow,
      roots: store.roots(), documents: Object.values(counts).reduce((sum, count) => sum + count, 0),
      page, conditions: session?.conditions ?? [], totalRelation: session?.currentTotalRelation ?? "eq", mode, selected: selectedValues(), viewLines, message,
      confirming: pendingContext !== null,
    });
    io.write(`${io.ansi ? "\u001b[?25l\u001b[H\u001b[J" : ""}${screen}${io.ansi ? "" : "\n"}`);
  };
  const rememberView = () => {
    state = { ...state, previousView: state.view, previousFocus: state.focus, previousCursor: state.cursor };
  };
  const openView = (view: TuiView, lines: readonly string[], note: string, focus: TuiFocus = state.focus) => {
    rememberView();
    viewLines = [...lines];
    state = { ...state, view, focus, viewPage: 1 };
    message = note;
  };
  const showSelected = () => {
    state = { ...state, view: "selected", focus: "selected", selectedCursor: Math.min(state.selectedCursor, Math.max(0, selected.size - 1)), viewPage: 1 };
    message = selected.size ? `已選 ${selected.size}/20。` : "選取籃目前是空的。";
  };
  const search = (query: string, searchMode: SearchMode) => {
    const normalizedQuery = query.trim();
    if (!normalizedQuery) { message = "搜尋文字不可為空白。"; return; }
    mode = searchMode;
    session = new SearchSession(store, normalizedQuery, undefined, undefined, searchMode);
    const recentIndex = recentQueries.indexOf(normalizedQuery);
    if (recentIndex >= 0) recentQueries.splice(recentIndex, 1);
    recentQueries.unshift(normalizedQuery);
    recentQueries.length = Math.min(5, recentQueries.length);
    state = { ...state, view: "results", focus: "results", cursor: 0, page: 1, input: "" };
    refreshPage();
    const modeLabel = searchMode === "all-terms" ? "全部關鍵字" : "精確片語";
    appendWorkflow(
      { kind: "prompt", text: normalizedQuery, detail: modeLabel },
      { kind: "search", text: `找到 ${formatTotal(session.originalTotal, session.originalTotalRelation)} 份文件`, detail: `${modeLabel} · 真實索引結果` },
    );
    message = session.originalTotal ? "↑↓ 移動、Space 選取、Enter 預覽、PgUp/PgDn 翻頁。" : "沒有符合的結果。";
  };
  const movePage = (delta: number) => {
    if (!page) { message = "請先搜尋。"; return; }
    const next = state.page + delta;
    if (next < 1 || next > page.pageCount) { message = delta > 0 ? "已是最後一頁。" : "已是第一頁。"; return; }
    state = { ...state, page: next, cursor: 0, view: "results", focus: "results" };
    refreshPage();
    message = `已移至第 ${next} 頁。`;
  };
  const currentResult = () => page?.results[state.cursor];
  const selectResult = (result: SearchResult) => {
    const active = session;
    if (!active) return;
    const selectedMode = selected.values().next().value?.mode;
    if (selectedMode && selectedMode !== active.mode) { message = "同一選取籃不可混用片語與全部詞模式；請先 /clear。"; return; }
    if (selected.has(result.reference)) {
      selected.delete(result.reference);
      state = { ...state, selectedCursor: Math.min(state.selectedCursor, Math.max(0, selected.size - 1)) };
      message = `已取消：${path.basename(result.path)}`;
      return;
    }
    if (selected.size >= 20) { message = "選取籃最多 20 份文件；請先移除部分項目。"; return; }
    selected.set(result.reference, { query: active.conditions.at(-1)!, reference: result.reference, path: result.path, mode: active.mode, snippet: result.snippet, location: result.location ?? "" });
    message = `已選取：${path.basename(result.path)}`;
    appendWorkflow({
      kind: "selection",
      text: `已選取 ${path.basename(result.path)}`,
      detail: `目前已選 ${selected.size} 份`,
    });
  };
  const previewResult = (result: SearchResult) => {
    openView("preview", [
      path.basename(result.path), result.path, `${result.extension || "無副檔名"}${result.location ? ` · ${result.location}` : ""}`,
      "", result.snippet, "", `符合原因：${result.reason}`, `文件代碼：${result.reference}`,
    ], "文件預覽；這不會開啟外部程式。Esc／← 返回。", "results");
  };
  const startContext = async (passages: number) => {
    if (!selected.size) { message = "尚未選取文件；請先按 Space 選取。"; return; }
    const selectedMode = selected.values().next().value!.mode;
    message = "正在重新驗證已選文件並準備 context…";
    render();
    const prepared = await prepareSelectedContext(store, selectedValues().map(({ query, reference }) => ({ query, reference })), {
      passages, format: "md", ...(selectedMode === "all-terms" ? { allTerms: true } : {}),
    });
    const contextBytes = Buffer.byteLength(prepared.text, "utf8");
    const passageCount = prepared.data.documents.reduce((total, document) => total + document.passages.length, 0);
    pendingContext = { text: prepared.text, createdAt: prepared.data.createdAt, passages, mode: selectedMode };
    appendWorkflow({
      kind: "context",
      text: `已準備 ${selected.size} 份文件`,
      detail: `${passageCount} 個 passages · ${contextBytes} bytes`,
    });
    openView("context", prepared.text.split("\n").map(line => terminalText(line)), `完整預覽：${selected.size} 份，${contextBytes} bytes；輸入完整 yes 才複製。`, "input");
    state = { ...state, input: "" };
  };
  const finishContext = async (answer: string): Promise<number | null> => {
    const parsed = parseTuiInput(answer);
    if (parsed.kind === "command" && quitNames[parsed.name]) return 0;
    if (answer.trim() !== "yes") {
      pendingContext = null;
      state = { ...state, view: state.previousView, focus: state.previousFocus, cursor: state.previousCursor, input: "", viewPage: 1 };
      message = "已取消，未改動剪貼簿。";
      return null;
    }
    const pending = pendingContext!;
    const verified = await prepareSelectedContext(store, selectedValues().map(({ query, reference }) => ({ query, reference })), {
      passages: pending.passages, format: "md", ...(pending.mode === "all-terms" ? { allTerms: true } : {}),
    }, pending.createdAt);
    if (verified.text !== pending.text) throw new Error("預覽後索引或同步資訊已變更，請重新選取。");
    await clipboardWriter(pending.text);
    pendingContext = null;
    state = { ...state, view: "selected", focus: "selected", input: "", viewPage: 1 };
    message = `已複製 ${selected.size} 份已選片段到本機剪貼簿；未傳送至外部服務。`;
    return null;
  };
  const runAction = async (kind: "open" | "reveal", result: SearchResult | undefined) => {
    if (!result) { message = "目前沒有可操作的文件。"; return; }
    const target = await actOnDocument(store, result.reference, kind);
    message = `${kind === "open" ? "已送出開啟" : "已顯示所在資料夾"}：${target.path}${target.changed ? "（來源已有變更）" : ""}`;
  };

  if (io.ansi) io.write("\u001b[?1049h\u001b[?25h");
  try {
    while (true) {
      render();
      let answer: string | null = null;
      if (!io.nextEvent) {
        answer = await io.ask(pendingContext ? "確認 › " : "搜尋 › ");
        if (answer === null) return stopCode(io);
        if (pendingContext) {
          const code = await finishContext(answer);
          if (code !== null) return code;
          continue;
        }
      } else {
        const event = await io.nextEvent();
        if (event === null || event.type === "eof") return stopCode(io);
        if (event.type === "interrupt") return 130;
        if (event.type === "terminate") return 143;
        if (event.type === "resize") { refreshPage(true); continue; }
        if (pendingContext) {
          if (event.type === "escape" || event.type === "left") {
            pendingContext = null;
            state = { ...state, view: state.previousView, focus: state.previousFocus, cursor: state.previousCursor, input: "", viewPage: 1 };
            message = "已取消，未改動剪貼簿。";
            continue;
          }
          if (event.type === "page-up" || event.type === "page-down" || event.type === "up" || event.type === "down") {
            state = reduceTuiState(state, event, bounds());
            continue;
          }
          if (event.type === "text" || event.type === "space" || event.type === "backspace") {
            state = reduceTuiState(state, event, bounds());
            continue;
          }
          if (event.type === "enter") {
            const code = await finishContext(state.input);
            if (code !== null) return code;
          }
          continue;
        }
        if (state.view === "commands") {
          if (event.type === "text" && event.text === "q") return 0;
          if (["tab", "shift-tab", "up", "down"].includes(event.type)) {
            const delta = event.type === "up" || event.type === "shift-tab" ? -1 : 1;
            state = { ...state, cursor: (state.cursor + delta + paletteCommands.length) % paletteCommands.length };
            continue;
          }
          if (event.type === "enter") answer = `/${paletteCommands[state.cursor]}`;
        }
        if (answer === null) {
        if (event.type === "tab" || event.type === "shift-tab") {
          state = reduceTuiState(state, event, bounds());
          if (state.focus === "selected") showSelected();
          else if (state.focus === "results" && session) state = { ...state, view: "results" };
          continue;
        }
        if (event.type === "escape" || event.type === "left") {
          state = reduceTuiState(state, event, bounds());
          message = "已返回；選取籃保留。";
          continue;
        }
        if (["help", "commands", "roots", "status", "preview"].includes(state.view)
            && ["up", "down", "page-up", "page-down"].includes(event.type)) {
          state = reduceTuiState(state, event, bounds());
          continue;
        }
        if (state.focus === "input") {
          if (event.type === "text" || event.type === "space" || event.type === "backspace") {
            state = reduceTuiState(state, event, bounds());
            continue;
          }
          if ((event.type === "up" || event.type === "down") && session) {
            state = reduceTuiState(state, event, bounds());
            continue;
          }
          if (event.type !== "enter") continue;
          answer = state.input;
          state = { ...state, input: "" };
        } else if (state.focus === "results") {
          const result = currentResult();
          if (event.type === "text") {
            if (event.text === "q") return 0;
            if (event.text === "/") { state = { ...state, focus: "input", input: "/" }; continue; }
            if (event.text === "c") { await startContext(3); continue; }
            if (event.text === "o") { await runAction("open", result); continue; }
            if (event.text === "r") { await runAction("reveal", result); continue; }
            state = { ...state, focus: "input", input: event.text };
            continue;
          }
          if (event.type === "up" || event.type === "down") { state = reduceTuiState(state, event, bounds()); continue; }
          if (event.type === "page-up" || event.type === "page-down") { movePage(event.type === "page-down" ? 1 : -1); continue; }
          if (event.type === "space") { if (result) selectResult(result); else message = "目前沒有可選取的結果。"; continue; }
          if (event.type === "enter") { if (result) previewResult(result); else message = "目前沒有可預覽的結果。"; continue; }
          continue;
        } else {
          const item = selectedValues()[state.selectedCursor];
          if (event.type === "text") {
            if (event.text === "q") return 0;
            if (event.text === "/") { state = { ...state, focus: "input", view: session ? "results" : "home", input: "/" }; continue; }
            if (event.text === "c") { await startContext(3); continue; }
            state = { ...state, focus: "input", view: session ? "results" : "home", input: event.text };
            continue;
          }
          if (event.type === "up" || event.type === "down") { state = reduceTuiState(state, event, bounds()); continue; }
          if (event.type === "space") {
            if (!item) { message = "選取籃目前是空的。"; continue; }
            selected.delete(item.reference);
            state = { ...state, selectedCursor: Math.min(state.selectedCursor, Math.max(0, selected.size - 1)) };
            message = `已取消：${path.basename(item.path)}`;
            continue;
          }
          if (event.type === "enter") {
            if (!item) { message = "選取籃目前是空的。"; continue; }
            openView("preview", [path.basename(item.path), item.path, "", `搜尋條件：${item.query}`, `文件代碼：${item.reference}`], "已選文件預覽；Esc／← 返回。", "selected");
          }
          continue;
        }
        }
      }

      const parsed = parseTuiInput(answer);
      if (parsed.kind === "empty") { message = "請輸入搜尋文字或 /help。"; continue; }
      if (parsed.kind === "search") { search(parsed.query, "phrase"); continue; }
      if (parsed.kind === "slash-menu") {
        openView("commands", [], "命令清單；Esc 返回。", "input");
        state = { ...state, cursor: 0 };
        continue;
      }
      if (parsed.kind === "unknown") { message = `未知命令：/${parsed.name}；輸入 /help 查看命令。`; continue; }
      if (parsed.notice) message = parsed.notice;
      const command = parsed.name;
      const argument = parsed.argument;
      try {
        if (quitNames[command]) return 0;
        if (command === "home") { state = { ...state, view: "home", focus: "input", input: "" }; continue; }
        if (command === "help") { openView("help", helpLines(), "說明可翻頁；Esc 返回。", "input"); continue; }
        if (command === "search") {
          if (!argument) { state = { ...state, view: session ? "results" : "home", focus: "input", input: "" }; continue; }
          search(argument, "phrase"); continue;
        }
        if (command === "all") { search(argument, "all-terms"); continue; }
        if (command === "next" || command === "prev") { movePage(command === "next" ? 1 : -1); continue; }
        if (command === "refine") {
          const activeSession = session as SearchSession | null;
          if (!activeSession) { message = "請先搜尋。"; continue; }
          activeSession.append(argument); state = { ...state, page: 1, cursor: 0, view: "results", focus: "results" }; refreshPage(); message = "已縮小目前完整結果。"; continue;
        }
        if (command === "back" || command === "reset") {
          const activeSession = session as SearchSession | null;
          if (!activeSession) { message = "請先搜尋。"; continue; }
          const changed = command === "back" ? activeSession.back() : activeSession.reset();
          state = { ...state, page: 1, cursor: 0, view: "results", focus: "results" }; refreshPage(); message = changed ? "搜尋條件已更新。" : "已是最初結果。"; continue;
        }
        if (command === "open" || command === "reveal") {
          const reference = resolveReference(argument, page);
          if (!reference) { message = `請輸入本頁編號或文件代碼，例如 /${command} 1。`; continue; }
          const target = await actOnDocument(store, reference, command);
          message = `${command === "open" ? "已送出開啟" : "已顯示所在資料夾"}：${target.path}${target.changed ? "（來源已有變更）" : ""}`;
          continue;
        }
        if (command === "select") {
          const activeSession = session as SearchSession | null;
          const currentPage = page as SearchResultPage | null;
          const reference = resolveReference(argument, currentPage);
          const result = currentPage?.results.find(item => item.reference === reference);
          if (!activeSession || !result) { message = "請先搜尋，再輸入本頁編號或文件代碼，例如 /select 1。"; continue; }
          selectResult(result);
          continue;
        }
        if (command === "unselect") {
          let reference = /^[1-9]\d*-[0-9a-f]{16}$/u.test(argument) ? argument : undefined;
          if (!reference && /^\d+$/u.test(argument)) reference = selectedValues()[Number(argument) - 1]?.reference;
          if (!reference || !selected.delete(reference)) { message = "請輸入已選清單編號或文件代碼，例如 /unselect 1。"; continue; }
          state = { ...state, selectedCursor: Math.min(state.selectedCursor, Math.max(0, selected.size - 1)) };
          message = "已從選取籃移除。";
          continue;
        }
        if (command === "selected") { showSelected(); continue; }
        if (command === "clear") { selected.clear(); state = { ...state, selectedCursor: 0 }; message = "已清空選取籃。"; continue; }
        if (command === "context") {
          const passages = argument ? Number(argument) : 3;
          if (!Number.isSafeInteger(passages) || passages < 1 || passages > 10) { message = "/context 的 passage 數量必須為 1～10。"; continue; }
          await startContext(passages);
          continue;
        }
        if (command === "roots") {
          const roots = store.roots();
          openView("roots", roots.length ? roots : ["尚未登錄根目錄。"], roots.length ? "已登錄根目錄。" : "尚未登錄根目錄。", "input");
          continue;
        }
        if (command === "status") {
          const counts = store.counts();
          const lines = ["目前索引文件狀態", ...Object.entries(counts).map(([status, count]) => `${status}: ${count}`), "", "此畫面只顯示真實索引統計；不假設背景監看正在執行。"];
          openView("status", lines, "已讀取目前索引狀態。", "input");
        }
      } catch (error) {
        if (error instanceof SearchIndexChangedError) {
          session = null; page = null; pendingContext = null; workflow.length = 0;
          state = { ...initialTuiState(), input: "" };
          message = `SEARCH_INDEX_CHANGED：${error.message} 請重新搜尋。`;
        } else message = error instanceof Error ? error.message : String(error);
      }
    }
  } finally {
    restore();
  }
}
