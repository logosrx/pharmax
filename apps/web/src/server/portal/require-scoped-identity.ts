// The guard every data-bearing /portal page opens with.
//
// Two redirects, in order:
//
//   no session      -> /portal/sign-in
//   no client yet   -> /portal/select-client
//
// Kept in one place because it is the kind of thing that gets copied
// almost right. A page that checked only for null would compile, run,
// and then hand an unscoped identity to a read helper — except that
// `readInClientScope` takes `PortalIdentityScoped`, so it would not
// compile after all. This helper is what makes satisfying that type
// a one-liner instead of an incentive to loosen it.
//
// `redirect()` throws, so callers can treat the return as always
// scoped.

import "server-only";

import { redirect } from "next/navigation";

import { getCurrentPortalIdentity, type PortalIdentityScoped } from "./current-session";

export async function requireScopedPortalIdentity(): Promise<PortalIdentityScoped> {
  const identity = await getCurrentPortalIdentity();
  if (identity === null) {
    redirect("/portal/sign-in");
  }
  if (identity.kind === "unscoped") {
    redirect("/portal/select-client");
  }
  return identity;
}
