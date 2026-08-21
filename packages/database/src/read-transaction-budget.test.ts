import { describe, expect, it } from "vitest";

import {
  DEFAULT_READ_TRANSACTION_BUDGET,
  readTransactionBudgetFromEnv,
  readTransactionOptionsFor,
} from "./read-transaction-budget.js";

describe("DEFAULT_READ_TRANSACTION_BUDGET", () => {
  it("reproduces Prisma's defaults, so adopting the module changes no production timing", () => {
    // If this ever diverges, it must be in a commit that can point at a
    // measurement — see the module docblock.
    expect(DEFAULT_READ_TRANSACTION_BUDGET).toEqual({ timeoutMs: 5_000, maxWaitMs: 2_000 });
  });
});

describe("readTransactionOptionsFor", () => {
  it("maps onto Prisma's option names", () => {
    expect(readTransactionOptionsFor({ timeoutMs: 60_000, maxWaitMs: 20_000 })).toEqual({
      timeout: 60_000,
      maxWait: 20_000,
    });
  });
});

describe("readTransactionBudgetFromEnv", () => {
  it("falls back to the default when nothing is set", () => {
    expect(readTransactionBudgetFromEnv({})).toEqual(DEFAULT_READ_TRANSACTION_BUDGET);
  });

  it("reads both variables", () => {
    expect(
      readTransactionBudgetFromEnv({
        READ_TX_TIMEOUT_MS: "60000",
        READ_TX_MAX_WAIT_MS: "20000",
      })
    ).toEqual({ timeoutMs: 60_000, maxWaitMs: 20_000 });
  });

  it("overrides each field independently", () => {
    expect(readTransactionBudgetFromEnv({ READ_TX_TIMEOUT_MS: "9000" })).toEqual({
      timeoutMs: 9_000,
      maxWaitMs: DEFAULT_READ_TRANSACTION_BUDGET.maxWaitMs,
    });
  });

  it("does not read the COMMAND variables", () => {
    // The whole point of a separate pair: a read scope takes no row
    // locks, so it must not inherit the command bound. Reading the
    // command variables here would also have hidden the original bug,
    // because the E2E harness sets those.
    expect(
      readTransactionBudgetFromEnv({
        COMMAND_TX_TIMEOUT_MS: "60000",
        COMMAND_TX_MAX_WAIT_MS: "20000",
      })
    ).toEqual(DEFAULT_READ_TRANSACTION_BUDGET);
  });

  // A malformed budget is a configuration typo. Refusing to boot over
  // one would be worse than running on a documented default.
  it.each([
    ["empty", ""],
    ["whitespace", "   "],
    ["not a number", "soon"],
    ["zero", "0"],
    ["negative", "-1"],
    ["fractional", "1500.5"],
    ["not finite", "Infinity"],
    ["beyond safe integer", "9007199254740993"],
  ])("ignores a %s timeout and keeps the default", (_label, raw) => {
    expect(readTransactionBudgetFromEnv({ READ_TX_TIMEOUT_MS: raw }).timeoutMs).toBe(
      DEFAULT_READ_TRANSACTION_BUDGET.timeoutMs
    );
  });

  it("ignores a malformed maxWait independently of a valid timeout", () => {
    expect(
      readTransactionBudgetFromEnv({
        READ_TX_TIMEOUT_MS: "30000",
        READ_TX_MAX_WAIT_MS: "nope",
      })
    ).toEqual({ timeoutMs: 30_000, maxWaitMs: DEFAULT_READ_TRANSACTION_BUDGET.maxWaitMs });
  });
});
