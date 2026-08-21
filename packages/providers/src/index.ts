// Public surface of @pharmax/providers.
//
// Convention mirrors @pharmax/orgs and @pharmax/patients:
//   - Each command file owns its input/output types.
//   - Commands re-exported individually AND under a `commands`
//     namespace for ergonomic batch imports.
//   - `SyncFromNpiRegistry` is a worker (not a synchronous command);
//     its building blocks land under `src/npi-sync/` and re-export
//     here so future slices (HTTP client, schema, worker) can
//     import the diff engine without crossing package boundaries.

export {
  PROVIDER_DEA_INVALID,
  RegisterProvider,
  type RegisterProviderInput,
  type RegisterProviderOutput,
} from "./commands/register-provider.js";

// UpdateProvider is the plaintext counterpart to UpdatePatient with
// the same tri-state + change-set + locked-state-guard + predicate-
// CAS pattern. NPI is intentionally NOT in the input schema
// (immutable); `status` similarly not editable here (use
// DeactivateProvider). `deaNumber` is the only redacted field.
export {
  UpdateProvider,
  type UpdateProviderInput,
  type UpdateProviderOutput,
} from "./commands/update-provider.js";

// DeactivateProvider is the ACTIVE → INACTIVE transition with a
// closed-enum reason code and an optional, redacted reasonText.
// `reason` is a TS literal union (not a Prisma enum) since we don't
// write it to a column — audit_log + outbox carry the structural
// signal for downstream workers (e.g. interrupting in-flight CS
// fills when reason === DEA_SURRENDERED_OR_REVOKED or SANCTIONED).
export {
  DeactivateProvider,
  PROVIDER_DEACTIVATION_REASONS,
  type DeactivateProviderInput,
  type DeactivateProviderOutput,
  type ProviderDeactivationReason,
} from "./commands/deactivate-provider.js";

// ReactivateProvider is the INACTIVE → ACTIVE counterpart with a
// deliberately DIFFERENT closed-enum reason vocabulary
// (`LICENSE_RESTORED`, `DEA_RESTORED`, `SANCTION_LIFTED`,
// `RELATIONSHIP_RESUMED`, `RETURNED_FROM_RETIREMENT`,
// `RELOCATED_BACK_INTO_AREA`, `ERRONEOUS_DEACTIVATION`, `OTHER`).
// Terminal deactivation codes (`DECEASED`, `DUPLICATE_RECORD`)
// have no reactivation counterpart on purpose; `ERRONEOUS_DEACTIVATION`
// is the audit-correction path with no deactivation analog. The
// outbox event `provider.reactivated.v1` is the symmetric
// counterpart to `provider.deactivated.v1` so a future "resume
// in-flight CS fills" worker can subscribe on `DEA_RESTORED` /
// `SANCTION_LIFTED`.
export {
  ReactivateProvider,
  PROVIDER_REACTIVATION_REASONS,
  type ReactivateProviderInput,
  type ReactivateProviderOutput,
  type ProviderReactivationReason,
} from "./commands/reactivate-provider.js";

// SyncFromNpiRegistry — slice 1 of N: the pure diff engine. Given a
// local Provider row and a CMS NPPES snapshot, returns a
// discriminated `SyncAction` (NONE / DEACTIVATE / UPDATE /
// REACTIVATION_CANDIDATE / NOT_FOUND_AT_CMS /
// ENUMERATION_TYPE_MISMATCH) for the worker to act on. No IO.
export {
  diffProviderAgainstCms,
  buildSyncDeactivationReasonText,
  type LocalProviderSnapshot,
  type CmsNpiSnapshot,
  type CmsAddress,
  type SyncAction,
  type SyncActionNone,
  type SyncActionDeactivate,
  type SyncActionUpdate,
  type SyncActionReactivationCandidate,
  type SyncActionNotFoundAtCms,
  type SyncActionEnumerationTypeMismatch,
  type ProviderUpdateChanges,
} from "./npi-sync/diff-engine.js";

// SyncFromNpiRegistry — slice 2 of N: the CMS NPPES HTTP client.
// Per-NPI lookups against the public NPPES v2.1 API, with a
// polite rate gate (default 8 req/s), exponential backoff with
// jitter on retryable failures (429, 5xx, network, timeout), and
// `Retry-After` honoring. `fetchManyByNpi` returns per-NPI results
// so the worker (slice 4) handles partial-batch failures cleanly.
// CMS data is public — no PHI considerations apply.
export {
  CmsNppesClient,
  CMS_NPI_REGISTRY_ERRORS,
  parseSingleNpiResponse,
  type CmsNppesClientOptions,
  type CmsFetchResult,
  type FetchFunction,
  type Sleeper,
} from "./npi-sync/cms-client.js";

