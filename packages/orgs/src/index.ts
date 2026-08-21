// Public surface of @pharmax/orgs.
//
// Convention for future domain packages (@pharmax/orders,
// @pharmax/verification, @pharmax/billing, etc.):
//
//   - Commands are exported individually AND under a `commands`
//     namespace.
//   - Each command declares its input/output types from its file
//     and re-exports them here.
//   - Domain types (Organization aggregate views, etc.) live in
//     `src/types.ts`.

export {
  CreateOrganization,
  type CreateOrganizationInput,
  type CreateOrganizationOutput,
} from "./commands/create-organization.js";

export {
  ProvisionDefaultBuckets,
  DEFAULT_BUCKET_CODES,
  type DefaultBucketCode,
  type ProvisionDefaultBucketsInput,
  type ProvisionDefaultBucketsOutput,
} from "./commands/provision-default-buckets.js";

export {
  CreateBucket,
  CREATE_BUCKET_CODE_ALREADY_EXISTS,
  CREATE_BUCKET_CODE_RESERVED,
  CREATE_BUCKET_KIND_RESERVED,
  CREATE_BUCKET_SITE_NOT_IN_ORG,
  CREATE_BUCKET_CLINIC_NOT_IN_ORG,
  CREATE_BUCKET_TEAM_NOT_IN_ORG,
  type CreateBucketInput,
  type CreateBucketOutput,
} from "./commands/create-bucket.js";

export {
  UpdateBucket,
  UPDATE_BUCKET_NOT_FOUND,
  UPDATE_BUCKET_SYSTEM_FIELD_IMMUTABLE,
  UPDATE_BUCKET_KIND_RESERVED,
  type UpdateBucketInput,
  type UpdateBucketOutput,
  type UpdateBucketField,
} from "./commands/update-bucket.js";

export {
  DeleteBucket,
  DELETE_BUCKET_NOT_FOUND,
  DELETE_BUCKET_IS_SYSTEM,
  DELETE_BUCKET_HAS_ORDERS,
  type DeleteBucketInput,
  type DeleteBucketOutput,
} from "./commands/delete-bucket.js";

export {
  ASSIGNABLE_BUCKET_KINDS,
  BUCKET_CODE_REGEX,
  RESERVED_BUCKET_CODES,
  RESERVED_BUCKET_KINDS,
  SYSTEM_BUCKET_MUTABLE_FIELDS,
  isReservedBucketCode,
  isReservedBucketKind,
} from "./buckets/bucket-guards.js";

export {
  UpdatePharmacySiteAddress,
  PHARMACY_SITE_NOT_FOUND,
  type UpdatePharmacySiteAddressInput,
  type UpdatePharmacySiteAddressOutput,
} from "./commands/update-pharmacy-site-address.js";

export {
  RecordSiteCredential,
  RECORD_SITE_CREDENTIAL_EXPIRY_BEFORE_ISSUE,
  RECORD_SITE_CREDENTIAL_SITE_NOT_FOUND,
  RECORD_SITE_CREDENTIAL_STATE_NOT_ALLOWED,
  RECORD_SITE_CREDENTIAL_STATE_REQUIRED,
  RECORD_SITE_CREDENTIAL_UNKNOWN_STATE,
  type RecordSiteCredentialInput,
  type RecordSiteCredentialOutput,
} from "./commands/record-site-credential.js";

export {
  SetSiteAuthorizedShipStates,
  SET_SHIP_STATES_DUPLICATE_STATE,
  SET_SHIP_STATES_NO_LICENSE,
  SET_SHIP_STATES_SITE_NOT_FOUND,
  SET_SHIP_STATES_UNKNOWN_STATE,
  type SetSiteAuthorizedShipStatesInput,
  type SetSiteAuthorizedShipStatesOutput,
} from "./commands/set-site-authorized-ship-states.js";

export {
  CreateClinic,
  CLINIC_CODE_REGEX,
  CREATE_CLINIC_CODE_ALREADY_EXISTS,
  CREATE_CLINIC_DUPLICATE_SITE,
  CREATE_CLINIC_SITE_NOT_IN_ORG,
  type CreateClinicInput,
  type CreateClinicOutput,
} from "./commands/create-clinic.js";

export {
  UpdateClinic,
  UPDATE_CLINIC_ARCHIVED,
  UPDATE_CLINIC_NOT_FOUND,
  type UpdateClinicInput,
  type UpdateClinicOutput,
} from "./commands/update-clinic.js";

export {
  SetClinicStatus,
  SET_CLINIC_STATUS_ALREADY_SET,
  SET_CLINIC_STATUS_ILLEGAL_TRANSITION,
  SET_CLINIC_STATUS_NOT_FOUND,
  SET_CLINIC_STATUS_ORDERS_IN_FLIGHT,
  type SetClinicStatusInput,
  type SetClinicStatusOutput,
} from "./commands/set-clinic-status.js";

export {
  AffiliateProviderWithClinic,
  AFFILIATE_PROVIDER_ALREADY_AFFILIATED,
  AFFILIATE_PROVIDER_CLINIC_NOT_ACTIVE,
  AFFILIATE_PROVIDER_CLINIC_NOT_FOUND,
  AFFILIATE_PROVIDER_NOT_ACTIVE,
  AFFILIATE_PROVIDER_NOT_FOUND,
  type AffiliateProviderWithClinicInput,
  type AffiliateProviderWithClinicOutput,
} from "./commands/affiliate-provider-with-clinic.js";

export {
  EndProviderClinicAffiliation,
  END_AFFILIATION_ALREADY_ENDED,
  END_AFFILIATION_NOT_FOUND,
  type EndProviderClinicAffiliationInput,
  type EndProviderClinicAffiliationOutput,
} from "./commands/end-provider-clinic-affiliation.js";

