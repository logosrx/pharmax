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
  UpdatePharmacySiteAddress,
  PHARMACY_SITE_NOT_FOUND,
  type UpdatePharmacySiteAddressInput,
  type UpdatePharmacySiteAddressOutput,
} from "./commands/update-pharmacy-site-address.js";

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

import * as createOrganizationModule from "./commands/create-organization.js";
import * as provisionDefaultBucketsModule from "./commands/provision-default-buckets.js";
import * as updatePharmacySiteAddressModule from "./commands/update-pharmacy-site-address.js";
import * as inviteUserModule from "./commands/invite-user.js";
import * as assignRoleModule from "./commands/assign-role.js";
import * as revokeUserRoleModule from "./commands/revoke-user-role.js";

export const orgs = {
  commands: {
    CreateOrganization: createOrganizationModule.CreateOrganization,
    ProvisionDefaultBuckets: provisionDefaultBucketsModule.ProvisionDefaultBuckets,
    UpdatePharmacySiteAddress: updatePharmacySiteAddressModule.UpdatePharmacySiteAddress,
    InviteUser: inviteUserModule.InviteUser,
    AssignRole: assignRoleModule.AssignRole,
    RevokeUserRole: revokeUserRoleModule.RevokeUserRole,
  },
} as const;