// SyncFromNpiRegistry — slice 4 of N: the per-org orchestrator.
// Reconciles every provider in an organization against the CMS
// NPI Registry, dispatching `UpdateProvider` / `DeactivateProvider`
// for actionable diffs and persisting `provider_sync_check` /
// `provider_sync_review_item` rows for every check. Caller must
// enter the org's tenancy frame before invoking. Slice 5 (the
// cross-tenant drain) will fan this out across orgs on a schedule.
export {
  classifyDispatchError,
  runNpiSyncForOrg,
  type DispatchDeactivateProvider,
  type DispatchOptions,
  type DispatchResult,
  type DispatchUpdateProvider,
  type ProviderRaceCode,
  type ProviderRowProjection,
  type ProviderSyncPrismaSurface,
  type RunNpiSyncForOrgDeps,
  type RunNpiSyncForOrgInput,
  type RunNpiSyncForOrgResult,
  type RunNpiSyncForOrgSummary,
} from "./npi-sync/run-sync.js";

// SyncFromNpiRegistry — slice 4 adjunct: the production dispatch
// adapter. Wires the worker's `DispatchUpdateProvider` /
// `DispatchDeactivateProvider` interfaces to `executeCommand` +
// a `command_log.id` lookup. Slice-5 drains call
// `buildProductionDispatchers(prisma)` and pass the returned
// closures into `runNpiSyncForOrg`'s deps.
export {
  buildProductionDispatchers,
  type DispatchAdaptersPrismaSurface,
  type ProductionDispatchers,
} from "./npi-sync/dispatch-adapters.js";

// Provider self-serve onboarding (ADR-0033, slice 1). Submit +
// proofing are machine-dispatched (public apply endpoint / worker
// drain acting as the per-org ProviderOnboardingService identity);
// approve + reject are the human review-queue decisions. The pure
// NPPES match rules (`evaluateProofing`) live beside the commands
// so the drain and the tests share one PASS bar.
export {
  SubmitProviderOnboardingApplication,
  type SubmitProviderOnboardingApplicationInput,
  type SubmitProviderOnboardingApplicationOutput,
} from "./onboarding/submit-application.js";
export {
  RecordProviderOnboardingProofing,
  type RecordProviderOnboardingProofingInput,
  type RecordProviderOnboardingProofingOutput,
} from "./onboarding/record-proofing.js";
export {
  ApproveProviderOnboardingApplication,
  type ApproveProviderOnboardingApplicationInput,
  type ApproveProviderOnboardingApplicationOutput,
} from "./onboarding/approve-application.js";
export {
  RejectProviderOnboardingApplication,
  type RejectProviderOnboardingApplicationInput,
  type RejectProviderOnboardingApplicationOutput,
} from "./onboarding/reject-application.js";
export {
  buildProofingSnapshotJson,
  evaluateProofing,
  normalizeSurname,
  type ProofingClaim,
  type ProofingOutcome,
} from "./onboarding/proofing.js";
export {
  PROVIDER_ONBOARDING_ALREADY_OPEN,
  PROVIDER_ONBOARDING_APPLICATION_NOT_FOUND,
  PROVIDER_ONBOARDING_INVALID_STATE,
  PROVIDER_ONBOARDING_NPI_ALREADY_REGISTERED,
  PROVIDER_ONBOARDING_POLICY_CODE,
  PROVIDER_ONBOARDING_POLICY_NOT_FOUND,
  PROVIDER_ONBOARDING_POLICY_VERSION,
} from "./onboarding/shared.js";

// Provider portal principals (ADR-0033, slice 2). PortalAccount /
// PortalSession are a SEPARATE principal pair from the operator
// User/AuthSession — a portal credential resolves to a Provider,
// never to a User. Reuses @pharmax/auth primitives (Argon2id hasher,
// token minting/hashing, password policy, login-attempt ledger).
export {
  provisionPortalAccountInTx,
  type ProvisionPortalAccountResult,
} from "./portal/provision.js";
export {
  IssuePortalSetupToken,
  issuePortalSetupToken,
  type IssuePortalSetupTokenInput,
  type IssuePortalSetupTokenOutput,
} from "./portal/issue-setup-token.js";
export {
  SetupPortalAccount,
  setupPortalAccount,
  type SetupPortalAccountInput,
  type SetupPortalAccountOutput,
} from "./portal/setup-account.js";
export {
  PORTAL_NO_ACTIVE_CLINIC,
  PortalSignIn,
  type PortalSignInInput,
  type PortalSignInOutput,
} from "./portal/sign-in-command.js";
export {
  canActForClinic,
  listPortalClinicOptions,
  type PortalClinicOption,
} from "./portal/clinic-access.js";

