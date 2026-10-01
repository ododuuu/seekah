export const WORKBENCH_OPEN_MODES = ["ask", "auto", "off"] as const;
export type WorkbenchOpenMode = (typeof WORKBENCH_OPEN_MODES)[number];

export const DEFAULT_WORKBENCH_OPEN_MODE: WorkbenchOpenMode = "ask";

export function isWorkbenchOpenMode(value: unknown): value is WorkbenchOpenMode {
  return typeof value === "string" && (WORKBENCH_OPEN_MODES as readonly string[]).includes(value);
}

export function resolveWorkbenchOpenMode(value: unknown): WorkbenchOpenMode {
  return isWorkbenchOpenMode(value) ? value : DEFAULT_WORKBENCH_OPEN_MODE;
}

