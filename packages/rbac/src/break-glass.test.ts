// Break-glass policy tests.
//
// Break-glass is the most security-sensitive admin action: a
// time-limited grant that lets an actor perform something they're
// not normally permissioned for. We pin every policy rail:
//
//   - Default duration applies when caller omits.
//   - Duration must be > 0; non-finite is rejected.
//   - Duration cannot exceed BREAK_GLASS_MAX_MINUTES (4h).
//   - Reason MUST be in the registered enum.
//   - Self-grant is forbidden (two-admin rule).
//   - expiresAt = now + duration (with a stable Clock).
//   - The full happy-path helper calls the writer with the grant.

import { describe, expect, it, vi } from "vitest";

import { PERMISSIONS } from "./permissions.js";
import {
  BREAK_GLASS_DEFAULT_MINUTES,
  BREAK_GLASS_MAX_MINUTES,
  BREAK_GLASS_REASONS,
  BREAK_GLASS_VALIDATION,
  buildBreakGlassGrant,
  grantBreakGlass,
  type BreakGlassWriter,
} from "./break-glass.js";

const now = new Date("2026-01-01T00:00:00.000Z");

function baseInput() {
  return {
    id: "01JBG000000000000000000000",
    organizationId: "org-1",
    granteeUserId: "user-grantee",
    grantedByUserId: "user-admin",
    permission: PERMISSIONS.BILLING_MANAGE,
    reason: BREAK_GLASS_REASONS.PIC_COVERAGE,
    now,
  };
}

describe("buildBreakGlassGrant — happy paths", () => {
  it("defaults duration to BREAK_GLASS_DEFAULT_MINUTES", () => {
    const grant = buildBreakGlassGrant(baseInput());
    expect(grant.expiresAt.getTime() - now.getTime()).toBe(BREAK_GLASS_DEFAULT_MINUTES * 60_000);
  });

  it("uses explicit duration when within the cap", () => {
    const grant = buildBreakGlassGrant({ ...baseInput(), durationMinutes: 30 });
    expect(grant.expiresAt.getTime() - now.getTime()).toBe(30 * 60_000);
  });

  it("accepts a note", () => {
    const grant = buildBreakGlassGrant({ ...baseInput(), note: "Covering Saturday shift." });
    expect(grant.note).toBe("Covering Saturday shift.");
  });

  it("returns a grant with all input fields preserved", () => {
    const grant = buildBreakGlassGrant(baseInput());
    expect(grant).toMatchObject({
      id: "01JBG000000000000000000000",
      organizationId: "org-1",
      granteeUserId: "user-grantee",
      grantedByUserId: "user-admin",
      permission: PERMISSIONS.BILLING_MANAGE,
      reason: BREAK_GLASS_REASONS.PIC_COVERAGE,
    });
  });
});

describe("buildBreakGlassGrant — policy violations", () => {
  it("rejects 0-minute duration", () => {
    expect(() => buildBreakGlassGrant({ ...baseInput(), durationMinutes: 0 })).toThrowError(
      expect.objectContaining({ code: BREAK_GLASS_VALIDATION })
    );
  });

  it("rejects negative duration", () => {
    expect(() => buildBreakGlassGrant({ ...baseInput(), durationMinutes: -5 })).toThrowError(
      expect.objectContaining({ code: BREAK_GLASS_VALIDATION })
    );
  });

  it("rejects NaN / Infinity duration", () => {
    expect(() =>
      buildBreakGlassGrant({ ...baseInput(), durationMinutes: Number.NaN })
    ).toThrowError(expect.objectContaining({ code: BREAK_GLASS_VALIDATION }));
    expect(() =>
      buildBreakGlassGrant({ ...baseInput(), durationMinutes: Number.POSITIVE_INFINITY })
    ).toThrowError(expect.objectContaining({ code: BREAK_GLASS_VALIDATION }));
  });

  it("rejects duration exceeding the absolute maximum", () => {
    expect(() =>
      buildBreakGlassGrant({ ...baseInput(), durationMinutes: BREAK_GLASS_MAX_MINUTES + 1 })
    ).toThrowError(expect.objectContaining({ code: BREAK_GLASS_VALIDATION }));
  });

  it("accepts duration EXACTLY at the absolute maximum", () => {
    const grant = buildBreakGlassGrant({
      ...baseInput(),
      durationMinutes: BREAK_GLASS_MAX_MINUTES,
    });
    expect(grant.expiresAt.getTime() - now.getTime()).toBe(BREAK_GLASS_MAX_MINUTES * 60_000);
  });

  it("rejects an unregistered reason code", () => {
    expect(() =>
      buildBreakGlassGrant({ ...baseInput(), reason: "not.a.reason" as never })
    ).toThrowError(expect.objectContaining({ code: BREAK_GLASS_VALIDATION }));
  });

  it("rejects self-grant (two-admin rule)", () => {
    expect(() =>
      buildBreakGlassGrant({
        ...baseInput(),
        granteeUserId: "user-admin",
        grantedByUserId: "user-admin",
      })
    ).toThrowError(expect.objectContaining({ code: BREAK_GLASS_VALIDATION }));
  });

  it("rejection error metadata includes a structured issues field", () => {
    try {
      buildBreakGlassGrant({ ...baseInput(), durationMinutes: -1 });
      throw new Error("expected throw");
    } catch (e: unknown) {
      const err = e as { code: string; issues: ReadonlyArray<{ path: ReadonlyArray<string> }> };
      expect(err.code).toBe(BREAK_GLASS_VALIDATION);
      expect(err.issues[0]?.path).toEqual(["durationMinutes"]);
    }
  });
});

describe("grantBreakGlass — happy path helper", () => {
  it("validates then writes the grant", async () => {
    const writer: BreakGlassWriter = {
      recordGrant: vi.fn(async () => undefined),
      recordRevocation: vi.fn(async () => undefined),
    };
    const grant = await grantBreakGlass(writer, baseInput());
    expect(writer.recordGrant).toHaveBeenCalledTimes(1);
    expect(writer.recordGrant).toHaveBeenCalledWith(grant);
    expect(writer.recordRevocation).not.toHaveBeenCalled();
  });

  it("propagates validation errors WITHOUT calling the writer", async () => {
    const writer: BreakGlassWriter = {
      recordGrant: vi.fn(async () => undefined),
      recordRevocation: vi.fn(async () => undefined),
    };
    await expect(
      grantBreakGlass(writer, { ...baseInput(), durationMinutes: 10_000 })
    ).rejects.toMatchObject({ code: BREAK_GLASS_VALIDATION });
    expect(writer.recordGrant).not.toHaveBeenCalled();
  });
});

describe("BREAK_GLASS_REASONS", () => {
  it("is frozen and contains the mandatory codes", () => {
    expect(Object.isFrozen(BREAK_GLASS_REASONS)).toBe(true);
    expect(Object.values(BREAK_GLASS_REASONS)).toContain("pic.coverage");
    expect(Object.values(BREAK_GLASS_REASONS)).toContain("stuck-order.recovery");
    expect(Object.values(BREAK_GLASS_REASONS)).toContain("other");
  });
});
