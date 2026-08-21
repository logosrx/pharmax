// Ship-to-state licensure guard tests — go-live G-2.
//
// The cases that matter most are the two that look like bugs and are
// not: an unenforced site passes everything, and a null destination
// refuses. Both are load-bearing.

import { describe, expect, it, vi } from "vitest";

import {
  assertShipToStateAllowed,
  readOrderDestinationState,
  SHIP_TO_STATE_NOT_LICENSED,
  SHIP_TO_STATE_UNKNOWN_DESTINATION,
} from "./ship-to-state-guard.js";

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const SITE_ID = "00000000-0000-4000-8000-000000000003";
const ORDER_ID = "00000000-0000-4000-8000-0000000000a1";

function txWith(states: ReadonlyArray<string>) {
  return {
    siteAuthorizedShipState: {
      findMany: vi.fn(async (_args: { where: Record<string, unknown> }) =>
        states.map((state) => ({ state }))
      ),
    },
  };
}

function orderTx(destinationState: string | null) {
  return {
    order: {
      findFirst: vi.fn(async () => ({ destinationState })),
    },
  };
}

describe("assertShipToStateAllowed — enforcement is per-site and self-gating", () => {
  it("passes anything when the site has declared no authorized states", async () => {
    // Not a hole. A site with no declaration has asserted nothing about
    // where it is licensed, so there is nothing to enforce against —
    // and refusing everything would break every existing tenant the
    // day this shipped. Declaring one state turns enforcement on.
    await expect(
      assertShipToStateAllowed({
        tx: txWith([]) as never,
        organizationId: ORG_ID,
        siteId: SITE_ID,
        orderId: ORDER_ID,
        destinationState: "TX",
      })
    ).resolves.toBeUndefined();
  });

  it("passes an unknown destination when the site is unenforced", async () => {
    // The null-destination refusal must not fire before enforcement is
    // on, or every pre-existing order would be unshippable on deploy.
    await expect(
      assertShipToStateAllowed({
        tx: txWith([]) as never,
        organizationId: ORG_ID,
        siteId: SITE_ID,
        orderId: ORDER_ID,
        destinationState: null,
      })
    ).resolves.toBeUndefined();
  });
});

describe("assertShipToStateAllowed — refusals", () => {
  it("permits a destination the site is licensed for", async () => {
    await expect(
      assertShipToStateAllowed({
        tx: txWith(["CA", "OR", "WA"]) as never,
        organizationId: ORG_ID,
        siteId: SITE_ID,
        orderId: ORDER_ID,
        destinationState: "OR",
      })
    ).resolves.toBeUndefined();
  });

  it("refuses a destination outside the licensed set", async () => {
    await expect(
      assertShipToStateAllowed({
        tx: txWith(["CA", "OR"]) as never,
        organizationId: ORG_ID,
        siteId: SITE_ID,
        orderId: ORDER_ID,
        destinationState: "TX",
      })
    ).rejects.toMatchObject({ code: SHIP_TO_STATE_NOT_LICENSED });
  });

  it("names the destination and the licensed set in the refusal", async () => {
    // A state is not a Safe Harbor identifier, so naming it is safe —
    // and the operator's next question is always "where CAN we ship".
    try {
      await assertShipToStateAllowed({
        tx: txWith(["OR", "CA"]) as never,
        organizationId: ORG_ID,
        siteId: SITE_ID,
        orderId: ORDER_ID,
        destinationState: "TX",
      });
      throw new Error("expected a refusal");
    } catch (cause) {
      const metadata = (cause as { metadata: Record<string, unknown> }).metadata;
      expect(metadata["destinationState"]).toBe("TX");
      expect(metadata["licensedStates"]).toEqual(["CA", "OR"]);
    }
  });

  it("refuses an unknown destination once the site enforces", async () => {
    // Orders predating `order.destinationState` have none, and it
    // cannot be backfilled in SQL. "We do not know which state this is
    // going to" is not a reason to ship it.
    await expect(
      assertShipToStateAllowed({
        tx: txWith(["CA"]) as never,
        organizationId: ORG_ID,
        siteId: SITE_ID,
        orderId: ORDER_ID,
        destinationState: null,
      })
    ).rejects.toMatchObject({ code: SHIP_TO_STATE_UNKNOWN_DESTINATION });
  });

  it("scopes the authorized-state lookup to the org and site", async () => {
    const tx = txWith(["CA"]);
    await assertShipToStateAllowed({
      tx: tx as never,
      organizationId: ORG_ID,
      siteId: SITE_ID,
      orderId: ORDER_ID,
      destinationState: "CA",
    });
    const where = tx.siteAuthorizedShipState.findMany.mock.calls[0]![0].where;
    expect(where["organizationId"]).toBe(ORG_ID);
    expect(where["siteId"]).toBe(SITE_ID);
  });

  it("is case-sensitive by construction — callers normalize first", async () => {
    // The guard compares against stored uppercase codes. Every caller
    // either reads a normalized column or runs the input through
    // `geo.normalizeJurisdictionCode`; a lowercase value reaching here
    // is a caller bug and should refuse rather than silently match.
    await expect(
      assertShipToStateAllowed({
        tx: txWith(["CA"]) as never,
        organizationId: ORG_ID,
        siteId: SITE_ID,
        orderId: ORDER_ID,
        destinationState: "ca",
      })
    ).rejects.toMatchObject({ code: SHIP_TO_STATE_NOT_LICENSED });
  });
});

describe("readOrderDestinationState", () => {
  it("returns the recorded state", async () => {
    const tx = orderTx("NV");
    await expect(
      readOrderDestinationState({ tx: tx as never, organizationId: ORG_ID, orderId: ORDER_ID })
    ).resolves.toBe("NV");
  });

  it("returns null when the order has none", async () => {
    const tx = orderTx(null);
    await expect(
      readOrderDestinationState({ tx: tx as never, organizationId: ORG_ID, orderId: ORDER_ID })
    ).resolves.toBeNull();
  });

  it("returns null when the order is not in this organization", async () => {
    const tx = { order: { findFirst: vi.fn(async () => null) } };
    await expect(
      readOrderDestinationState({ tx: tx as never, organizationId: ORG_ID, orderId: ORDER_ID })
    ).resolves.toBeNull();
  });
});
