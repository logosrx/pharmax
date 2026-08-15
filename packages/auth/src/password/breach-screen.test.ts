// Pre-transaction breach screen — frame semantics.
//
// The command handlers depend on three properties of this module, and
// each one is a security property rather than a convenience:
//
//   1. The screen runs to completion BEFORE `fn` starts, so a command
//      dispatched inside the frame never makes the third-party call
//      itself (and therefore never makes it with a transaction open).
//   2. A missing frame is a hard failure, not an implicit pass.
//   3. A frame is evidence about ONE password and cannot be reused to
//      vouch for another.
//
// All passwords below are synthetic.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { clock, type logger } from "@pharmax/platform-core";

import {
  buildAuthConfiguration,
  configureAuth,
  resetAuthConfigurationForTests,
} from "../configure.js";
import {
  getBreachScreen,
  isBreachScreenBypassed,
  logBreachScreenBypass,
  requireBreachScreen,
  withScreenedPassword,
  type BreachScreen,
} from "./breach-screen.js";
import type { PasswordHasher } from "./hasher.js";
import type { BreachChecker } from "./policy.js";

const PASSWORD = "a-unique-strong-passphrase";
const OTHER_PASSWORD = "a-different-strong-passphrase";

const fakeHasher: PasswordHasher = {
  async hash(p) {
    return `h:${p}`;
  },
  async verify(h, p) {
    return h === `h:${p}`;
  },
  needsRehash() {
    return false;
  },
};

function configure(checker?: BreachChecker, timeoutMs?: number): void {
  configureAuth(
    buildAuthConfiguration({
      clock: clock.createFrozenClock(new Date("2026-07-13T12:00:00.000Z")),
      hasher: fakeHasher,
      password: {
        ...(checker === undefined ? {} : { breachChecker: checker }),
        ...(timeoutMs === undefined ? {} : { breachCheckTimeoutMs: timeoutMs }),
      },
    })
  );
}

beforeEach(() => {
  configure();
});
afterEach(() => {
  resetAuthConfigurationForTests();
});

describe("withScreenedPassword", () => {
  it("completes the screen before the wrapped work starts", async () => {
    const order: string[] = [];
    configure({
      isBreached: async () => {
        order.push("screen");
        return false;
      },
    });

    await withScreenedPassword(PASSWORD, () => {
      order.push("work");
    });

    // The whole point: by the time the command runs, the network call
    // is already done. Reverse this and the call lands inside the
    // command's transaction again.
    expect(order).toEqual(["screen", "work"]);
  });

  it("exposes a real verdict to the wrapped work", async () => {
    configure({ isBreached: async () => true });

    const screen = await withScreenedPassword(PASSWORD, () => requireBreachScreen(PASSWORD));

    expect(screen.outcome).toBe("checked");
    expect(screen.violations.join(" ")).toContain("data breach");
    expect(isBreachScreenBypassed(screen)).toBe(false);
  });

  it("does not reject a breached password itself", async () => {
    configure({ isBreached: async () => true });

    // Rejecting out here would abort before the command ever runs,
    // which means no command_log row and no audited evidence of the
    // attempt. The command owns the refusal.
    await expect(withScreenedPassword(PASSWORD, () => "ran")).resolves.toBe("ran");
  });

  it("marks a thrown checker as a bypass and lets the work proceed", async () => {
    configure({ isBreached: () => Promise.reject(new Error("corpus down")) });

    const screen = await withScreenedPassword(PASSWORD, () => requireBreachScreen(PASSWORD));

    expect(screen.outcome).toBe("bypassed_error");
    expect(screen.violations).toHaveLength(0);
    expect(isBreachScreenBypassed(screen)).toBe(true);
  });

  it("marks a hung checker as a timeout bypass", async () => {
    configure({ isBreached: () => new Promise<boolean>(() => undefined) }, 20);

    const screen = await withScreenedPassword(PASSWORD, () => requireBreachScreen(PASSWORD));

    expect(screen.outcome).toBe("bypassed_timeout");
    expect(isBreachScreenBypassed(screen)).toBe(true);
  });

  it("does not leak the frame outside its own async scope", async () => {
    await withScreenedPassword(PASSWORD, () => {
      expect(getBreachScreen()).not.toBeNull();
    });
    expect(getBreachScreen()).toBeNull();
  });
});

describe("requireBreachScreen", () => {
  it("throws when no screen frame is active", () => {
    // Fails CLOSED. Treating "no evidence" as "not breached" is how the
    // control disappears from a path without anyone noticing.
    expect(() => requireBreachScreen(PASSWORD)).toThrowError(
      expect.objectContaining({ code: "PASSWORD_BREACH_SCREEN_MISSING" }) as Error
    );
  });

  it("throws when the active screen judged a different password", async () => {
    await withScreenedPassword(OTHER_PASSWORD, () => {
      expect(() => requireBreachScreen(PASSWORD)).toThrowError(
        expect.objectContaining({ code: "PASSWORD_BREACH_SCREEN_MISSING" }) as Error
      );
    });
  });

  it("keeps the plaintext out of the failure it raises", async () => {
    await withScreenedPassword(OTHER_PASSWORD, () => {
      const raised = ((): unknown => {
        try {
          return requireBreachScreen(PASSWORD);
        } catch (cause) {
          return cause;
        }
      })();

      // This error is logged and serialized by the bus like any other.
      expect(JSON.stringify(raised)).not.toContain(PASSWORD);
      expect(JSON.stringify(raised)).not.toContain(OTHER_PASSWORD);
    });
  });
});

describe("logBreachScreenBypass", () => {
  function capturingLogger(): { log: logger.Logger; warns: Array<[string, unknown]> } {
    const warns: Array<[string, unknown]> = [];
    const log: logger.Logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: (message, context) => {
        warns.push([message, context]);
      },
      error: vi.fn(),
      child: () => log,
    };
    return { log, warns };
  }

  const screenWith = (outcome: BreachScreen["outcome"]): BreachScreen => ({
    plaintext: PASSWORD,
    outcome,
    violations: [],
  });

  it("warns once, with the outcome, when the corpus was bypassed", () => {
    const { log, warns } = capturingLogger();

    logBreachScreenBypass(log, screenWith("bypassed_timeout"), { userId: "user-1" });

    expect(warns).toHaveLength(1);
    expect(warns[0]![1]).toMatchObject({ breachScreen: "bypassed_timeout", userId: "user-1" });
  });

  it("never puts the password in the log context", () => {
    const { log, warns } = capturingLogger();

    logBreachScreenBypass(log, screenWith("bypassed_error"), { userId: "user-1" });

    expect(JSON.stringify(warns)).not.toContain(PASSWORD);
  });

  it("stays silent when the corpus actually answered", () => {
    const { log, warns } = capturingLogger();

    logBreachScreenBypass(log, screenWith("checked"), { userId: "user-1" });
    logBreachScreenBypass(log, screenWith("not_configured"), { userId: "user-1" });

    // A deployment with no checker wired must not warn on every password
    // change — the audit metadata already records the difference.
    expect(warns).toHaveLength(0);
  });
});
