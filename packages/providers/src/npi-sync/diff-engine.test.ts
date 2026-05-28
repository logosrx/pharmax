// Contract tests for the NPI sync diff engine.
//
// Pure-function tests — no Prisma fakes, no HTTP fixtures, no clock.
// Every branch of the discriminated `SyncAction` union is covered
// plus the precedence ordering between branches and the
// normalization edge cases (whitespace, state-code case, null
// vs empty-string).

import { ProviderStatus } from "@pharmax/database";
import { describe, expect, it } from "vitest";

import {
  buildSyncDeactivationReasonText,
  diffProviderAgainstCms,
  type CmsAddress,
  type CmsNpiSnapshot,
  type LocalProviderSnapshot,
} from "./diff-engine.js";

// ---------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------

const FIXED_CMS_TS = new Date("2026-05-15T12:34:56.000Z");

function makeLocal(overrides: Partial<LocalProviderSnapshot> = {}): LocalProviderSnapshot {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    organizationId: "00000000-0000-0000-0000-0000000000aa",
    npi: "1234567890",
    status: ProviderStatus.ACTIVE,
    firstName: "Jordan",
    lastName: "Rivera",
    credential: "MD",
    addressLine1: "1200 Maple St",
    addressLine2: "Suite 4",
    city: "Springfield",
    state: "IL",
    postalCode: "62701",
    phone: "217-555-0142",
    ...overrides,
  };
}

function makeCmsAddress(overrides: Partial<CmsAddress> = {}): CmsAddress {
  return {
    line1: "1200 Maple St",
    line2: "Suite 4",
    city: "Springfield",
    stateCode: "IL",
    postalCode: "62701",
    phone: "217-555-0142",
    ...overrides,
  };
}

function makeCms(overrides: Partial<CmsNpiSnapshot> = {}): CmsNpiSnapshot {
  return {
    npi: "1234567890",
    enumerationType: "NPI-1",
    status: "A",
    firstName: "Jordan",
    lastName: "Rivera",
    credential: "MD",
    practiceAddress: makeCmsAddress(),
    lastUpdatedAtCms: FIXED_CMS_TS,
    ...overrides,
  };
}

// ---------------------------------------------------------------------
// NOT_FOUND_AT_CMS
// ---------------------------------------------------------------------

describe("diffProviderAgainstCms — NOT_FOUND_AT_CMS", () => {
  it("returns NOT_FOUND_AT_CMS when cms is null, regardless of local row state", () => {
    expect(diffProviderAgainstCms(makeLocal(), null)).toEqual({
      kind: "NOT_FOUND_AT_CMS",
    });
  });

  it("NOT_FOUND_AT_CMS wins over local INACTIVE status", () => {
    expect(diffProviderAgainstCms(makeLocal({ status: ProviderStatus.INACTIVE }), null)).toEqual({
      kind: "NOT_FOUND_AT_CMS",
    });
  });
});

// ---------------------------------------------------------------------
// ENUMERATION_TYPE_MISMATCH
// ---------------------------------------------------------------------

describe("diffProviderAgainstCms — ENUMERATION_TYPE_MISMATCH", () => {
  it("returns ENUMERATION_TYPE_MISMATCH when CMS reports NPI-2 (organization)", () => {
    expect(
      diffProviderAgainstCms(
        makeLocal(),
        makeCms({ enumerationType: "NPI-2", firstName: null, lastName: null })
      )
    ).toEqual({
      kind: "ENUMERATION_TYPE_MISMATCH",
      cmsType: "NPI-2",
      expected: "NPI-1",
    });
  });

  it("ENUMERATION_TYPE_MISMATCH wins over a CMS deactivated status", () => {
    expect(
      diffProviderAgainstCms(
        makeLocal(),
        makeCms({
          enumerationType: "NPI-2",
          status: "D",
          firstName: null,
          lastName: null,
        })
      ).kind
    ).toBe("ENUMERATION_TYPE_MISMATCH");
  });

  it("ENUMERATION_TYPE_MISMATCH wins over local INACTIVE (operator-error precedence)", () => {
    expect(
      diffProviderAgainstCms(
        makeLocal({ status: ProviderStatus.INACTIVE }),
        makeCms({ enumerationType: "NPI-2", firstName: null, lastName: null })
      ).kind
    ).toBe("ENUMERATION_TYPE_MISMATCH");
  });
});

// ---------------------------------------------------------------------
// DEACTIVATE
// ---------------------------------------------------------------------

