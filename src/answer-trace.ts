import { randomUUID } from "node:crypto";

export const ANSWER_TRACE_SCHEMA_VERSION = 2;

export const answerTracePhases = [
  "inputValidation",
  "contextBuild",
  "routeResolution",
  "previewValidation",
  "providerRequest",
  "responseParsing",
  "other",
] as const;

export type AnswerTracePhase = typeof answerTracePhases[number];
export type AnswerTraceStatus = "success" | "error";

export interface AnswerTraceCounts {
  selectedDocuments: number;
  contextBytes: number;
  answerCharacters: number;
  answerBytes: number;
  providerAttempts: number;
}

export interface AnswerTrace {
  schemaVersion: number;
  traceId: string;
  type: "answer";
  startedAt: string;
  completedAt: string;
  durationMs: number;
  bottleneck: AnswerTracePhase;
  question: string;
  provider: string;
  model: string;
  fallbackUsed: boolean;
  status: AnswerTraceStatus;
  errorCode?: string;
  phasesMs: Record<AnswerTracePhase, number>;
  counts: AnswerTraceCounts;
}

function emptyPhases(): Record<AnswerTracePhase, number> {
  return Object.fromEntries(answerTracePhases.map(phase => [phase, 0])) as Record<AnswerTracePhase, number>;
}

function emptyCounts(): AnswerTraceCounts {
  return {
    selectedDocuments: 0,
    contextBytes: 0,
    answerCharacters: 0,
    answerBytes: 0,
    providerAttempts: 0,
  };
}

export class AnswerTraceRecorder {
  private readonly traceId = randomUUID();
  private readonly startedAt = new Date().toISOString();
  private readonly startedClock = performance.now();
  private readonly phaseTotals = emptyPhases();
  private readonly countValues = emptyCounts();
  private provider = "";
  private model = "";
  private fallbackUsed = false;
  private status: AnswerTraceStatus = "success";
  private errorCode: string | undefined;

  constructor(private readonly question: string) {}

  addPhase(phase: Exclude<AnswerTracePhase, "other">, elapsedMs: number): void {
    this.phaseTotals[phase] += Math.max(0, elapsedMs);
  }

  increment<K extends keyof AnswerTraceCounts>(count: K, amount = 1): void {
    this.countValues[count] += amount;
  }

  setCount<K extends keyof AnswerTraceCounts>(count: K, value: number): void {
    this.countValues[count] = Math.max(0, value);
  }

  setRoute(provider: string, model: string): void {
    this.provider = provider;
    this.model = model;
  }

  setFallbackUsed(value: boolean): void {
    this.fallbackUsed = value;
  }

  setContext(bytes: number, selectedDocuments: number): void {
    this.setCount("contextBytes", bytes);
    this.setCount("selectedDocuments", selectedDocuments);
  }

  setAnswer(answer: string): void {
    this.setCount("answerCharacters", answer.length);
    this.setCount("answerBytes", Buffer.byteLength(answer, "utf8"));
  }

  setError(code: string): void {
    this.status = "error";
    this.errorCode = code;
  }

  snapshot(): AnswerTrace {
    const durationMs = Math.max(0, performance.now() - this.startedClock);
    const phasesMs = { ...this.phaseTotals };
    const measured = answerTracePhases
      .filter(phase => phase !== "other")
      .reduce((total, phase) => total + phasesMs[phase], 0);
    phasesMs.other = Math.max(0, durationMs - measured);
    let bottleneck: AnswerTracePhase = "other";
    for (const phase of answerTracePhases) {
      if (phasesMs[phase] > phasesMs[bottleneck]) bottleneck = phase;
    }
    const trace: AnswerTrace = {
      schemaVersion: ANSWER_TRACE_SCHEMA_VERSION,
      traceId: this.traceId,
      type: "answer",
      startedAt: this.startedAt,
      completedAt: new Date().toISOString(),
      durationMs,
      bottleneck,
      question: this.question,
      provider: this.provider,
      model: this.model,
      fallbackUsed: this.fallbackUsed,
      status: this.status,
      phasesMs,
      counts: { ...this.countValues },
    };
    if (this.errorCode) trace.errorCode = this.errorCode;
    return trace;
  }
}
