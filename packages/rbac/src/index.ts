// Public surface of @pharmax/rbac.
//
// Two import styles supported:
//
//     // Named:
//     import { requirePermission, PERMISSIONS } from "@pharmax/rbac";
//     await requirePermission(PERMISSIONS.PV1_APPROVE);
//
//     // Namespaced:
//     import { rbac } from "@pharmax/rbac";
//     await rbac.requirePermission(rbac.PERMISSIONS.PV1_APPROVE);

export {
  ALL_PERMISSION_CODES,
  PERMISSIONS,
  PERMISSION_METADATA,
  isPermissionCode,
  type PermissionCode,
} from "./permissions.js";

export { ROLE_TEMPLATES, findRoleTemplate, type RoleTemplate } from "./role-templates.js";

export {
  ALL_FEATURE_CODES,
  FEATURES,
  FEATURE_METADATA,
  isFeatureCode,
  type FeatureCode,
} from "./features.js";

export {
  InMemoryFeatureFlagSource,
  clearFeatureCacheForTests,
  resolveEffectiveFeatures,
  type FeatureFlagLoadInput,
  type FeatureFlagSource,
} from "./feature-flags.js";

export {
  appliesInContext,
  unionPermissions,
  type GrantScope,
  type ResolvedGrant,
} from "./grants.js";

export {
  InMemoryPermissionLoader,
  type EffectivePermissionLoader,
  type PermissionLoadInput,
} from "./loader.js";

export { PrismaPermissionLoader } from "./prisma-permission-loader.js";

export { resolveEffectivePermissions, clearContextCacheForTests } from "./resolver.js";

export {
  configureRbac,
  getRbacConfiguration,
  resetRbacConfigurationForTests,
  type RbacConfiguration,
} from "./configure.js";

export {
  getEffectivePermissions,
  hasPermission,
  PERMISSION_DENIED,
  requirePermission,
} from "./require-permission.js";

export {
  SOD_RULES,
  SOD_VIOLATION,
  checkSoD,
  requireNoSoDViolation,
  type ResourceAct,
  type SoDRule,
  type SoDViolation,
} from "./separation-of-duties.js";

export {
  EmptyPermissionOverrideSource,
  getDeniedPermissionsWithReason,
  getEffectivePermissionsWithSource,
  type PermissionOverrideSource,
  type PermissionSource,
  type PermissionWithSource,
} from "./effective-with-source.js";

export {
  BREAK_GLASS_DEFAULT_MINUTES,
  BREAK_GLASS_MAX_MINUTES,
  BREAK_GLASS_REASONS,
  BREAK_GLASS_VALIDATION,
  buildBreakGlassGrant,
  grantBreakGlass,
  type BreakGlassGrant,
  type BreakGlassReason,
  type BreakGlassWriter,
} from "./break-glass.js";

export {
  PERMISSION_UNKNOWN,
  RBAC_NOT_CONFIGURED,
  permissionDeniedError,
  permissionUnknownError,
  rbacNotConfiguredError,
} from "./errors.js";

import * as breakGlassModule from "./break-glass.js";
import * as configureModule from "./configure.js";
import * as effectiveWithSourceModule from "./effective-with-source.js";
import * as errorsModule from "./errors.js";
import * as featureFlagsModule from "./feature-flags.js";
import * as featuresModule from "./features.js";
import * as grantsModule from "./grants.js";
import * as loaderModule from "./loader.js";
import * as permissionsModule from "./permissions.js";
import * as prismaLoaderModule from "./prisma-permission-loader.js";
import * as requireModule from "./require-permission.js";
import * as resolverModule from "./resolver.js";
import * as roleTemplatesModule from "./role-templates.js";
import * as sodModule from "./separation-of-duties.js";

export const rbac = {
  ...permissionsModule,
  ...roleTemplatesModule,
  ...featuresModule,
  ...featureFlagsModule,
  ...grantsModule,
  ...loaderModule,
  ...prismaLoaderModule,
  ...resolverModule,
  ...configureModule,
  ...requireModule,
  ...sodModule,
  ...effectiveWithSourceModule,
  ...breakGlassModule,
  ...errorsModule,
} as const;