export {
  canPrescribe,
  validateDeaNumber,
  DEA_INVALID_CHECKSUM,
  DEA_INVALID_FORMAT,
  DEA_LAST_NAME_MISMATCH,
  DEA_UNKNOWN_REGISTRANT_TYPE,
  type DeaRegistrantType,
  type DeaValidationFailure,
  type DeaValidationFailureCode,
  type DeaValidationResult,
  type DeaValidationSuccess,
} from "./dea/validate-dea-number.js";

export {
  RecordProviderDeaRegistration,
  RECORD_DEA_INVALID,
  RECORD_DEA_NUMBER_BELONGS_TO_ANOTHER_PROVIDER,
  RECORD_DEA_PROVIDER_INACTIVE,
  RECORD_DEA_PROVIDER_NOT_FOUND,
  RECORD_DEA_UNKNOWN_STATE,
  type RecordProviderDeaRegistrationInput,
  type RecordProviderDeaRegistrationOutput,
} from "./commands/record-provider-dea-registration.js";

export {
  RecordProviderStateLicense,
  RECORD_LICENSE_EXPIRY_BEFORE_ISSUE,
  RECORD_LICENSE_PROVIDER_INACTIVE,
  RECORD_LICENSE_PROVIDER_NOT_FOUND,
  RECORD_LICENSE_UNKNOWN_STATE,
  type RecordProviderStateLicenseInput,
  type RecordProviderStateLicenseOutput,
} from "./commands/record-provider-state-license.js";

export {
  RevokeProviderCredential,
  PROVIDER_CREDENTIAL_KINDS,
  REVOKE_CREDENTIAL_ALREADY_INACTIVE,
  REVOKE_CREDENTIAL_NOT_FOUND,
  type ProviderCredentialKind,
  type RevokeProviderCredentialInput,
  type RevokeProviderCredentialOutput,
} from "./commands/revoke-provider-credential.js";
export {
  SwitchPortalClinic,
  SWITCH_PORTAL_CLINIC_NOT_AFFILIATED,
  SWITCH_PORTAL_CLINIC_SESSION_NOT_FOUND,
  type SwitchPortalClinicInput,
  type SwitchPortalClinicOutput,
} from "./portal/switch-clinic-command.js";
export {
  ChangePortalPassword,
  changePortalPassword,
  type ChangePortalPasswordInput,
  type ChangePortalPasswordOutput,
} from "./portal/change-password.js";
export { portalSignIn, type PortalSignInResult } from "./portal/sign-in.js";
export {
  createPortalSessionInTx,
  resolvePortalSession,
  revokePortalSessionByToken,
  revokeAllPortalAccountSessionsInTx,
  PORTAL_SESSION_NOT_FOUND,
  PORTAL_SESSION_REVOKED,
  PORTAL_SESSION_IDLE_EXPIRED,
  PORTAL_SESSION_ABSOLUTE_EXPIRED,
  PORTAL_SESSION_ACCOUNT_DISABLED,
  PORTAL_SESSION_CLIENT_ACCESS_REVOKED,
  type PortalSessionResolution,
  type PortalSessionFailureReason,
  type ResolvedPortalSession,
  type CreatePortalSessionInput,
  type CreatedPortalSession,
  type ResolvePortalSessionInput,
  type PortalSessionRevokeReason,
} from "./portal/session.js";
export {
  NOOP_PORTAL_SETUP_MAILER,
  PORTAL_ACCOUNT_DISABLED,
  PORTAL_ACCOUNT_NOT_FOUND,
  PORTAL_CURRENT_PASSWORD_INVALID,
  PORTAL_SETUP_TOKEN_INVALID,
  PORTAL_SETUP_TOKEN_TTL_MS,
  type PortalSetupDelivery,
  type PortalSetupMailer,
} from "./portal/shared.js";

import * as deactivateProviderModule from "./commands/deactivate-provider.js";
import * as reactivateProviderModule from "./commands/reactivate-provider.js";
import * as registerProviderModule from "./commands/register-provider.js";
import * as recordProviderDeaRegistrationModule from "./commands/record-provider-dea-registration.js";
import * as recordProviderStateLicenseModule from "./commands/record-provider-state-license.js";
import * as revokeProviderCredentialModule from "./commands/revoke-provider-credential.js";
import * as updateProviderModule from "./commands/update-provider.js";

export const providers = {
  commands: {
    RegisterProvider: registerProviderModule.RegisterProvider,
    UpdateProvider: updateProviderModule.UpdateProvider,
    DeactivateProvider: deactivateProviderModule.DeactivateProvider,
    ReactivateProvider: reactivateProviderModule.ReactivateProvider,
    RecordProviderDeaRegistration:
      recordProviderDeaRegistrationModule.RecordProviderDeaRegistration,
    RecordProviderStateLicense: recordProviderStateLicenseModule.RecordProviderStateLicense,
    RevokeProviderCredential: revokeProviderCredentialModule.RevokeProviderCredential,
  },
} as const;
