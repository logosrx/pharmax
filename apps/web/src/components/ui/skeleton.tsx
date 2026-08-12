// Skeleton — shimmer placeholders for route-level loading states.
//
// `Skeleton` is the raw shimmer block (size it with h-*/w-* classes;
// the .skeleton component class in globals.css supplies the surface
// and animation). `PageSkeleton` is the canonical /ops loading
// composition — header, KPI row, and a list — used by the segment
// loading.tsx so every page transition feels engineered rather than
// blank.

import { cx } from "./cx.js";

export function Skeleton({ className }: { readonly className?: string }) {
  return <div aria-hidden className={cx("skeleton", className)} />;
}

export function PageSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading" className="animate-fade-in space-y-6" role="status">
      <div className="space-y-2.5">
        <Skeleton className="h-3 w-24" />
        <Skeleton className="h-7 w-64" />
        <Skeleton className="h-3.5 w-96 max-w-full" />
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="card-sheen rounded-lg border border-line bg-surface p-4">
            <Skeleton className="h-3 w-20" />
            <Skeleton className="mt-3 h-8 w-16" />
            <Skeleton className="mt-2.5 h-3 w-28" />
          </div>
        ))}
      </div>

      <div className="card-sheen overflow-hidden rounded-lg border border-line bg-surface">
        <div className="border-b border-line bg-surface-2/70 px-4 py-3">
          <Skeleton className="h-3 w-40" />
        </div>
        <div className="divide-y divide-line">
          {Array.from({ length: 6 }, (_, i) => (
            <div key={i} className="flex items-center gap-4 px-4 py-3.5">
              <Skeleton className="h-9 w-9 rounded-lg" />
              <div className="flex-1 space-y-2">
                <Skeleton className="h-3.5 w-1/3" />
                <Skeleton className="h-3 w-1/2" />
              </div>
              <Skeleton className="h-5 w-16 rounded-full" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
