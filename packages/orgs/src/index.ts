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

import * as createOrganizationModule from "./commands/create-organization.js";
import * as provisionDefaultBucketsModule from "./commands/provision-default-buckets.js";

export const orgs = {
  commands: {
    CreateOrganization: createOrganizationModule.CreateOrganization,
    ProvisionDefaultBuckets: provisionDefaultBucketsModule.ProvisionDefaultBuckets,
  },
} as const;
