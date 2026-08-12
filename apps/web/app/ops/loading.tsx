// Segment-level loading boundary for every /ops page. Server pages in
// this console do real per-request work (tenancy + queue counts), so
// navigations get a structured shimmer instead of a frozen screen.

import { PageSkeleton } from "../../src/components/ui/skeleton.js";

export default function OpsLoading() {
  return <PageSkeleton />;
}
