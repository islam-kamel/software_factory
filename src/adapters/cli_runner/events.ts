// ============================================================
// events.ts
// Purpose : Parse CLI JSON lines and validate usage counters
// Feature : Agent execution
// Role    : Adapter Utility
// API Doc : N/A
// ============================================================
export function parseJsonLines(output: string): Record<string, unknown>[] {
  return output
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      try {
        const value: unknown = JSON.parse(line);
        if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error();
        return value as Record<string, unknown>;
      } catch {
        throw new Error("CLI returned malformed structured output");
      }
    });
}

export function count(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return null;
  return value;
}

export function price(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  return value;
}

export function getRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
