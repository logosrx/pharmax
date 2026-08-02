export {
  MaterializeShippedOrderBilling,
  type MaterializeShippedOrderBillingInput,
  type MaterializeShippedOrderBillingOutput,
  type MaterializedFeeLine,
  FLAT_DISPENSE_FEE_CENTS,
  FLAT_DISPENSE_FEE_DESCRIPTION,
  SHIPPING_FEE_DESCRIPTION,
  RUSH_FEE_DESCRIPTION,
  MATERIALIZE_BILLING_CLINIC_NOT_FOUND,
  MATERIALIZE_BILLING_INVOICE_NUMBER_COLLISION,
} from "./commands/materialize-shipped-order-billing.js";

export {
  ApproveInvoice,
  type ApproveInvoiceInput,
  type ApproveInvoiceOutput,
  APPROVE_INVOICE_NOT_FOUND,
  APPROVE_INVOICE_INVALID_STATUS,
  APPROVE_INVOICE_EMPTY,
  APPROVE_INVOICE_VERSION_MISMATCH,
} from "./commands/approve-invoice.js";

export {
  AutoFinalizeDueInvoice,
  type AutoFinalizeDueInvoiceInput,
  type AutoFinalizeDueInvoiceOutput,
  AUTO_FINALIZE_INVOICE_NOT_FOUND,
  AUTO_FINALIZE_PERIOD_NOT_ENDED,
  AUTO_FINALIZE_NO_BILLING_PERIOD,
} from "./commands/auto-finalize-due-invoice.js";

export {
  FinalizeInvoice,
  type FinalizeInvoiceInput,
  type FinalizeInvoiceOutput,
  FINALIZE_INVOICE_NOT_FOUND,
  FINALIZE_INVOICE_NOT_APPROVED,
  FINALIZE_INVOICE_APPROVAL_STALE,
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
  RecordManualPayment,
  type RecordManualPaymentInput,
  type RecordManualPaymentOutput,
  type ManualPaymentInstrument,
  MANUAL_PAYMENT_INSTRUMENTS,
  RECORD_MANUAL_PAYMENT_INVOICE_NOT_FOUND,
  RECORD_MANUAL_PAYMENT_INVALID_STATUS,
  RECORD_MANUAL_PAYMENT_AMOUNT_EXCEEDS_DUE,
  RECORD_MANUAL_PAYMENT_RECEIVED_AT_IN_FUTURE,
  RECORD_MANUAL_PAYMENT_VERSION_MISMATCH,
} from "./commands/record-manual-payment.js";

export {
  GrantClinicCredit,
  type GrantClinicCreditInput,
  type GrantClinicCreditOutput,
  GRANT_CLINIC_CREDIT_RECEIVED_AT_IN_FUTURE,
} from "./commands/grant-clinic-credit.js";

export {
  ApplyClinicCredit,
  type ApplyClinicCreditInput,
  type ApplyClinicCreditOutput,
  APPLY_CLINIC_CREDIT_INVOICE_NOT_FOUND,
  APPLY_CLINIC_CREDIT_INVALID_STATUS,
  APPLY_CLINIC_CREDIT_AMOUNT_EXCEEDS_DUE,
  APPLY_CLINIC_CREDIT_INSUFFICIENT_BALANCE,
  APPLY_CLINIC_CREDIT_VERSION_MISMATCH,
} from "./commands/apply-clinic-credit.js";

export {
  insertPaymentLedgerRow,
  paymentRecordedOutboxEvent,
  computePriorRefundedCents,
  type PaymentLedgerRowInput,
  type PaymentLedgerRowResult,
  type PriorRefundTotals,
} from "./payments/payment-ledger.js";

export {
  insertClinicCreditEntry,
  clinicCreditRecordedOutboxEvent,
  computeClinicCreditBalanceCents,
  lockClinicForCredit,
  type ClinicCreditEntryInput,
  type ClinicCreditEntryResult,
  CLINIC_CREDIT_CLINIC_NOT_FOUND,
} from "./credit/clinic-credit.js";

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
