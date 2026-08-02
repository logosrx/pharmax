// @pharmax/inventory — lot receiving + DSCSA chain of custody
// (ADR-0035 slice 3). Fill owns consumption; compounding owns
// preparation; this package owns the inbound edge of the
// Lot/InventoryTransaction spine and the recall-response read.

export { ReceiveLot, type ReceiveLotInput, type ReceiveLotOutput } from "./commands/receive-lot.js";
export { getLotChainOfCustody, type LotChainOfCustody } from "./queries/lot-chain-of-custody.js";

export {
  INVENTORY_EXPIRATION_MISMATCH,
  INVENTORY_LOT_EXPIRED_AT_RECEIPT,
  INVENTORY_LOT_NOT_FOUND,
  INVENTORY_PRODUCT_NOT_FOUND,
  INVENTORY_RECEIPT_CONFLICT,
  INVENTORY_SITE_NOT_FOUND,
  INVENTORY_TS_NOT_RECEIVED,
} from "./shared.js";
