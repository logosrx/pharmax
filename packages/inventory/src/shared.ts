// Shared constants for the inventory domain (ADR-0035 slice 3).

// ---------------------------------------------------------------------
// Error codes
// ---------------------------------------------------------------------

export const INVENTORY_SITE_NOT_FOUND = "INVENTORY_SITE_NOT_FOUND";
export const INVENTORY_PRODUCT_NOT_FOUND = "INVENTORY_PRODUCT_NOT_FOUND";
export const INVENTORY_LOT_EXPIRED_AT_RECEIPT = "INVENTORY_LOT_EXPIRED_AT_RECEIPT";
export const INVENTORY_EXPIRATION_MISMATCH = "INVENTORY_EXPIRATION_MISMATCH";
export const INVENTORY_TS_NOT_RECEIVED = "INVENTORY_TS_NOT_RECEIVED";
export const INVENTORY_RECEIPT_CONFLICT = "INVENTORY_RECEIPT_CONFLICT";
export const INVENTORY_LOT_NOT_FOUND = "INVENTORY_LOT_NOT_FOUND";

// Product catalog CRUD + AI guardrails (typing-assist phase 1).
export const INVENTORY_PRODUCT_NDC_CONFLICT = "INVENTORY_PRODUCT_NDC_CONFLICT";
export const INVENTORY_PRODUCT_NO_CHANGES = "INVENTORY_PRODUCT_NO_CHANGES";
export const INVENTORY_GUARDRAIL_CONFLICT = "INVENTORY_GUARDRAIL_CONFLICT";
