// @pharmax/inventory — lot receiving + DSCSA chain of custody
// (ADR-0035 slice 3) and the compound product catalog. Fill owns
// consumption; compounding owns preparation; this package owns the
// inbound edge of the Lot/InventoryTransaction spine, the
// recall-response read, and catalog creation of in-house compounds
// (Pharmax Product ID minting).

export { ReceiveLot, type ReceiveLotInput, type ReceiveLotOutput } from "./commands/receive-lot.js";
export {
  CreateCompoundProduct,
  type CreateCompoundProductInput,
  type CreateCompoundProductOutput,
} from "./commands/create-compound-product.js";
export { getLotChainOfCustody, type LotChainOfCustody } from "./queries/lot-chain-of-custody.js";

export {
  allocatePharmaxProductId,
  formatPharmaxProductId,
  PHARMAX_PRODUCT_ID_ALLOCATION_FAILED,
  PHARMAX_PRODUCT_ID_PAD_WIDTH,
  PHARMAX_PRODUCT_ID_PREFIX,
} from "./pharmax-product-id.js";

export {
  CATALOG_DUPLICATE_COMPOUND_PRODUCT,
  CATALOG_PRODUCT_CREATE_CONFLICT,
  INVENTORY_EXPIRATION_MISMATCH,
  INVENTORY_LOT_EXPIRED_AT_RECEIPT,
  INVENTORY_LOT_NOT_FOUND,
  INVENTORY_PRODUCT_NOT_FOUND,
  INVENTORY_RECEIPT_CONFLICT,
  INVENTORY_SITE_NOT_FOUND,
  INVENTORY_TS_NOT_RECEIVED,
} from "./shared.js";