describe("diffProviderAgainstCms — DEACTIVATE", () => {
  it("returns DEACTIVATE when CMS reports D and local is ACTIVE", () => {
    const action = diffProviderAgainstCms(makeLocal(), makeCms({ status: "D" }));
    expect(action.kind).toBe("DEACTIVATE");
    if (action.kind !== "DEACTIVATE") return;
    expect(action.reason).toBe("LICENSE_EXPIRED");
    expect(action.reasonText).toBe("NPPES status: D (CMS updated 2026-05-15T12:34:56.000Z)");
  });

  it("reasonText format is stable and includes the CMS timestamp", () => {
    const ts = new Date("2024-01-02T03:04:05.000Z");
    const action = diffProviderAgainstCms(
      makeLocal(),
      makeCms({ status: "D", lastUpdatedAtCms: ts })
    );
    if (action.kind !== "DEACTIVATE") throw new Error("expected DEACTIVATE");
    expect(action.reasonText).toBe("NPPES status: D (CMS updated 2024-01-02T03:04:05.000Z)");
  });

  it("DEACTIVATE wins over field drift (no point updating an inactive provider)", () => {
    const action = diffProviderAgainstCms(
      makeLocal(),
      makeCms({
        status: "D",
        firstName: "JordanCHANGED",
        practiceAddress: makeCmsAddress({ line1: "999 New Address Blvd" }),
      })
    );
    expect(action.kind).toBe("DEACTIVATE");
  });

  it("default deactivation reason is the conservative LICENSE_EXPIRED, NOT DEA_*", () => {
    const action = diffProviderAgainstCms(makeLocal(), makeCms({ status: "D" }));
    if (action.kind !== "DEACTIVATE") throw new Error("expected DEACTIVATE");
    expect(action.reason).toBe("LICENSE_EXPIRED");
    expect(action.reason).not.toBe("DEA_SURRENDERED_OR_REVOKED");
  });
});

// ---------------------------------------------------------------------
// REACTIVATION_CANDIDATE
// ---------------------------------------------------------------------

describe("diffProviderAgainstCms — REACTIVATION_CANDIDATE", () => {
  it("returns REACTIVATION_CANDIDATE when CMS is active and local is INACTIVE", () => {
    expect(
      diffProviderAgainstCms(makeLocal({ status: ProviderStatus.INACTIVE }), makeCms())
    ).toEqual({ kind: "REACTIVATION_CANDIDATE" });
  });

  it("REACTIVATION_CANDIDATE does NOT include any auto-reactivation reason or text", () => {
    const action = diffProviderAgainstCms(
      makeLocal({ status: ProviderStatus.INACTIVE }),
      makeCms()
    );
    // The discriminant carries NO reason — reactivation is always
    // an operator decision, not a worker decision. The full object
    // shape is exactly `{ kind: "REACTIVATION_CANDIDATE" }` with no
    // other keys.
    expect(Object.keys(action)).toEqual(["kind"]);
  });

  it("REACTIVATION_CANDIDATE wins over field drift", () => {
    const action = diffProviderAgainstCms(
      makeLocal({
        status: ProviderStatus.INACTIVE,
        firstName: "Stale",
        lastName: "Stale",
      }),
      makeCms({ firstName: "Jordan", lastName: "Rivera" })
    );
    expect(action.kind).toBe("REACTIVATION_CANDIDATE");
  });
});

// ---------------------------------------------------------------------
// NONE — both sides agree
// ---------------------------------------------------------------------

describe("diffProviderAgainstCms — NONE", () => {
  it("returns NONE/no_diff when both active and no field drift", () => {
    expect(diffProviderAgainstCms(makeLocal(), makeCms())).toEqual({
      kind: "NONE",
      reason: "no_diff",
    });
  });

  it("returns NONE/both_inactive when CMS D and local INACTIVE", () => {
    expect(
      diffProviderAgainstCms(
        makeLocal({ status: ProviderStatus.INACTIVE }),
        makeCms({ status: "D" })
      )
    ).toEqual({ kind: "NONE", reason: "both_inactive" });
  });

  it("NONE/both_inactive does not emit any field-drift action even if fields differ", () => {
    // Both inactive — engine doesn't bother diffing fields because
    // no UPDATE would fire anyway (UpdateProvider refuses INACTIVE
    // rows). Tested explicitly so the short-circuit semantics are
    // pinned.
    const action = diffProviderAgainstCms(
      makeLocal({
        status: ProviderStatus.INACTIVE,
        firstName: "Stale",
        addressLine1: "Stale Address",
      }),
      makeCms({
        status: "D",
        firstName: "Jordan",
        practiceAddress: makeCmsAddress({ line1: "1200 Maple St" }),
      })
    );
    expect(action).toEqual({ kind: "NONE", reason: "both_inactive" });
  });
});

