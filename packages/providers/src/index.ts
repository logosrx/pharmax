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
// ENUMERATION_TYPE_MISMATCH) for the worker to act on. No IO. The
// HTTP client (slice 2), schema (slice 3), and worker (slice 4)
// will land in `src/npi-sync/` and re-export here as they ship.
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

import * as deactivateProviderModule from "./commands/deactivate-provider.js";
import * as reactivateProviderModule from "./commands/reactivate-provider.js";
import * as registerProviderModule from "./commands/register-provider.js";
import * as updateProviderModule from "./commands/update-provider.js";

export const providers = {
  commands: {
    RegisterProvider: registerProviderModule.RegisterProvider,
    UpdateProvider: updateProviderModule.UpdateProvider,
    DeactivateProvider: deactivateProviderModule.DeactivateProvider,
    ReactivateProvider: reactivateProviderModule.ReactivateProvider,
  },
} as const;
