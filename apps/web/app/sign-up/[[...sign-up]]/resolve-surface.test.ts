// Unit tests for the sign-up surface resolver.

import { describe, expect, it } from "vitest";

import { resolveSignUpSurface, type SignUpSurface } from "./resolve-surface.js";

describe("resolveSignUpSurface", () => {
  it("opens the form in development regardless of ticket or flag", () => {
    expect(
      resolveSignUpSurface({
        nodeEnv: "development",
        signupsEnabled: false,
        invitationTicket: null,
      })
    ).toBe<SignUpSurface>("open");
    expect(
      resolveSignUpSurface({
        nodeEnv: "development",
        signupsEnabled: false,
        invitationTicket: "tkt_abc",
      })
    ).toBe<SignUpSurface>("open");
  });

  it("opens the form in test regardless of ticket or flag", () => {
    expect(
      resolveSignUpSurface({ nodeEnv: "test", signupsEnabled: false, invitationTicket: null })
    ).toBe<SignUpSurface>("open");
  });

  it("closes the form in production without a ticket and without the env flag", () => {
    expect(
      resolveSignUpSurface({
        nodeEnv: "production",
        signupsEnabled: false,
        invitationTicket: null,
      })
    ).toBe<SignUpSurface>("closed");
  });

  it("closes the form in production with an empty-string ticket (treats as absent)", () => {
    expect(
      resolveSignUpSurface({
        nodeEnv: "production",
        signupsEnabled: false,
        invitationTicket: "",
      })
    ).toBe<SignUpSurface>("closed");
  });

  it("opens the form in production WITH an invitation ticket even when the env flag is false", () => {
    expect(
      resolveSignUpSurface({
        nodeEnv: "production",
        signupsEnabled: false,
        invitationTicket: "tkt_abc",
      })
    ).toBe<SignUpSurface>("open");
  });

  it("opens the form in production when CLERK_SIGNUPS_ENABLED is true (no ticket required)", () => {
    expect(
      resolveSignUpSurface({
        nodeEnv: "production",
        signupsEnabled: true,
        invitationTicket: null,
      })
    ).toBe<SignUpSurface>("open");
  });
});