// ---------------------------------------------------------------------
// UPDATE — field drift
// ---------------------------------------------------------------------

describe("diffProviderAgainstCms — UPDATE/name drift", () => {
  it("emits UPDATE.changes.firstName when CMS first name differs", () => {
    const action = diffProviderAgainstCms(
      makeLocal({ firstName: "Jordan" }),
      makeCms({ firstName: "Jordon" })
    );
    expect(action).toEqual({
      kind: "UPDATE",
      changes: { firstName: "Jordon" },
    });
  });

  it("emits UPDATE.changes.lastName when CMS last name differs", () => {
    const action = diffProviderAgainstCms(
      makeLocal({ lastName: "Rivera" }),
      makeCms({ lastName: "Riviera" })
    );
    expect(action).toEqual({
      kind: "UPDATE",
      changes: { lastName: "Riviera" },
    });
  });

  it("treats whitespace-only CMS name diff as no-op (does NOT emit UPDATE)", () => {
    expect(
      diffProviderAgainstCms(
        makeLocal({ firstName: "Jordan" }),
        makeCms({ firstName: "  Jordan  " })
      )
    ).toEqual({ kind: "NONE", reason: "no_diff" });
  });

  it("ignores CMS name when null (defensive against malformed NPI-1 records)", () => {
    expect(
      diffProviderAgainstCms(makeLocal({ firstName: "Jordan" }), makeCms({ firstName: null }))
    ).toEqual({ kind: "NONE", reason: "no_diff" });
  });

  it("ignores CMS name when empty/whitespace string", () => {
    expect(
      diffProviderAgainstCms(makeLocal({ firstName: "Jordan" }), makeCms({ firstName: "   " }))
    ).toEqual({ kind: "NONE", reason: "no_diff" });
  });
});

describe("diffProviderAgainstCms — UPDATE/credential tri-state", () => {
  it("emits UPDATE setting credential when CMS has one and local has null", () => {
    const action = diffProviderAgainstCms(
      makeLocal({ credential: null }),
      makeCms({ credential: "MD" })
    );
    expect(action).toEqual({ kind: "UPDATE", changes: { credential: "MD" } });
  });

  it("emits UPDATE clearing credential when CMS has null and local has a value", () => {
    const action = diffProviderAgainstCms(
      makeLocal({ credential: "MD" }),
      makeCms({ credential: null })
    );
    expect(action).toEqual({ kind: "UPDATE", changes: { credential: null } });
  });

  it("emits UPDATE replacing credential when both differ", () => {
    const action = diffProviderAgainstCms(
      makeLocal({ credential: "MD" }),
      makeCms({ credential: "DO" })
    );
    expect(action).toEqual({ kind: "UPDATE", changes: { credential: "DO" } });
  });

  it("treats whitespace-only credential CMS value as null (normalization)", () => {
    expect(
      diffProviderAgainstCms(makeLocal({ credential: null }), makeCms({ credential: "   " }))
    ).toEqual({ kind: "NONE", reason: "no_diff" });
  });
});

