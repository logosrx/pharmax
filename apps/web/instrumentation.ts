// Next.js instrumentation hook.
//
// `register()` runs exactly once per Node process at server start,
// BEFORE the first request is handled. This is the only correct place
// to wire process-wide singletons (KMS adapter, RBAC loader, command
// bus, OpenTelemetry exporters) — anywhere else risks repeated boot
// during HMR or per-request reconfiguration.
//
// We delegate to `src/server/bootstrap.ts` so the dev/test paths can
// import and call `bootstrap()` directly without dragging in the
// Next.js runtime hooks. Keep this file thin: every line that runs at
// boot must be reviewable in one place, and that place is
// `src/server/bootstrap.ts`.

export async function register(): Promise<void> {
  // `bootstrap` is server-only; importing it from this file (which is
  // also server-only by virtue of being instrumentation) keeps the
  // boundary clean. Awaited so the process does not begin handling
  // requests until KMS, RBAC, and the command bus are wired (and, in
  // production, the AwsKmsAdapter's IAM has been verified).
  const { bootstrap } = await import("./src/server/bootstrap.js");
  await bootstrap();
}
