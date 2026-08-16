// Burst gate for the public credential-setting entry points.
//
// These tests pin the three properties that make the gate safe rather
// than merely present: it decides from the client IP ALONE (nothing that
// requires resolving the token), it decides BEFORE the dispatch that
// would bill a breach-corpus lookup, and it shares one budget across
// every entry point that drives that corpus.
//
// The end-to-end behaviour through the real command path — threshold,
// indistinguishability from an ordinary refusal, a first-time invite
// still succeeding — lives in commands/accept-invite.test.ts, which has
// the fake database to run it against.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { COMMAND_BUS_NOT_CONFIGURED } from "@pharmax/command-bus";
import { clock } from "@pharmax/platform-core";

import {
  buildAuthConfiguration,
  configureAuth,
  DEFAULT_CREDENTIAL_SETUP_RATE_LIMIT,
  resetAuthConfigurationForTests,
} from "./configure.js";
import { guardCredentialSetupBurst } from "./credential-setup-limit.js";
import { acceptInvite } from "./invite.js";
import type { PasswordHasher } from "./password/hasher.js";
import type { RateLimiter, RateLimitRule } from "./rate-limit.js";
import { resetPassword } from "./reset-password.js";

const NOW = new Date("2026-07-13T12:00:00.000Z");

// Synthetic credential material — no real operator, no PHI.
const RAW_TOKEN = "synthetic-setup-token";
const NEW_PASSWORD = "first-secret-phrase-6";
const IP_A = "198.51.100.7";
const IP_B = "203.0.113.9";

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

/** Records every (key, rule) pair so the KEYING can be asserted. */
function recordingLimiter(allow = true): {
  readonly limiter: RateLimiter;
  readonly calls: Array<{ key: string; rule: RateLimitRule }>;
} {
  const calls: Array<{ key: string; rule: RateLimitRule }> = [];
  return {
    calls,
    limiter: {
      async hit(key, rule) {
        calls.push({ key, rule });
        return allow
          ? { allowed: true, retryAfterMs: 0 }
          : { allowed: false, retryAfterMs: rule.windowMs };
      },
    },
  };
}

function configure(rateLimiter: RateLimiter, limit?: number): void {
  configureAuth(
    buildAuthConfiguration({
      clock: clock.createFrozenClock(NOW),
      hasher: fakeHasher,
      rateLimiter,
      ...(limit === undefined
        ? {}
        : { credentialSetupRateLimit: { perIp: { limit, windowMs: 60_000 } } }),
    })
  );
}

/** `code` of whatever a call rejected with, or a marker when it did not. */
async function rejectionCode(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (cause) {
    return (cause as { code?: string }).code ?? "<no code>";
  }
  return "<did not reject>";
}

beforeEach(() => {
  configure(recordingLimiter().limiter);
});
afterEach(() => {
  resetAuthConfigurationForTests();
});