describe("diffProviderAgainstCms — UPDATE/address fields", () => {
  it("emits UPDATE.changes.addressLine1 when line1 differs", () => {
    const action = diffProviderAgainstCms(
      makeLocal({ addressLine1: "1200 Maple St" }),
      makeCms({ practiceAddress: makeCmsAddress({ line1: "1300 Maple St" }) })
    );
    expect(action).toEqual({
      kind: "UPDATE",
      changes: { addressLine1: "1300 Maple St" },
    });
  });

  it("emits UPDATE.changes.city when city differs", () => {
    const action = diffProviderAgainstCms(
      makeLocal({ city: "Springfield" }),
      makeCms({ practiceAddress: makeCmsAddress({ city: "Shelbyville" }) })
    );
    expect(action).toEqual({
      kind: "UPDATE",
      changes: { city: "Shelbyville" },
    });
  });

  it("emits UPDATE.changes.postalCode when zip differs", () => {
    const action = diffProviderAgainstCms(
      makeLocal({ postalCode: "62701" }),
      makeCms({ practiceAddress: makeCmsAddress({ postalCode: "62704" }) })
    );
    expect(action).toEqual({
      kind: "UPDATE",
      changes: { postalCode: "62704" },
    });
  });

  it("normalizes state-code case (NY vs ny is NOT a diff)", () => {
    expect(
      diffProviderAgainstCms(
        makeLocal({ state: "NY" }),
        makeCms({ practiceAddress: makeCmsAddress({ stateCode: "ny" }) })
      )
    ).toEqual({ kind: "NONE", reason: "no_diff" });
  });

  it("emits UPDATE.changes.state in uppercase when CMS sends lowercase but local has different state", () => {
    const action = diffProviderAgainstCms(
      makeLocal({ state: "IL" }),
      makeCms({ practiceAddress: makeCmsAddress({ stateCode: "ny" }) })
    );
    expect(action).toEqual({ kind: "UPDATE", changes: { state: "NY" } });
  });

  it("addressLine2 tri-state: CMS null clears local value", () => {
    const action = diffProviderAgainstCms(
      makeLocal({ addressLine2: "Suite 4" }),
      makeCms({ practiceAddress: makeCmsAddress({ line2: null }) })
    );
    expect(action).toEqual({
      kind: "UPDATE",
      changes: { addressLine2: null },
    });
  });

  it("addressLine2 tri-state: CMS sets a value when local was null", () => {
    const action = diffProviderAgainstCms(
      makeLocal({ addressLine2: null }),
      makeCms({ practiceAddress: makeCmsAddress({ line2: "Suite 99" }) })
    );
    expect(action).toEqual({
      kind: "UPDATE",
      changes: { addressLine2: "Suite 99" },
    });
  });

  it("addressLine2 tri-state: both null is no-op", () => {
    expect(
      diffProviderAgainstCms(
        makeLocal({ addressLine2: null }),
        makeCms({ practiceAddress: makeCmsAddress({ line2: null }) })
      )
    ).toEqual({ kind: "NONE", reason: "no_diff" });
  });

  it("phone tri-state: CMS null clears local value", () => {
    const action = diffProviderAgainstCms(
      makeLocal({ phone: "217-555-0142" }),
      makeCms({ practiceAddress: makeCmsAddress({ phone: null }) })
    );
    expect(action).toEqual({ kind: "UPDATE", changes: { phone: null } });
  });

  it("phone tri-state: CMS sets when local was null", () => {
    const action = diffProviderAgainstCms(
      makeLocal({ phone: null }),
      makeCms({ practiceAddress: makeCmsAddress({ phone: "555-1234" }) })
    );
    expect(action).toEqual({
      kind: "UPDATE",
      changes: { phone: "555-1234" },
    });
  });

  it("whitespace in address fields is normalized (' 1200 Maple St ' == '1200 Maple St')", () => {
    expect(
      diffProviderAgainstCms(
        makeLocal({ addressLine1: "1200 Maple St" }),
        makeCms({ practiceAddress: makeCmsAddress({ line1: "  1200 Maple St  " }) })
      )
    ).toEqual({ kind: "NONE", reason: "no_diff" });
  });

  it("does NOT emit UPDATE clearing address when CMS reports null practiceAddress (preserve local)", () => {
    expect(
      diffProviderAgainstCms(
        makeLocal({
          addressLine1: "1200 Maple St",
          city: "Springfield",
          state: "IL",
          postalCode: "62701",
        }),
        makeCms({ practiceAddress: null })
      )
    ).toEqual({ kind: "NONE", reason: "no_diff" });
  });
});

describe("diffProviderAgainstCms — UPDATE/composite", () => {
  it("merges multiple drifted fields into a single UPDATE action", () => {
    const action = diffProviderAgainstCms(
      makeLocal({
        firstName: "Jordan",
        lastName: "Rivera",
        credential: "MD",
        addressLine1: "1200 Maple St",
        city: "Springfield",
      }),
      makeCms({
        firstName: "Jordan",
        lastName: "RIVERA-SMITH",
        credential: "DO",
        practiceAddress: makeCmsAddress({
          line1: "1300 Oak St",
          city: "Shelbyville",
        }),
      })
    );
    expect(action).toEqual({
      kind: "UPDATE",
      changes: {
        lastName: "RIVERA-SMITH",
        credential: "DO",
        addressLine1: "1300 Oak St",
        city: "Shelbyville",
      },
    });
  });

  it("emits UPDATE even when only one nullable address field changes", () => {
    const action = diffProviderAgainstCms(
      makeLocal({ phone: "217-555-0142" }),
      makeCms({ practiceAddress: makeCmsAddress({ phone: "217-555-9999" }) })
    );
    expect(action).toEqual({
      kind: "UPDATE",
      changes: { phone: "217-555-9999" },
    });
  });
});

