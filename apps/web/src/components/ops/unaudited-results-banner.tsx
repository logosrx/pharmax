// The banner a search surface shows for results it WITHHELD because
// their ViewPatient audit could not be recorded.
//
// Wording is the load-bearing part, which is why this is one shared
// component rather than two page-local banners (the divergence issue
// #79 closed must not creep back in through copy drift):
//
//   - It says the rows were HIDDEN, not that data was shown without a
//     record — the old banner apologized for a disclosure; this one
//     states that no disclosure happened.
//   - It names no patient. The withheld rows are exactly the ones
//     with no audit trail, so identifying them here would be the
//     disclosure the suppression exists to prevent.
//   - It carries the operator id and an instruction, because an
//     audit-write failure means the audit path is down — a platform
//     incident to report, not a retry-until-it-works inconvenience.

import { Banner } from "../ui/feedback.js";

/**
 * Renders nothing when nothing was suppressed. `attempted` is the
 * batch's attempted count, so the banner can say "N of M".
 */
export function UnauditedResultsBanner({
  suppressedCount,
  attempted,
  operatorUserId,
}: {
  readonly suppressedCount: number;
  readonly attempted: number;
  readonly operatorUserId: string;
}) {
  if (suppressedCount === 0) return null;
  return (
    <Banner
      tone="danger"
      title={`${suppressedCount} of ${attempted} results hidden — their view audit could not be recorded`}
    >
      Patient identity is only displayed once a tamper-evident view audit is on record, and the
      audit write failed for {suppressedCount === 1 ? "one result" : `${suppressedCount} results`}.
      Nothing about {suppressedCount === 1 ? "that patient" : "those patients"} was rendered. Search
      again to retry; if this persists, the audit path is down — report it with operator id{" "}
      <code>{operatorUserId}</code>.
    </Banner>
  );
}
