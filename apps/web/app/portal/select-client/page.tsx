// Client chooser — which practice is this prescriber acting for?
//
// Reached in two ways:
//
//   1. Straight after sign-in, when the prescriber has more than one
//      active affiliation. Their session carries no client yet and
//      `requireScopedPortalIdentity` bounces every other page here.
//   2. From the "Switch" link in the header, mid-session.
//
// Both post to the same route. Selecting revokes the current session
// and mints a new one scoped to the chosen client, so the cookie is
// replaced rather than a field edited — see SwitchPortalClinic.
//
// A prescriber with exactly one affiliation never sees this page: their
// session is minted already scoped at sign-in. One with none cannot
// sign in at all (PORTAL_NO_ACTIVE_CLINIC).
//
// PHI: none. Client names and codes only.

import { redirect } from "next/navigation";

import { BrandWordmark } from "../../../src/components/shell/brand.js";
import { getCurrentPortalIdentity } from "../../../src/server/portal/current-session.js";

export default async function Page({
  searchParams,
}: {
  readonly searchParams: Promise<{ readonly error?: string }>;
}) {
  const identity = await getCurrentPortalIdentity();
  if (identity === null) {
    redirect("/portal/sign-in");
  }

  const { error } = await searchParams;
  const options = identity.clinicOptions;
  const currentClinicId = identity.kind === "scoped" ? identity.activeClinic.clinicId : null;

  // A single option means there is nothing to choose. Land them on the
  // portal rather than showing a one-item list; if their session is
  // somehow unscoped, the switch route will scope it.
  if (options.length === 1 && identity.kind === "scoped") {
    redirect("/portal");
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-canvas px-4">
      <div className="w-full max-w-md space-y-6">
        <div className="flex items-center gap-3">
          <BrandWordmark className="h-5" />
          <span className="border-l border-line pl-3 text-sm font-semibold text-fg">
            Provider portal
          </span>
        </div>

        <section className="rounded-lg border border-line bg-surface">
          <div className="border-b border-line px-6 py-4">
            <h1 className="text-sm font-semibold text-fg">Choose a client practice</h1>
            <p className="mt-1 text-xs text-muted">
              You write for more than one practice. Pick the one you are working as — it determines
              which orders you see and which practice the pharmacy bills.
            </p>
          </div>

          {error !== undefined ? (
            <p
              role="alert"
              className="border-b border-line bg-canvas px-6 py-3 text-xs text-danger"
            >
              That practice is no longer available to you. Pick another, or contact the pharmacy.
            </p>
          ) : null}

          <ul className="divide-y divide-line">
            {options.map((option) => (
              <li key={option.clinicId}>
                <form action="/api/portal/v1/session/select-client" method="post">
                  <input type="hidden" name="clinicId" value={option.clinicId} />
                  <button
                    type="submit"
                    className="flex w-full items-center justify-between px-6 py-4 text-left hover:bg-canvas"
                  >
                    <span>
                      <span className="block text-sm font-medium text-fg">{option.name}</span>
                      <span className="block font-mono text-xs text-muted">{option.code}</span>
                    </span>
                    {option.clinicId === currentClinicId ? (
                      <span className="rounded-full border border-line px-2.5 py-0.5 text-xs text-muted">
                        Current
                      </span>
                    ) : (
                      <span aria-hidden className="text-muted">
                        &rarr;
                      </span>
                    )}
                  </button>
                </form>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </main>
  );
}