// ---------------------------------------------------------------------
// Precedence ordering
// ---------------------------------------------------------------------

describe("diffProviderAgainstCms — precedence ordering", () => {
  it("NOT_FOUND_AT_CMS > REACTIVATION_CANDIDATE (null cms + INACTIVE local → not found wins)", () => {
    expect(diffProviderAgainstCms(makeLocal({ status: ProviderStatus.INACTIVE }), null).kind).toBe(
      "NOT_FOUND_AT_CMS"
    );
  });

  it("ENUMERATION_TYPE_MISMATCH > DEACTIVATE (NPI-2 + D status → mismatch wins)", () => {
    expect(
      diffProviderAgainstCms(
        makeLocal(),
        makeCms({
          enumerationType: "NPI-2",
          status: "D",
          firstName: null,
          lastName: null,
        })
      ).kind
    ).toBe("ENUMERATION_TYPE_MISMATCH");
  });

  it("DEACTIVATE > UPDATE (cmsInactive + name change → DEACTIVATE wins)", () => {
    expect(
      diffProviderAgainstCms(
        makeLocal({ firstName: "Stale" }),
        makeCms({ status: "D", firstName: "Jordan" })
      ).kind
    ).toBe("DEACTIVATE");
  });

  it("REACTIVATION_CANDIDATE > UPDATE (localInactive + name change → candidate wins)", () => {
    expect(
      diffProviderAgainstCms(
        makeLocal({ status: ProviderStatus.INACTIVE, firstName: "Stale" }),
        makeCms({ firstName: "Jordan" })
      ).kind
    ).toBe("REACTIVATION_CANDIDATE");
  });
});

// ---------------------------------------------------------------------
// Type narrowing (compile-time, expressed at runtime)
// ---------------------------------------------------------------------

describe("diffProviderAgainstCms — discriminated-union narrowing", () => {
  it("each kind narrows to the exact runtime shape (no spurious keys)", () => {
    const cases: Array<[() => unknown, ReadonlyArray<string>]> = [
      [() => diffProviderAgainstCms(makeLocal(), null), ["kind"]],
      [
        () =>
          diffProviderAgainstCms(
            makeLocal(),
            makeCms({ enumerationType: "NPI-2", firstName: null, lastName: null })
          ),
        ["kind", "cmsType", "expected"],
      ],
      [
        () => diffProviderAgainstCms(makeLocal(), makeCms({ status: "D" })),
        ["kind", "reason", "reasonText"],
      ],
      [
        () => diffProviderAgainstCms(makeLocal({ status: ProviderStatus.INACTIVE }), makeCms()),
        ["kind"],
      ],
      [() => diffProviderAgainstCms(makeLocal({ firstName: "X" }), makeCms()), ["kind", "changes"]],
      [() => diffProviderAgainstCms(makeLocal(), makeCms()), ["kind", "reason"]],
    ];
    for (const [fn, expectedKeys] of cases) {
      const action = fn() as Record<string, unknown>;
      expect(new Set(Object.keys(action))).toEqual(new Set(expectedKeys));
    }
  });
});

// ---------------------------------------------------------------------
// buildSyncDeactivationReasonText
// ---------------------------------------------------------------------

describe("buildSyncDeactivationReasonText", () => {
  it("produces the stable 'NPPES status: X (CMS updated <ISO>)' format", () => {
    expect(buildSyncDeactivationReasonText("D", new Date("2026-05-15T12:34:56.000Z"))).toBe(
      "NPPES status: D (CMS updated 2026-05-15T12:34:56.000Z)"
    );
  });

  it("uses ISO 8601 UTC for the timestamp regardless of input timezone", () => {
    // Non-UTC moment that ISO-stringifies deterministically.
    const ts = new Date(Date.UTC(2024, 0, 2, 3, 4, 5));
    expect(buildSyncDeactivationReasonText("D", ts)).toBe(
      "NPPES status: D (CMS updated 2024-01-02T03:04:05.000Z)"
    );
  });
});
