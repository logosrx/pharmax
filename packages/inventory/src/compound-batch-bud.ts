// Beyond-Use Date evaluation for compounded batches (USP <797>).
//
// One predicate, three call sites: the dispensing command that
// enforces it, and the two read surfaces that badge it. They MUST
// agree — a console that greys out "Start dispensing" while the
// command would still accept it (or worse, the reverse) teaches
// operators that the UI lies.
//
// The subtlety that makes a shared predicate necessary:
// `beyondUseDate` is a Prisma `@db.Date`, so it arrives as midnight
// UTC of that calendar day (2027-07-02 → 2027-07-02T00:00:00Z).
// Comparing it against a wall-clock `new Date()` therefore reports
// "past BUD" from the first instant OF the BUD day, silently costing
// the batch its entire last legal day. The BUD is an inclusive
// through-date in USP <797> terms — stock is usable THROUGH that day
// — so the comparison has to floor now() to its UTC day first.
//
// UTC on both sides, deliberately: the stored value has no timezone
// to be local to, so introducing the site's zone here would make the
// same batch expire on different days for two readers.

/**
 * True when `now` falls strictly after the whole BUD calendar day.
 * The BUD day itself is dispensable.
 */
export function isPastBeyondUseDate(beyondUseDate: Date, now: Date): boolean {
  const todayUtcMidnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return beyondUseDate.getTime() < todayUtcMidnight;
}
