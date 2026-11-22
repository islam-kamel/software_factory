// ============================================================
// test_retry_loop.ts
// Purpose : Verify bounded verification retries and hard failure stops
// Feature : Phase 2 self-healing
// Role    : Unit Test
// API Doc : docs/implementation_plan.md, Error Parser & Self-Healing Retry Loop
// ============================================================
import { expect, it } from "vitest";
import type { VerificationResult } from "@/engine/contracts";
import { runVerificationLoop } from "@/self_healing/retry_loop";

function failed(attempt: number, failed_step: string, summary = "lint failed"): VerificationResult {
  return { passed: false, attempt, failed_step, summary };
}

function passed(attempt: number): VerificationResult {
  return { passed: true, attempt, failed_step: null, summary: "passed" };
}

it("returns a first passing result without requesting repair", async () => {
  const attempts: number[] = [];
  let repairs = 0;
  const firstPass = passed(1);

  const result = await runVerificationLoop({
    verify: async (attempt) => {
      attempts.push(attempt);
      return firstPass;
    },
    repair: async () => {
      repairs += 1;
    },
  });

  expect(result).toBe(firstPass);
  expect(attempts).toEqual([1]);
  expect(repairs).toBe(0);
});

it("bounds repair context and succeeds on the next verification", async () => {
  const first = failed(
    1,
    "lint",
    "[2026-11-22T10:20:30Z] \u001B[31mFAIL lint\u001B[0m\n    at noisyFrame (test.ts:1:1)",
  );
  const attempts: number[] = [];
  const repairs: VerificationResult[] = [];

  const result = await runVerificationLoop({
    verify: async (attempt) => {
      attempts.push(attempt);
      return attempt === 1 ? first : passed(attempt);
    },
    repair: async (failure) => {
      repairs.push(failure);
    },
  });

  expect(result).toEqual(passed(2));
  expect(attempts).toEqual([1, 2]);
  expect(repairs).toEqual([{ ...first, summary: "FAIL lint" }]);
  expect(repairs[0]).not.toBe(first);
  expect(first.summary).toContain("\u001B[31m");
});

it("stops after three total attempts and performs only two repairs", async () => {
  const attempts: number[] = [];
  const repairs: VerificationResult[] = [];
  const finalFailure = failed(3, "test", "test still fails");

  const result = await runVerificationLoop({
    verify: async (attempt) => {
      attempts.push(attempt);
      return attempt === 3 ? finalFailure : failed(attempt, "test", "retry");
    },
    repair: async (failure) => {
      repairs.push(failure);
    },
  });

  expect(result).toBe(finalFailure);
  expect(attempts).toEqual([1, 2, 3]);
  expect(repairs).toHaveLength(2);
});

it("bounds oversized summaries before passing them to repair", async () => {
  const failure = failed(1, "lint", "FAIL lint\n" + "detail line\n".repeat(250));
  const repairs: VerificationResult[] = [];

  await runVerificationLoop({
    verify: async (attempt) => (attempt === 1 ? failure : passed(attempt)),
    repair: async (diagnostic) => {
      repairs.push(diagnostic);
    },
  });

  expect(failure.summary.length).toBeGreaterThan(1800);
  expect(repairs[0]?.summary.startsWith("FAIL lint\n")).toBe(true);
  expect(repairs[0]?.summary.length).toBeLessThanOrEqual(1800);
});

it.each(["configuration", "secret_scan", "protected_files", "logging"])(
  "does not send %s failures to Builder repair",
  async (step) => {
    const failure = failed(1, step);
    let repairs = 0;

    const result = await runVerificationLoop({
      verify: async () => failure,
      repair: async () => {
        repairs += 1;
      },
    });

    expect(result).toBe(failure);
    expect(repairs).toBe(0);
  },
);

it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
  "rejects invalid attempt limits before running callbacks (%s)",
  async (maxAttempts) => {
    let calls = 0;

    await expect(
      runVerificationLoop({
        maxAttempts,
        verify: async () => {
          calls += 1;
          return passed(1);
        },
        repair: async () => undefined,
      }),
    ).rejects.toThrow(/maxAttempts/i);
    expect(calls).toBe(0);
  },
);

it("rejects a verifier that reports an attempt different from the requested one", async () => {
  await expect(
    runVerificationLoop({
      verify: async () => passed(2),
      repair: async () => undefined,
    }),
  ).rejects.toThrow(/attempt/i);
});

it("honors a valid configured total-attempt override", async () => {
  const attempts: number[] = [];
  let repairs = 0;

  await runVerificationLoop({
    maxAttempts: 4,
    verify: async (attempt) => {
      attempts.push(attempt);
      return failed(attempt, "lint");
    },
    repair: async () => {
      repairs += 1;
    },
  });

  expect(attempts).toEqual([1, 2, 3, 4]);
  expect(repairs).toBe(3);
});

it("propagates verifier and repair errors without hiding them", async () => {
  const verifyError = new Error("verification failed to start");
  await expect(
    runVerificationLoop({
      verify: async () => {
        throw verifyError;
      },
      repair: async () => undefined,
    }),
  ).rejects.toBe(verifyError);

  const repairError = new Error("builder failed");
  await expect(
    runVerificationLoop({
      verify: async () => failed(1, "lint"),
      repair: async () => {
        throw repairError;
      },
    }),
  ).rejects.toBe(repairError);
});
