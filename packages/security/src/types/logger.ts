// Re-export the Logger contract from @pharmax/platform-core so the
// internal modules of this package can import a single short name
// instead of repeating the `import type { logger as loggerContract }`
// dance at every call site. Pure re-export — no logic.

import type { logger as loggerContract } from "@pharmax/platform-core";

export type Logger = loggerContract.Logger;
export type LogContext = loggerContract.LogContext;
