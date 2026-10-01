export const STARTUP_CATCHUP_MODES = ["ask", "auto", "off"] as const;
export type StartupCatchupMode = (typeof STARTUP_CATCHUP_MODES)[number];

export const DEFAULT_STARTUP_CATCHUP_MODE: StartupCatchupMode = "auto";

export type StartupCatchupState = "none" | "pending" | "running" | "complete" | "skipped";
export type StartupCatchupAction = "start" | "skip";

export function isStartupCatchupMode(value: unknown): value is StartupCatchupMode {
  return typeof value === "string" && (STARTUP_CATCHUP_MODES as readonly string[]).includes(value);
}

export function resolveStartupCatchupMode(value: unknown): StartupCatchupMode {
  return isStartupCatchupMode(value) ? value : DEFAULT_STARTUP_CATCHUP_MODE;
}

export function startupCatchupModeLabel(mode: StartupCatchupMode): string {
  return mode === "ask" ? "詢問後補捉" : mode === "off" ? "不補捉" : "自動補捉";
}
