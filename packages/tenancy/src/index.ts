// Public surface of @pharmax/tenancy.
//
// Consumers should generally import the namespace:
//
//     import { tenancy } from "@pharmax/tenancy";
//
//     await tenancy.withTenancyContext(ctx, async () => {
//       await clinicRepo.findById(id);
//     });
//
// Or, for the boot-time client wiring:
//
//     import { applyTenancyExtension } from "@pharmax/tenancy";
//     export const db = applyTenancyExtension(prisma);

export { buildTenancyContext, type TenancyActor, type TenancyContext } from "./context.js";

export {
  describeCurrentContext,
  getCurrentContext,
  getSystemContextReason,
  isSystemContext,
  requireCurrentContext,
  withSystemContext,
  withTenancyContext,
} from "./als.js";

export {
  TENANCY_CROSS_ORG_READ,
  TENANCY_CROSS_ORG_WRITE,
  TENANCY_NO_CONTEXT,
  tenancyCrossOrgWriteError,
  tenancyNoContextError,
} from "./errors.js";

export {
  TENANT_EXCLUDED_MODELS,
  TENANT_SCOPED_MODELS,
  resolveTenantFilterKind,
  type TenantFilterKind,
} from "./tenant-scoped-models.js";

export { applyTenancyExtension } from "./prisma-extension.js";

export { ScopedRepository, type AnyDelegate } from "./scoped-repository.js";

export {
  applyTenancySessionGuc,
  applySystemSessionGuc,
  clearSessionGuc,
  type SessionGucExecutor,
} from "./session-guc.js";

// Namespace export for callers that prefer `tenancy.withTenancyContext`.
import * as als from "./als.js";
import * as context from "./context.js";
import * as errors from "./errors.js";
import * as registry from "./tenant-scoped-models.js";
import * as extension from "./prisma-extension.js";
import * as repo from "./scoped-repository.js";
import * as sessionGuc from "./session-guc.js";

export const tenancy = {
  ...context,
  ...als,
  ...errors,
  ...registry,
  ...extension,
  ...repo,
  ...sessionGuc,
} as const;
