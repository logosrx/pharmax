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
  // Node-only guard (official Next.js instrumentation pattern).
  //
  // `register()` is invoked in BOTH the Node.js and Edge runtimes
  // (the latter because `proxy.ts` middleware runs on Edge). `bootstrap`
  // pulls in node-only subsystems (OpenTelemetry sdk-node + gRPC
  // exporters, the Prisma client, ioredis) that cannot compile for the
  // Edge runtime — `node:stream`/`fs`/`tls` don't resolve there, which
  // crashes the whole dev server.
  //
  // The bootstrap import MUST live inside a POSITIVE
  // `=== "nodejs"` block: Next's bundler statically replaces
  // `process.env.NEXT_RUNTIME` per-compile, so this branch is
  // dead-code-eliminated from the Edge bundle and the node-only graph
  // is never compiled there. (An early `!== "nodejs"` return does NOT
  // trigger that elimination.) The KMS/RBAC/command-bus boot is only
  // meaningful in the Node runtime anyway.
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { bootstrap } = await import("./src/server/bootstrap.js");
    await bootstrap();
  }
}
