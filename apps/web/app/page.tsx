// Root route. Authenticated visitors land on the operator dashboard
// (which lives inside the /ops shell); unauthenticated visitors never
// reach here — `proxy.ts` bounces them to /sign-in first.
//
// The dashboard, not-provisioned, and inactive states are all handled
// by the /ops segment (layout + page), so the root simply forwards
// there and keeps a single source of truth for the landing surface.

import { redirect } from "next/navigation";

export default function RootPage() {
  redirect("/ops");
}
