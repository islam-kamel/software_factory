// ============================================================
// error_parser.ts
// Purpose : Reduce command output to actionable failure details
// Feature : Self-healing verification
// Role    : Utility
// API Doc : docs/implementation_plan.md, Error Parser
// ============================================================
const ESCAPE = String.fromCharCode(27);
const BELL = String.fromCharCode(7);
const ANSI_ESCAPE = new RegExp(
  ESCAPE + "(?:\\[[0-?]*[ -/]*[@-~]|\\][^" + BELL + "]*?(?:" + BELL + "|" + ESCAPE + "\\\\))",
  "g",
);
const TIMESTAMP_PREFIX = /^\s*(?:\[\d{4}-\d\d-\d\d[T ][^\]]+\]|\d{4}-\d\d-\d\d[T ][\d:.+-]+Z?\s+)/;
const STACK_FRAME = /^\s+at\s+.+(?:\([^)]*:\d+(?::\d+)?\)|:\d+(?::\d+)?)\s*$/;
const CONTROL_NOISE = new RegExp(
  `[${String.fromCharCode(0)}-${String.fromCharCode(8)}${String.fromCharCode(11)}${String.fromCharCode(12)}${String.fromCharCode(14)}-${String.fromCharCode(31)}${String.fromCharCode(127)}]`,
  "g",
);
const MAX_SUMMARY_LENGTH = 1800;

export function parseErrorSummary(output: string): string {
  const lines = output
    .replace(ANSI_ESCAPE, "")
    .replace(CONTROL_NOISE, "")
    .split(/\r?\n/)
    .map((line) => line.replace(TIMESTAMP_PREFIX, "").trimEnd())
    .filter((line) => line.trim() !== "" && !STACK_FRAME.test(line));
  const summary = lines.join("\n").trim();
  if (!summary) return "Command failed without output";
  if (summary.length <= MAX_SUMMARY_LENGTH) return summary;

  const firstLine = (lines[0] ?? "").slice(0, 300);
  const remaining = summary.slice(-MAX_SUMMARY_LENGTH + firstLine.length + 1);
  return `${firstLine}\n${remaining}`;
}
