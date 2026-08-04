// Staleness of the live drug-knowledge release.
//
// NLM ships Prescribable Content MONTHLY. A deployment screening
// against a release from last spring is answering ingredient questions
// from a nomenclature that no longer matches what is being dispensed —
// silently, because every lookup still succeeds. Staleness therefore
// has to be an observable operational signal, not a property someone
// remembers to check.
//
// Where the signal surfaces (following the repo's existing pattern of
// boot-time statements for systemic screening facts — see the
// knowledge-source warning in apps/web/src/server/bootstrap.ts):
//
//   - apps/web logs a structured warning at boot when the live release
//     is stale or absent.
//   - the ingestion CLI prints the same assessment after every run and
//     when invoked with --check.
//
// PURE: callers pass the clock in.

/**
 * Monthly cadence plus slack for the NLM publishing date wobbling and
 * an operator being on holiday. Two consecutive missed releases is the
 * point where "we have not refreshed" stops being routine.
 */
export const RXNORM_STALENESS_THRESHOLD_DAYS = 75;

export interface StalenessAssessment {
  readonly stale: boolean;
  readonly ageDays: number;
  readonly thresholdDays: number;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export function assessRxnormStaleness(input: {
  readonly releasedOn: Date;
  readonly now: Date;
  readonly thresholdDays?: number;
}): StalenessAssessment {
  const thresholdDays = input.thresholdDays ?? RXNORM_STALENESS_THRESHOLD_DAYS;
  const ageDays = Math.floor((input.now.getTime() - input.releasedOn.getTime()) / MS_PER_DAY);
  return { stale: ageDays > thresholdDays, ageDays, thresholdDays };
}