export { InviteUser, type InviteUserInput, type InviteUserOutput } from "./commands/invite-user.js";

export {
  AssignRole,
  ASSIGN_ROLE_USER_NOT_FOUND,
  ASSIGN_ROLE_ROLE_NOT_FOUND,
  ASSIGN_ROLE_SCOPE_REQUIRES_SITE,
  ASSIGN_ROLE_SCOPE_REQUIRES_CLINIC,
  ASSIGN_ROLE_SCOPE_REQUIRES_TEAM,
  ASSIGN_ROLE_SCOPE_NOT_ALLOWED,
  ASSIGN_ROLE_SITE_NOT_IN_ORG,
  USER_ROLE_ALREADY_GRANTED,
  type AssignRoleInput,
  type AssignRoleOutput,
} from "./commands/assign-role.js";

export {
  RevokeUserRole,
  USER_ROLE_NOT_FOUND,
  type RevokeUserRoleInput,
  type RevokeUserRoleOutput,
} from "./commands/revoke-user-role.js";

export {
  CreateRole,
  CREATE_ROLE_CODE_ALREADY_EXISTS,
  CREATE_ROLE_UNKNOWN_PERMISSION,
  CREATE_ROLE_PERMISSION_NOT_SEEDED,
  type CreateRoleInput,
  type CreateRoleOutput,
} from "./commands/create-role.js";

export {
  UpdateRolePermissions,
  UPDATE_ROLE_PERMISSIONS_ROLE_NOT_FOUND,
  UPDATE_ROLE_PERMISSIONS_ROLE_IS_SYSTEM,
  UPDATE_ROLE_PERMISSIONS_UNKNOWN_PERMISSION,
  UPDATE_ROLE_PERMISSIONS_NOT_SEEDED,
  type UpdateRolePermissionsInput,
  type UpdateRolePermissionsOutput,
} from "./commands/update-role-permissions.js";

export {
  UpsertWorkflowPolicyOverlay,
  UPSERT_OVERLAY_ACTIVE_RACE,
  UPSERT_OVERLAY_BASE_POLICY_NOT_FOUND,
  UPSERT_OVERLAY_BASE_POLICY_NOT_READABLE,
  UPSERT_OVERLAY_BASE_POLICY_UNSUPPORTED,
  UPSERT_OVERLAY_CLINIC_NOT_FOUND,
  type UpsertWorkflowPolicyOverlayInput,
  type UpsertWorkflowPolicyOverlayOutput,
} from "./commands/upsert-workflow-policy-overlay.js";

import * as createOrganizationModule from "./commands/create-organization.js";
import * as provisionDefaultBucketsModule from "./commands/provision-default-buckets.js";
import * as createBucketModule from "./commands/create-bucket.js";
import * as updateBucketModule from "./commands/update-bucket.js";
import * as deleteBucketModule from "./commands/delete-bucket.js";
import * as updatePharmacySiteAddressModule from "./commands/update-pharmacy-site-address.js";
import * as createClinicModule from "./commands/create-clinic.js";
import * as recordSiteCredentialModule from "./commands/record-site-credential.js";
import * as setSiteAuthorizedShipStatesModule from "./commands/set-site-authorized-ship-states.js";
import * as updateClinicModule from "./commands/update-clinic.js";
import * as setClinicStatusModule from "./commands/set-clinic-status.js";
import * as affiliateProviderWithClinicModule from "./commands/affiliate-provider-with-clinic.js";
import * as endProviderClinicAffiliationModule from "./commands/end-provider-clinic-affiliation.js";
import * as inviteUserModule from "./commands/invite-user.js";
import * as assignRoleModule from "./commands/assign-role.js";
import * as revokeUserRoleModule from "./commands/revoke-user-role.js";
import * as createRoleModule from "./commands/create-role.js";
import * as updateRolePermissionsModule from "./commands/update-role-permissions.js";
import * as upsertWorkflowPolicyOverlayModule from "./commands/upsert-workflow-policy-overlay.js";

export const orgs = {
  commands: {
    CreateOrganization: createOrganizationModule.CreateOrganization,
    ProvisionDefaultBuckets: provisionDefaultBucketsModule.ProvisionDefaultBuckets,
    CreateBucket: createBucketModule.CreateBucket,
    UpdateBucket: updateBucketModule.UpdateBucket,
    DeleteBucket: deleteBucketModule.DeleteBucket,
    UpdatePharmacySiteAddress: updatePharmacySiteAddressModule.UpdatePharmacySiteAddress,
    CreateClinic: createClinicModule.CreateClinic,
    RecordSiteCredential: recordSiteCredentialModule.RecordSiteCredential,
    SetSiteAuthorizedShipStates: setSiteAuthorizedShipStatesModule.SetSiteAuthorizedShipStates,
    UpdateClinic: updateClinicModule.UpdateClinic,
    SetClinicStatus: setClinicStatusModule.SetClinicStatus,
    AffiliateProviderWithClinic: affiliateProviderWithClinicModule.AffiliateProviderWithClinic,
    EndProviderClinicAffiliation: endProviderClinicAffiliationModule.EndProviderClinicAffiliation,
    InviteUser: inviteUserModule.InviteUser,
    AssignRole: assignRoleModule.AssignRole,
    RevokeUserRole: revokeUserRoleModule.RevokeUserRole,
    CreateRole: createRoleModule.CreateRole,
    UpdateRolePermissions: updateRolePermissionsModule.UpdateRolePermissions,
    UpsertWorkflowPolicyOverlay: upsertWorkflowPolicyOverlayModule.UpsertWorkflowPolicyOverlay,
  },
} as const;
