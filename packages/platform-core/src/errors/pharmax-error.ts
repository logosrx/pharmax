// Base error class for the entire Pharmax codebase.
//
// Why a hierarchy at all:
//   - Route handlers map exceptions to HTTP responses. Without a stable
//     category, every route would need a per-error switch statement.
//   - The command bus distinguishes "expected" errors (validation,
//     authorization, state conflict) from "unexpected" ones (internal
//     bugs) — the former go in `command_log.result_status = REJECTED`
//     without paging, the latter trigger Sentry/PagerDuty.
//   - Observability and audit logs need a stable machine-readable
//     `code` that won't change with copy-edits to the human message.
//
// PHI invariant: `message` and `metadata` MUST NOT contain decrypted
// patient identifiers. The structured logger redacts known fields as a
// safety net, but the contract puts the burden on the caller.

export type ErrorMetadata = Readonly<Record<string, unknown>>;

export interface PharmaxErrorInit {
  readonly code: string;
  readonly message: string;
  readonly metadata?: ErrorMetadata;
  readonly cause?: unknown;
}

export interface PharmaxErrorJson {
  readonly name: string;
  readonly code: string;
  readonly message: string;
  readonly httpStatus: number;
  readonly metadata: ErrorMetadata;
}

/**
 * Base error class. Direct construction is allowed but callers should
 * prefer a category subclass (`ValidationError`, etc.) so HTTP mapping
 * is correct without a custom case.
 */
export abstract class PharmaxError extends Error {
  public readonly code: string;
  public readonly metadata: ErrorMetadata;
  public abstract readonly httpStatus: number;

  // Errors fall into two operational buckets. "Expected" errors are
  // caller-fixable (bad input, missing permission, state guard) and
  // should NOT page. "Unexpected" errors indicate a bug or
  // infrastructure failure and SHOULD page.
  public abstract readonly category: "expected" | "unexpected";

  public constructor(init: PharmaxErrorInit) {
    super(init.message, init.cause === undefined ? undefined : { cause: init.cause });
    this.code = init.code;
    this.metadata = Object.freeze({ ...(init.metadata ?? {}) });
    // Default to the subclass name. The bus/logger uses `name` for
    // labels; subclasses set it in their constructor.
    this.name = new.target.name;
    // V8: keep stack trace pointing at construction site, not here.
    if ("captureStackTrace" in Error && typeof Error.captureStackTrace === "function") {
      Error.captureStackTrace(this, new.target);
    }
  }

  /**
   * JSON-safe projection. Intentionally excludes `cause` and `stack` —
   * those chains can transitively serialize HTTP responses, DB rows,
   * and other PHI-adjacent payloads. The command bus captures stack +
   * cause separately into its own write path (with PHI scrubbing).
   */
  public toJSON(): PharmaxErrorJson {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      httpStatus: this.httpStatus,
      metadata: this.metadata,
    };
  }
}

export function isPharmaxError(value: unknown): value is PharmaxError {
  return value instanceof PharmaxError;
}
