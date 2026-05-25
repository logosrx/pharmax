// Minimal structured-logging contract used across @pharmax/platform-core.
//
// Concrete implementations (pino, console, OpenTelemetry sink, etc.) live in
// the application layer. Platform-core code MUST depend only on this
// interface so that:
//   - tests can substitute a no-op or capturing logger,
//   - PHI never leaks through a logger that is not configured by the host,
//   - log redaction is the host's responsibility, not platform-core's.
//
// Calling code MUST NOT pass raw patient identifiers, decrypted PHI, or raw
// webhook payloads into `context`. The fields below are for safe structured
// metadata only (event ids, status codes, durations, counts).

export interface LogContext {
  readonly [key: string]: unknown;
}

export interface Logger {
  debug(message: string, context?: LogContext): void;
  info(message: string, context?: LogContext): void;
  warn(message: string, context?: LogContext): void;
  error(message: string, context?: LogContext): void;
  child(bindings: LogContext): Logger;
}

export const noopLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => noopLogger,
};
