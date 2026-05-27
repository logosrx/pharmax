// Unit tests for the proxy's defence-in-depth sign-up gate.
//
// The full `clerkMiddleware` wrapper is hard to drive in unit tests
// (it expects a Next runtime + Clerk's request context). We test the
// pure decision function (`shouldDenySignUpInMiddleware`) directly —
// it owns the only branching logic worth exercising. Coverage of
// `clerkMiddleware`'s auth side-effects lives in the e2e Playwright
// suite.
//
// Test data convention: synthetic identifiers only — no real
// patient or operator data, per .cursor/rules/02-security-compliance.

import { describe, expect, it } from "vitest";

import { shouldDenySignUpInMiddleware } from "./proxy.js";

describe("shouldDenySignUpInMiddleware", () => {
  it("passes through in development regardless of ticket or flag", () => {
    expect(
      shouldDenySignUpInMiddleware({
        nodeEnv: "development",
        signupsEnabledRaw: undefined,
        invitationTicket: null,
      })
    ).toBe(false);
    expect(
      shouldDenySignUpInMiddleware({
        nodeEnv: "development",
        signupsEnabledRaw: "false",
        invitationTicket: null,
      })
    ).toBe(false);
  });

  it("passes through in test regardless of ticket or flag", () => {
    expect(
      shouldDenySignUpInMiddleware({
        nodeEnv: "test",
        signupsEnabledRaw: undefined,
        invitationTicket: null,
      })
    ).toBe(false);
  });

  it("DENIES in production when ticket absent and flag unset (default-closed)", () => {
    expect(
      shouldDenySignUpInMiddleware({
        nodeEnv: "production",
        signupsEnabledRaw: undefined,
        invitationTicket: null,
      })
    ).toBe(true);
  });

  it("DENIES in production when ticket absent and flag is the empty string", () => {
    expect(
      shouldDenySignUpInMiddleware({
        nodeEnv: "production",
        signupsEnabledRaw: "",
        invitationTicket: null,
      })
    ).toBe(true);
  });

  it("DENIES in production when ticket is an empty string (treats as absent)", () => {
    expect(
      shouldDenySignUpInMiddleware({
        nodeEnv: "production",
        signupsEnabledRaw: undefined,
        invitationTicket: "",
      })
    ).toBe(true);
  });

  it("DENIES in production when the flag is the literal string 'false'", () => {
    // Critical guard: `z.coerce.boolean()` would treat any non-empty
    // string as true, including "false". The middleware must NOT
    // re-open the route on the same input.
    expect(
      shouldDenySignUpInMiddleware({
        nodeEnv: "production",
        signupsEnabledRaw: "false",
        invitationTicket: null,
      })
    ).toBe(true);
    expect(
      shouldDenySignUpInMiddleware({
        nodeEnv: "production",
        signupsEnabledRaw: "0",
        invitationTicket: null,
      })
    ).toBe(true);
  });

  it("PASSES in production with an invitation ticket regardless of the flag", () => {
    expect(
      shouldDenySignUpInMiddleware({
        nodeEnv: "production",
        signupsEnabledRaw: "false",
        invitationTicket: "tkt_invitation_jwt",
      })
    ).toBe(false);
  });

  it("PASSES in production when the flag is the literal string 'true'", () => {
    expect(
      shouldDenySignUpInMiddleware({
        nodeEnv: "production",
        signupsEnabledRaw: "true",
        invitationTicket: null,
      })
    ).toBe(false);
  });

  it("PASSES in production when the flag is '1' (alternate truthy form)", () => {
    expect(
      shouldDenySignUpInMiddleware({
        nodeEnv: "production",
        signupsEnabledRaw: "1",
        invitationTicket: null,
      })
    ).toBe(false);
  });

  it("normalizes case + whitespace on the flag (matches env schema preprocessor)", () => {
    expect(
      shouldDenySignUpInMiddleware({
        nodeEnv: "production",
        signupsEnabledRaw: "  TRUE  ",
        invitationTicket: null,
      })
    ).toBe(false);
    expect(
      shouldDenySignUpInMiddleware({
        nodeEnv: "production",
        signupsEnabledRaw: "True",
        invitationTicket: null,
      })
    ).toBe(false);
  });

  it("treats unrecognised flag values as closed (fail-safe)", () => {
    // A typo / unrecognised value falls through to the default — closed.
    expect(
      shouldDenySignUpInMiddleware({
        nodeEnv: "production",
        signupsEnabledRaw: "yes",
        invitationTicket: null,
      })
    ).toBe(true);
    expect(
      shouldDenySignUpInMiddleware({
        nodeEnv: "production",
        signupsEnabledRaw: "enable",
        invitationTicket: null,
      })
    ).toBe(true);
  });
});
