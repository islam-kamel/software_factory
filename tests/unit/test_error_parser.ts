// ============================================================
// test_error_parser.ts
// Purpose : Verify actionable command failure summaries
// Feature : Self-healing verification
// Role    : Unit Tests
// API Doc : docs/implementation_plan.md, Error Parser
// ============================================================
import { expect, it } from "vitest";
import { parseErrorSummary } from "@/self_healing/error_parser";

it("removes timestamps, ANSI color and stack frames while preserving diagnostics", () => {
  const output =
    "[2026-11-22T10:20:30Z] \u001B[31mFAIL tests/signup.test.ts > rejects duplicate email\u001B[0m\n" +
    "    at runTest (C:\\repo\\tests\\signup.test.ts:12:4)\n" +
    "Error: expected 400, received 500";

  expect(parseErrorSummary(output)).toBe(
    "FAIL tests/signup.test.ts > rejects duplicate email\nError: expected 400, received 500",
  );
});

it("returns a useful message for empty or control-only output", () => {
  expect(parseErrorSummary("\u001B[31m\u001B[0m\u0000 \n")).toBe("Command failed without output");
});

it("removes OSC hyperlinks terminated by ESC backslash and keeps Windows diagnostics", () => {
  const hyperlink = "\u001B]8;;https://example.test\u001B\\linked failure\u001B]8;;\u001B\\";
  const diagnostic = "C:\\repo\\src\\task.ts(17,2): error TS2304: Cannot find name 'task'";

  expect(parseErrorSummary(hyperlink)).toBe("linked failure");
  expect(parseErrorSummary(diagnostic)).toBe(diagnostic);
});

it("preserves the first diagnostic and stays within the verifier summary limit", () => {
  const summary = parseErrorSummary(`FAIL tests/a.test.ts\n${"detail line\n".repeat(250)}`);

  expect(summary.startsWith("FAIL tests/a.test.ts\n")).toBe(true);
  expect(summary.length).toBeLessThanOrEqual(1800);
});
