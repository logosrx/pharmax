import { describe, expect, it } from "vitest";

import {
  DEFAULT_TRANSACTION_BUDGET,
  transactionBudgetFromEnv,
  transactionOptionsFor,
} from "./transaction-budget.js";

describe("DEFAULT_TRANSACTION_BUDGET", () => {
  // Pinned deliberately. Prisma's own defaults are timeout 5000 /
  // maxWait 2000, and this module reproduces them so that adopting an
  // explicit budget is a no-op for production timing. If someone
  // changes these numbers, that is a real behaviour change to every
  // command in the system and it should have to edit a test that says
  // so — see the module docblock on why raising the timeout also raises
  // the ceiling on row-lock hold time.
  it("restates Prisma's defaults so adopting a budget changes no timing", () => {
    expect(DEFAULT_TRANSACTION_BUDGET).toEqual({ timeoutMs: 5_000, maxWaitMs: 2_000 });
  });

  it("is frozen, so a caller cannot mutate the shared default", () => {
    expect(Object.isFrozen(DEFAULT_TRANSACTION_BUDGET)).toBe(true);
  });
});

describe("transactionOptionsFor", () => {
  it("maps a budget onto Prisma's option names", () => {
    expect(transactionOptionsFor({ timeoutMs: 1_234, maxWaitMs: 567 })).toEqual({
      timeout: 1_234,
      maxWait: 567,
    });
  });

  it("substitutes the default when no budget is configured", () => {
    expect(transactionOptionsFor(undefined)).toEqual({ timeout: 5_000, maxWait: 2_000 });
  });
});

describe("transactionBudgetFromEnv", () => {
  it("returns the default when neither variable is set", () => {
    expect(transactionBudgetFromEnv({})).toEqual(DEFAULT_TRANSACTION_BUDGET);
  });

  it("reads both variables", () => {
    expect(
      transactionBudgetFromEnv({
        COMMAND_TX_TIMEOUT_MS: "20000",
        COMMAND_TX_MAX_WAIT_MS: "8000",
      })
    ).toEqual({ timeoutMs: 20_000, maxWaitMs: 8_000 });
  });

  it("overrides each field independently", () => {
    expect(transactionBudgetFromEnv({ COMMAND_TX_TIMEOUT_MS: "9000" })).toEqual({
      timeoutMs: 9_000,
      maxWaitMs: DEFAULT_TRANSACTION_BUDGET.maxWaitMs,
    });
  });

  // A malformed budget is a configuration typo. Refusing to boot the
  // whole application over one would be a worse outcome than running on
  // a documented default, so every one of these falls back rather than
  // throwing.
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
    expect(transactionBudgetFromEnv({ COMMAND_TX_TIMEOUT_MS: raw }).timeoutMs).toBe(
      DEFAULT_TRANSACTION_BUDGET.timeoutMs
    );
  });

  it("ignores a malformed maxWait independently of a valid timeout", () => {
    expect(
      transactionBudgetFromEnv({
        COMMAND_TX_TIMEOUT_MS: "30000",
        COMMAND_TX_MAX_WAIT_MS: "nope",
      })
    ).toEqual({ timeoutMs: 30_000, maxWaitMs: DEFAULT_TRANSACTION_BUDGET.maxWaitMs });
  });
});
