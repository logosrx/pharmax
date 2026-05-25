// The landing page is intentionally minimal: it confirms the app is up
// and links to the operational endpoints that DO exist today. The real
// operations console arrives in Phase 1 / 2.

const PIPELINE: ReadonlyArray<{ stage: string; status: string }> = [
  { stage: "Received", status: "scaffolded" },
  { stage: "Typing", status: "pending" },
  { stage: "PV1", status: "pending" },
  { stage: "Filling", status: "pending" },
  { stage: "Final Verification", status: "pending" },
  { stage: "Ready to Ship", status: "pending" },
  { stage: "Shipped", status: "pending" },
];

const ENDPOINTS: ReadonlyArray<{ path: string; description: string }> = [
  { path: "/api/health", description: "Liveness probe" },
  { path: "/api/webhooks/stripe", description: "Stripe webhook receiver (POST only)" },
];

export default function HomePage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-12 px-6 py-16">
      <header className="space-y-3">
        <p className="text-xs font-medium uppercase tracking-[0.2em] text-neutral-500">Phase 0</p>
        <h1 className="text-4xl font-semibold tracking-tight text-neutral-50">Pharmax</h1>
        <p className="text-base text-neutral-400">
          Enterprise pharmacy operating system. The operations console is not built yet — this
          surface only confirms the platform is up and that the wiring between the web tier,
          Postgres, and the billing module is sound.
        </p>
      </header>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-neutral-400">
          Workflow pipeline
        </h2>
        <ol className="divide-y divide-neutral-800 overflow-hidden rounded-lg border border-neutral-800 bg-neutral-950">
          {PIPELINE.map((step, index) => (
            <li key={step.stage} className="flex items-center justify-between px-4 py-3 text-sm">
              <span className="flex items-center gap-3">
                <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-neutral-800 text-xs text-neutral-400">
                  {index + 1}
                </span>
                <span className="text-neutral-100">{step.stage}</span>
              </span>
              <span className="text-xs uppercase tracking-wider text-neutral-500">
                {step.status}
              </span>
            </li>
          ))}
        </ol>
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-neutral-400">
          Endpoints
        </h2>
        <ul className="space-y-2">
          {ENDPOINTS.map((endpoint) => (
            <li
              key={endpoint.path}
              className="flex items-center justify-between rounded-md border border-neutral-800 bg-neutral-950 px-4 py-3 text-sm"
            >
              <code className="text-neutral-100">{endpoint.path}</code>
              <span className="text-neutral-500">{endpoint.description}</span>
            </li>
          ))}
        </ul>
      </section>

      <footer className="text-xs text-neutral-600">
        Synthetic data only. No PHI. Local development build.
      </footer>
    </main>
  );
}