describe("credential-setup burst gate — keying", () => {
  it("keys on the client IP and nothing that requires resolving the token", async () => {
    const { limiter, calls } = recordingLimiter();
    configure(limiter);

    await guardCredentialSetupBurst({ ipAddress: IP_A });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.key).toBe(`credential-setup:ip:${IP_A}`);
    // The key must not carry the token, a hash of it, or an account id:
    // any of those would have to be resolved first, and the decision
    // would then differ between a real token and a forged one — the
    // existence oracle the shared opaque refusal exists to deny.
    expect(calls[0]!.key).not.toContain(RAW_TOKEN);
  });

  it("uses one shared bucket for the invite and reset entry points", async () => {
    const { limiter, calls } = recordingLimiter();
    configure(limiter);

    // Neither call reaches a command (no bus is configured), which is
    // itself the point of the assertion below: the gate ran first.
    await rejectionCode(() =>
      acceptInvite({ rawToken: RAW_TOKEN, newPassword: NEW_PASSWORD, ipAddress: IP_A })
    );
    await rejectionCode(() =>
      resetPassword({ rawToken: RAW_TOKEN, newPassword: NEW_PASSWORD, ipAddress: IP_A })
    );

    // Separate buckets would just mean an attacker who exhausted one
    // entry point moved to the other for a fresh corpus-lookup budget.
    expect(calls.map((c) => c.key)).toEqual([
      `credential-setup:ip:${IP_A}`,
      `credential-setup:ip:${IP_A}`,
    ]);
  });

  it("gives each IP its own bucket", async () => {
    const { limiter, calls } = recordingLimiter();
    configure(limiter);

    await guardCredentialSetupBurst({ ipAddress: IP_A });
    await guardCredentialSetupBurst({ ipAddress: IP_B });

    expect(new Set(calls.map((c) => c.key)).size).toBe(2);
  });

  it("collapses a missing IP into one shared bucket rather than skipping the limit", async () => {
    const { limiter, calls } = recordingLimiter();
    configure(limiter);

    await guardCredentialSetupBurst({});
    await guardCredentialSetupBurst({ ipAddress: undefined });

    // Absent must limit MORE, never less: an unlimited path for requests
    // that arrive without the header would be the whole gate's bypass.
    expect(calls.map((c) => c.key)).toEqual([
      "credential-setup:ip:unknown",
      "credential-setup:ip:unknown",
    ]);
  });

  it("passes the configured rule through instead of a hard-coded one", async () => {
    const { limiter, calls } = recordingLimiter();
    configure(limiter, 3);

    await guardCredentialSetupBurst({ ipAddress: IP_A });

    expect(calls[0]!.rule).toEqual({ limit: 3, windowMs: 60_000 });
  });

  it("defaults to the sign-in per-IP allowance, not the tighter portal rule", () => {
    // A clinic behind one NAT gateway onboards a whole shift from a
    // single address, and a refusal here reads as "your link is broken".
    // Pinned so a future tightening is a deliberate, reviewed edit.
    expect(DEFAULT_CREDENTIAL_SETUP_RATE_LIMIT.perIp).toEqual({ limit: 20, windowMs: 60_000 });
  });
});

describe("credential-setup burst gate — ordering", () => {
  it("refuses before the dispatch that would bill a corpus lookup", async () => {
    const isBreached = vi.fn(async () => false);
    configureAuth(
      buildAuthConfiguration({
        clock: clock.createFrozenClock(NOW),
        hasher: fakeHasher,
        rateLimiter: recordingLimiter(false).limiter,
        password: { breachChecker: { isBreached } },
      })
    );

    const code = await rejectionCode(() =>
      acceptInvite({ rawToken: RAW_TOKEN, newPassword: NEW_PASSWORD, ipAddress: IP_A })
    );

    // The refusal is the token error, so the caller learns nothing...
    expect(code).toBe("RESET_TOKEN_INVALID");
    // ...and the corpus was never consulted, which is the amplification
    // R-026 records. A gate placed after `withScreenedPassword` would
    // still return this error and still bill the lookup.
    expect(isBreached).not.toHaveBeenCalled();
  });

  it("lets an allowed request through to the dispatch", async () => {
    const isBreached = vi.fn(async () => false);
    configureAuth(
      buildAuthConfiguration({
        clock: clock.createFrozenClock(NOW),
        hasher: fakeHasher,
        rateLimiter: recordingLimiter(true).limiter,
        password: { breachChecker: { isBreached } },
      })
    );

    const code = await rejectionCode(() =>
      acceptInvite({ rawToken: RAW_TOKEN, newPassword: NEW_PASSWORD, ipAddress: IP_A })
    );

    // No command bus is configured in this file, so getting as far as
    // the bus is how "the gate allowed it" is observed. Distinct from
    // RESET_TOKEN_INVALID, which is what makes the refusal test above
    // mean something rather than passing on any thrown error.
    expect(code).toBe(COMMAND_BUS_NOT_CONFIGURED);
    expect(isBreached).toHaveBeenCalledTimes(1);
  });
});
