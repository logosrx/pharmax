export {
  MaterializeShippedOrderBilling,
  type MaterializeShippedOrderBillingInput,
  type MaterializeShippedOrderBillingOutput,
  FLAT_DISPENSE_FEE_CENTS,
  FLAT_DISPENSE_FEE_DESCRIPTION,
  MATERIALIZE_BILLING_CLINIC_NOT_FOUND,
  MATERIALIZE_BILLING_INVOICE_NUMBER_COLLISION,
} from "./commands/materialize-shipped-order-billing.js";

export {
  FinalizeInvoice,
  type FinalizeInvoiceInput,
  type FinalizeInvoiceOutput,
  FINALIZE_INVOICE_NOT_FOUND,
  FINALIZE_INVOICE_EMPTY,
  FINALIZE_INVOICE_VERSION_MISMATCH,
} from "./commands/finalize-invoice.js";

export {
  RecordStripeInvoicePushed,
  type RecordStripeInvoicePushedInput,
  type RecordStripeInvoicePushedOutput,
  RECORD_STRIPE_PUSH_INVOICE_NOT_FOUND,
  RECORD_STRIPE_PUSH_MISMATCH,
} from "./commands/record-stripe-invoice-pushed.js";

export {
  type StripeInvoicePort,
  type StripePushRequest,
  type StripePushResult,
  type StripePushLine,
  STRIPE_PUSH_CUSTOMER_NOT_LINKED,
  STRIPE_PUSH_API_ERROR,
} from "./ports/stripe-invoice-port.js";

export {
  UpsertPricingRule,
  type UpsertPricingRuleInput,
  type UpsertPricingRuleOutput,
  UPSERT_PRICING_RULE_AMOUNT_INVALID,
  UPSERT_PRICING_RULE_ACTIVE_RACE,
  UPSERT_PRICING_RULE_CLINIC_NOT_FOUND,
  UPSERT_PRICING_RULE_PRODUCT_NOT_FOUND,
} from "./commands/upsert-pricing-rule.js";

export {
  CreditInvoice,
  type CreditInvoiceInput,
  type CreditInvoiceOutput,
  CREDIT_INVOICE_KINDS,
  CREDIT_INVOICE_NOT_FOUND,
  CREDIT_INVOICE_VOIDED,
  CREDIT_INVOICE_EXCEEDS_TOTAL,
  CREDIT_INVOICE_AMOUNT_INVALID,
} from "./commands/credit-invoice.js";

export {
  listAgedInvoices,
  classifyAgingBucket,
  AGING_BUCKETS,
  type AgedInvoiceRow,
  type AgingBucket,
  type AgingBucketTotals,
  type AgingReport,
  type ClinicAging,
  type ListAgedInvoicesOptions,
} from "./queries/list-aged-invoices.js";

export {
  MarkInvoicePaid,
  type MarkInvoicePaidInput,
  type MarkInvoicePaidOutput,
  MARK_PAID_VERSION_MISMATCH,
  MARK_PAID_INVALID_STATUS_TRANSITION,
} from "./commands/mark-invoice-paid.js";

export {
  MarkInvoiceVoided,
  type MarkInvoiceVoidedInput,
  type MarkInvoiceVoidedOutput,
  MARK_VOIDED_VERSION_MISMATCH,
  MARK_VOIDED_INVALID_STATUS_TRANSITION,
} from "./commands/mark-invoice-voided.js";

export {
  MarkInvoiceUncollectible,
  type MarkInvoiceUncollectibleInput,
  type MarkInvoiceUncollectibleOutput,
  MARK_UNCOLLECTIBLE_VERSION_MISMATCH,
  MARK_UNCOLLECTIBLE_INVALID_STATUS_TRANSITION,
} from "./commands/mark-invoice-uncollectible.js";

export {
  RecordInvoicePaymentFailure,
  type RecordInvoicePaymentFailureInput,
  type RecordInvoicePaymentFailureOutput,
} from "./commands/record-invoice-payment-failure.js";

export {
  IssueRefund,
  type IssueRefundInput,
  type IssueRefundOutput,
  ISSUE_REFUND_INVOICE_NOT_FOUND,
  ISSUE_REFUND_INVOICE_NOT_PAID,
  ISSUE_REFUND_CHARGE_NOT_LINKED,
  ISSUE_REFUND_AMOUNT_EXCEEDS_PAID,
  ISSUE_REFUND_AMOUNT_INVALID,
} from "./commands/issue-refund.js";

export {
  RecordRefundReceived,
  type RecordRefundReceivedInput,
  type RecordRefundReceivedOutput,
} from "./commands/record-refund-received.js";

export {
  configureBilling,
  getBillingConfiguration,
  getStripeRefundPort,
  resetBillingConfigurationForTests,
  type BillingConfiguration,
  BILLING_NOT_CONFIGURED,
  BILLING_REFUND_NOT_CONFIGURED,
} from "./configure.js";

export {
  type StripeRefundPort,
  type StripeRefundRequest,
  type StripeRefundResult,
  STRIPE_REFUND_API_ERROR,
  STRIPE_REFUND_CHARGE_NOT_REFUNDABLE,
} from "./ports/stripe-refund-port.js";

export {
  loadCandidatePricingRules,
  pickPricingRule,
  type PricingRuleCandidate,
  type PricingResolution,
  type PricingResolutionQuery,
} from "./pricing/resolve-pricing.js";
