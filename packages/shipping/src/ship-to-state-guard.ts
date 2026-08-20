// Ship-to-state licensure guard — go-live G-2.
//
// A pharmacy may only dispense into a state it holds a licence for:
// resident in its own state, non-resident everywhere else. Shipping
// outside that set is a finding against the CUSTOMER's licence, which
// makes it Pharmax's problem to prevent rather than to warn about.
//
// WHY THIS IS A SHARED HELPER AND NOT A CHECK IN ONE COMMAND. Three
// commands can commit a shipment, and only `PurchaseShipmentLabel` ever
// receives an address:
//
//   PurchaseShipmentLabel  buys a label from a carrier
//   CreateShipment         records a manually-obtained tracking number
//   ConfirmShipment        moves the order to SHIPPED
//
// `CreateShipment`'s own file documents it as "the deliberate override"
// for PurchaseShipmentLabel's address validation. So a check placed
// only where the address happens to be available is a control an
// operator bypasses by pasting a tracking number — which is why
// `order.destinationState` exists and why all three call this.
//
// ENFORCEMENT IS PER-SITE AND SELF-GATING. A site with no declared
// authorized states has asserted nothing about where it is licensed, so
// there is nothing to enforce against and this passes. Declaring the
// first state turns enforcement on for that site. That makes the
// rollout a tenant-by-tenant decision rather than a deploy-wide flag,
// and it means shipping this guard cannot break an existing tenant.
//
// A NULL DESTINATION REFUSES once a site enforces. Orders created before
// `order.destinationState` existed have none, and it cannot be
// backfilled in SQL because deriving it needs a KMS decrypt per
// patient — `scripts/operations/backfill-order-destination-state.ts`
// does that pass. Refusing is the right direction: "we do not know
// which state this is going to" is not a reason to ship it.

import { errors } from "@pharmax/platform-core";
import type { Prisma } from "@pharmax/database";

export const SHIP_TO_STATE_NOT_LICENSED = "SHIP_TO_STATE_NOT_LICENSED";
export const SHIP_TO_STATE_UNKNOWN_DESTINATION = "SHIP_TO_STATE_UNKNOWN_DESTINATION";

type ShipStateDelegateClient = Pick<Prisma.TransactionClient, "siteAuthorizedShipState">;
type OrderDelegateClient = Pick<Prisma.TransactionClient, "order">;

/**
 * Read an order's recorded destination state.
 *
 * A separate read because `defineCommand`'s row lock selects a fixed
 * column set that does not include this one, and widening that SELECT
 * would touch every workflow command for the benefit of three. The row
 * is already locked and cached in this transaction, so the cost is a
 * cache hit.
 *
 * NOT used by `PurchaseShipmentLabel`. That command ships to the
 * address in its input, which an operator can edit — checking the
 * stored value while shipping to a typed one would be a bypass. It
 * passes `input.toAddress.state` instead.
 */
export async function readOrderDestinationState(input: {
  readonly tx: OrderDelegateClient;
  readonly organizationId: string;
  readonly orderId: string;
}): Promise<string | null> {
  const row = await input.tx.order.findFirst({
    where: { id: input.orderId, organizationId: input.organizationId },
    select: { destinationState: true },
  });
  return row?.destinationState ?? null;
}

export interface AssertShipToStateAllowedInput {
  readonly tx: ShipStateDelegateClient;
  readonly organizationId: string;
  readonly siteId: string;
  readonly orderId: string;
  /**
   * From `order.destinationState`, or — for `PurchaseShipmentLabel`,
   * which has a resolved address in hand — the address's state. Null
   * means the order predates the column.
   */
  readonly destinationState: string | null;
}

/**
 * Refuse unless the site is licensed to dispense into the destination.
 *
 * Throws `AuthorizationError` rather than `ValidationError`: the address
 * is not malformed and correcting it will not help. The pharmacy is not
 * permitted to dispense there, which is a question of authority.
 */
export async function assertShipToStateAllowed(
  input: AssertShipToStateAllowedInput
): Promise<void> {
  const authorized = await input.tx.siteAuthorizedShipState.findMany({
    where: { organizationId: input.organizationId, siteId: input.siteId },
    select: { state: true },
  });

  // No declaration means no enforcement for this site. See the header:
  // this is the self-gating rollout, not a hole.
  if (authorized.length === 0) return;

  const licensedStates = authorized.map((row) => row.state).sort();

  if (input.destinationState === null) {
    throw new errors.ValidationError({
      code: SHIP_TO_STATE_UNKNOWN_DESTINATION,
      message:
        "This order has no recorded destination state, so it cannot be checked against the site's pharmacy licences. Re-derive the destination before shipping.",
      metadata: { orderId: input.orderId, siteId: input.siteId },
    });
  }

  if (!licensedStates.includes(input.destinationState)) {
    throw new errors.AuthorizationError({
      code: SHIP_TO_STATE_NOT_LICENSED,
      message: `This site holds no pharmacy licence for ${input.destinationState} and cannot dispense there. Record a non-resident licence and authorize the state, or transfer the order to a site that is licensed.`,
      // The destination state is safe to name — it is not a Safe Harbor
      // identifier — and naming it is the whole value of the message.
      // The licensed set is included because the operator's next
      // question is always "where CAN we ship".
      metadata: {
        orderId: input.orderId,
        siteId: input.siteId,
        destinationState: input.destinationState,
        licensedStates,
      },
    });
  }
}
