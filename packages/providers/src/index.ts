// Public surface of @pharmax/providers.
//
// Convention mirrors @pharmax/orgs and @pharmax/patients:
//   - Each command file owns its input/output types.
//   - Commands re-exported individually AND under a `commands`
//     namespace for ergonomic batch imports.
//   - Future commands (UpdateProvider, DeactivateProvider,
//     SyncFromNpiRegistry) land alongside RegisterProvider in
//     `src/commands/` and re-export here.

export {
  RegisterProvider,
  type RegisterProviderInput,
  type RegisterProviderOutput,
} from "./commands/register-provider.js";

import * as registerProviderModule from "./commands/register-provider.js";

export const providers = {
  commands: {
    RegisterProvider: registerProviderModule.RegisterProvider,
  },
} as const;
