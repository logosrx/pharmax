// The PV1 clinical-screening findings for one order, projected for
// the pharmacist who is looking at them.
//
// READS THE ROWS; NEVER RE-RUNS THE ENGINE. The pharmacist has to see
// what the gate will evaluate, and the gate evaluates persisted
// fingerprints. Screening in the console would produce a second,
// independent answer — computed from a different transaction, possibly
// against a different knowledge source — and the acknowledge command
// refuses any fingerprint that was not persisted for this order, so a
// re-screened panel would offer controls that fail on submit. Worse,
// it could show a clean panel for an order the gate is about to block.
//
// THE LATEST SCREEN, NOT THE WHOLE HISTORY. `order_screening_finding`
// is insert-only: StartPV1 writes a set, a re-claim writes another,
// and a successful ApprovePV1 writes the set the approval was made
// against. Every row of one screen shares that screen's
// `commandLogId`, which is what groups them here. Showing the union
// across screens would resurrect findings a re-screen has already
// dropped — an alert whose clinical situation no longer exists, which
// is the fastest way to teach a pharmacist that this panel is noise.
//
// ACKNOWLEDGEMENTS ARE READ FOR THE VIEWER AND NOBODY ELSE. The gate
// is per-pharmacist, so a colleague's acknowledgement does not open it
// — and a panel that rendered one as settled would tell the viewer
// they had nothing left to decide right up until their approval was
// refused. The query is filtered on the viewer's user id rather than
// filtered after the fact, so there is no shape of this projection
// that holds another pharmacist's judgement at all.
//
// PATIENT-SCOPED COVERAGE IS SHOWN, NEVER SILENT. A patient-record
// gap (today: "no allergy history recorded") the viewer has already
// acknowledged FOR THIS PATIENT does not prompt again — but a safety
// prompt that is suppressed invisibly reads as "screened clean",
// which it is not. So the projection classifies those findings with
// the SAME `asPatientRecordGap` the gate uses, reads the viewer's
// patient-scoped acknowledgements, and reports one of three states
// the panel must render: COVERED ("acknowledged for this patient by
// you on <date>"), SUPERSEDED ("you acknowledged this, but the
// patient's record has changed since — it needs a fresh judgement"),
// or NONE (prompt, exactly as before). COVERED is decided against the
// patient's CURRENT record-state token, so this panel and the
// ApprovePV1 gate cannot disagree about what is settled.
//
// PHI: nothing here is PHI. A finding carries no patient identifier
// and no drug name by construction (see the header of
// `packages/clinical-screening/src/findings.ts`); `reason` is
// templated from codes by the engine and `triggers` holds coded
// concepts plus opaque record ids.

import "server-only";

import {
  gapRemediationForFindingCode,
  gapRemediationFromSeverity,
  SCREENING_SEVERITIES,
  severityRank,
  type ScreeningSeverity,
} from "@pharmax/clinical-screening";
import {
  readInOrgScope,
  type ScreeningPhase,
  type TenantTransactionClient,
} from "@pharmax/database";
import { asPatientRecordGap, patientRecordStateToken } from "@pharmax/verification";

/**
 * Cap on the rows scanned to find the latest screen.
 *
 * One screen produces a handful of findings and an order is screened a
 * small number of times, so this is generous. It is a `take` rather
 * than a refusal because the rows are ordered NEWEST FIRST: the latest
 * screen is always complete within the window, and what truncation can
 * cost is older history this projection does not show anyway.
 */
const FINDING_SCAN_LIMIT = 400;

/**
 * Which audience a finding is addressed to, which is also who can
 * remedy it. The panel gives the three groups visibly different
 * treatment, because their lifetimes differ by orders of magnitude and
 * a control that looks identical across all three trains one reflex
 * for all three.
 *
 *   - CLINICAL — a real finding about this prescription. Rare,
 *     specific, and the entire point of the screen.
 *   - PRESCRIPTION_COVERAGE — a check that could not run for THIS
 *     subject's data: a drug this knowledge source does not hold, a
 *     dose whose units it could not compare, or a fact nobody recorded
 *     for this patient. Specific to this order, and somebody here can
 *     close it — so these are the gaps that still ask for an
 *     acknowledgement.
 *   - ORGANIZATION_COVERAGE — a check that could not (fully) run
 *     because the pharmacy's OWN reference data is incomplete: a
 *     compound whose formula has uncoded ingredient rows. Closable —
 *     but by the formulary team, once, org-wide, not by the
 *     pharmacist on this order, so it informs rather than interrupts.
 *     Shown in its own block so "your org can fix this" is never
 *     dressed as either "you must fix this" or "nobody can".
 *   - PLATFORM_CAPABILITY — a check Pharmax cannot perform for ANY
 *     order, because the input or the knowledge source does not exist
 *     in this deployment. Identical on every order until an engineer
 *     ships the capability or somebody buys a licence; no pharmacist
 *     can resolve it, and pretending otherwise is what turns an
 *     acknowledgement into a keystroke.
 *
 * All gap groups are recorded on every screen regardless of the
 * pharmacy's `minimumReportedSeverity` — the floor governs CLINICAL
 * findings only, so this panel can never show a screen as clean that
 * merely went unrecorded.
 */
export type ScreeningFindingGroup =
  "CLINICAL" | "PRESCRIPTION_COVERAGE" | "ORGANIZATION_COVERAGE" | "PLATFORM_CAPABILITY";

function isKnownSeverity(severity: string): severity is ScreeningSeverity {
  return (SCREENING_SEVERITIES as ReadonlyArray<string>).includes(severity);
}

/** One coded concept that contributed to a finding. */
export interface ScreeningTriggerCode {
  readonly source: string;
  readonly code: string;
}

export interface OrderScreeningFindingView {
  readonly findingId: string;
  readonly code: string;
  readonly kind: string;
  readonly severity: string;
  readonly certainty: string;
  readonly disposition: string;
  readonly fingerprint: string;
  /** Operator-facing sentence, templated from codes by the engine. */
  readonly reason: string;
  readonly citation: string | null;
  readonly triggers: ReadonlyArray<ScreeningTriggerCode>;
  readonly group: ScreeningFindingGroup;
  /**
   * True only when the VIEWING pharmacist has acknowledged this
   * fingerprint on this order. Never true on the strength of somebody
   * else's judgement.
   */
  readonly acknowledgedByViewer: boolean;
  /**
   * Patient-scoped coverage, for PATIENT-RECORD gaps only (`null` for
   * every other finding — clinical findings cannot carry it, by the
   * same classifier the gate uses).
   *
   *   - COVERED — the viewer acknowledged this gap for this patient
   *     and the patient's record has not changed since. The gate will
   *     pass it; the panel must SAY so rather than silently not
   *     prompting.
   *   - SUPERSEDED — the viewer acknowledged it, but the record has
   *     changed since (data arrived and was later retracted, or a new
   *     unscreenable entry landed). The gate will refuse; the panel
   *     explains why the prompt is back.
   *   - NONE — never acknowledged for this patient by the viewer.
   *
   * Always the viewer's own judgements; a colleague's patient-scoped
   * acknowledgement is invisible here for the same reason it is
   * order-scoped acknowledgements are.
   */
  readonly patientScopeCoverage:
    | { readonly kind: "COVERED"; readonly acknowledgedAt: Date }
    | { readonly kind: "SUPERSEDED"; readonly lastAcknowledgedAt: Date }
    | { readonly kind: "NONE" }
    | null;
  /**
   * Whether the console may offer this finding an acknowledge control.
   *
   * False for `HARD_STOP` — there is no override path, and the command
   * refuses to record one — and false for `INFORMATIONAL`, which asks
   * nothing of anybody. The panel renders NO control when this is
   * false rather than a disabled one: a greyed button still reads as
   * "there is a way through here", and for a hard stop there is not.
   */
  readonly acknowledgeable: boolean;
}

export interface OrderScreening {
  /** When the screen this panel shows was run. */
  readonly screenedAt: Date;
  readonly phase: ScreeningPhase;
  /** Most severe first, then a stable tiebreak — the engine's order. */
  readonly findings: ReadonlyArray<OrderScreeningFindingView>;
  readonly hardStopCount: number;
  /**
   * Findings that require an acknowledgement the VIEWER has not given.
   * This is what `ApprovePV1` will refuse on, so it is the number the
   * panel leads with.
   */
  readonly outstandingCount: number;
}

/**
 * Rank a severity that arrived as a `String` column.
 *
 * `severity` is TEXT in the database precisely so the vocabulary can
 * grow, which means this build can read a grade it does not know.
 * Sorting such a row to the bottom is the safe failure: it stays
 * visible, it just loses its claim on the top of the list.
 */
function rankOf(severity: string): number {
  return isKnownSeverity(severity) ? severityRank(severity) : 0;
}

/**
 * Grouped by REMEDIATION, recovered code-first and severity-second.
 *
 * MOST codes cannot answer this on their own. `SCR_ALLERGY_INPUT_UNAVAILABLE`
 * means "no allergy capture exists" today and will mean "nobody
 * recorded allergies for this patient" once it does;
 * `SCR_KNOWLEDGE_UNAVAILABLE` means "no database is provisioned" or
 * "this one code is missing from a working database". For those, a
 * code-based rule mislabels in both directions and the persisted
 * severity decides (`gapRemediationFromSeverity`).
 *
 * The compound-coverage codes are the exception: they were minted to
 * carry exactly ORGANIZATION_DATA, they grade MINOR, and MINOR's
 * severity-recovery answer is (and must remain, for historical rows)
 * PLATFORM_CAPABILITY. `gapRemediationForFindingCode` is consulted
 * FIRST for exactly this reason — without it the panel would tell a
 * pharmacist "nobody can close this" about their own formulary
 * team's backlog.
 *
 * An uninterpretable grading falls to PRESCRIPTION_COVERAGE — the
 * group that invites a look — because telling someone to check is a
 * cheaper error than telling them to ignore.
 */
function groupFor(kind: string, code: string, severity: string): ScreeningFindingGroup {
  if (kind !== "SCREENING_GAP") return "CLINICAL";
  const remediation =
    gapRemediationForFindingCode(code) ??
    (isKnownSeverity(severity) ? gapRemediationFromSeverity(severity) : null);
  if (remediation === "ORGANIZATION_DATA") return "ORGANIZATION_COVERAGE";
  return remediation === "PLATFORM_CAPABILITY" ? "PLATFORM_CAPABILITY" : "PRESCRIPTION_COVERAGE";
}

/**
 * Read the coded concepts out of the persisted `triggers` JSON.
 *
 * Tolerant on purpose: this column is written by the engine, but it is
 * `Json` and a row could predate a shape change. A finding whose
 * triggers cannot be read is still worth showing — the `reason` is the
 * part the pharmacist acts on — so an unreadable entry is dropped
 * rather than allowed to throw the page.
 */
function parseTriggers(raw: unknown): ReadonlyArray<ScreeningTriggerCode> {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: ScreeningTriggerCode[] = [];
  for (const entry of raw) {
    if (entry === null || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const code = record["code"];
    const source = record["source"];
    if (typeof code !== "string" || code.length === 0) continue;
    if (seen.has(code)) continue;
    seen.add(code);
    out.push(Object.freeze({ source: typeof source === "string" ? source : "", code }));
  }
  return Object.freeze(out);
}

export async function getOrderScreening(input: {
  readonly organizationId: string;
  readonly orderId: string;
  /** The pharmacist reading the panel. Only their acknowledgements count. */
  readonly pharmacistUserId: string;
  /** Optional shared tenant-scoped transaction; see `listOrdersInBucketByCode`. */
  readonly tx?: TenantTransactionClient;
}): Promise<OrderScreening | null> {
  const run = async (tx: TenantTransactionClient): Promise<OrderScreening | null> => {
    const rows = await tx.orderScreeningFinding.findMany({
      where: { organizationId: input.organizationId, orderId: input.orderId },
      select: {
        id: true,
        code: true,
        kind: true,
        severity: true,
        certainty: true,
        disposition: true,
        fingerprint: true,
        reason: true,
        citation: true,
        triggers: true,
        phase: true,
        commandLogId: true,
        occurredAt: true,
      },
      orderBy: [{ occurredAt: "desc" }, { createdAt: "desc" }],
      take: FINDING_SCAN_LIMIT,
    });

    const newest = rows[0];
    if (newest === undefined) return null;

    // One screen = one command, so the newest row's command groups it.
    const latest = rows.filter((row) => row.commandLogId === newest.commandLogId);

    const acknowledged = await tx.orderScreeningAcknowledgement.findMany({
      where: {
        organizationId: input.organizationId,
        orderId: input.orderId,
        pharmacistUserId: input.pharmacistUserId,
        fingerprint: { in: latest.map((row) => row.fingerprint) },
      },
      select: { fingerprint: true },
    });
    const settled = new Set(acknowledged.map((row) => row.fingerprint));

    const patientCoverage = await loadPatientScopeCoverage(tx, input, latest);

    const findings = latest
      .map((row) => {
        const acknowledgedByViewer = settled.has(row.fingerprint);
        const patientScopeCoverage = patientCoverage.get(row.fingerprint) ?? null;
        return Object.freeze({
          findingId: row.id,
          code: row.code,
          kind: row.kind,
          severity: row.severity,
          certainty: row.certainty,
          disposition: row.disposition,
          fingerprint: row.fingerprint,
          reason: row.reason,
          citation: row.citation,
          triggers: parseTriggers(row.triggers),
          group: groupFor(row.kind, row.code, row.severity),
          acknowledgedByViewer,
          patientScopeCoverage,
          // No control when the finding is settled at EITHER scope —
          // on this order by the viewer, or for this patient at the
          // current record state. Mirrors the gate exactly:
          // `outstandingCount` below is what ApprovePV1 will refuse
          // on, so the two must count the same rows.
          acknowledgeable:
            row.disposition === "REQUIRES_ACKNOWLEDGEMENT" &&
            !acknowledgedByViewer &&
            patientScopeCoverage?.kind !== "COVERED",
        });
      })
      // Most severe first, then code, then fingerprint — the ordering
      // `run-screen.ts` applies, so the panel lists findings in the
      // same order the engine and the event payload do.
      .sort((a, b) => {
        const bySeverity = rankOf(b.severity) - rankOf(a.severity);
        if (bySeverity !== 0) return bySeverity;
        const byCode = a.code.localeCompare(b.code);
        return byCode !== 0 ? byCode : a.fingerprint.localeCompare(b.fingerprint);
      });

    return Object.freeze({
      screenedAt: newest.occurredAt,
      phase: newest.phase,
      findings: Object.freeze(findings),
      hardStopCount: findings.filter((f) => f.disposition === "HARD_STOP").length,
      outstandingCount: findings.filter((f) => f.acknowledgeable).length,
    });
  };

  return input.tx !== undefined ? run(input.tx) : readInOrgScope(input.organizationId, run);
}

/**
 * Patient-scoped coverage for the PATIENT-RECORD gaps in one screen,
 * keyed by fingerprint. Findings that are not patient-record gaps are
 * absent — their view carries `patientScopeCoverage: null`.
 *
 * Classifies with `asPatientRecordGap` and hashes with
 * `patientRecordStateToken` — the gate's own functions — so "COVERED"
 * here and "settled" there are the same computation reading the same
 * rows, not two implementations free to drift.
 */
async function loadPatientScopeCoverage(
  tx: TenantTransactionClient,
  input: {
    readonly organizationId: string;
    readonly orderId: string;
    readonly pharmacistUserId: string;
  },
  latest: ReadonlyArray<{
    readonly kind: string;
    readonly code: string;
    readonly disposition: string;
    readonly fingerprint: string;
  }>
): Promise<
  ReadonlyMap<
    string,
    | { readonly kind: "COVERED"; readonly acknowledgedAt: Date }
    | { readonly kind: "SUPERSEDED"; readonly lastAcknowledgedAt: Date }
    | { readonly kind: "NONE" }
  >
> {
  const gaps = latest
    .map((row) => asPatientRecordGap(row))
    .filter((gap): gap is NonNullable<typeof gap> => gap !== null);
  if (gaps.length === 0) return new Map();

  const order = await tx.order.findFirst({
    where: { id: input.orderId, organizationId: input.organizationId },
    select: { patientId: true },
  });
  // A screen without a resolvable order is a tenancy mismatch the
  // caller has bigger problems with; report the safe state (prompt).
  if (order === null) {
    return new Map(gaps.map((gap) => [gap.fingerprint, { kind: "NONE" as const }]));
  }

  const rows = await tx.patientScreeningAcknowledgement.findMany({
    where: {
      organizationId: input.organizationId,
      patientId: order.patientId,
      pharmacistUserId: input.pharmacistUserId,
      fingerprint: { in: gaps.map((gap) => gap.fingerprint) },
    },
    select: { fingerprint: true, recordStateToken: true, acknowledgedAt: true },
    orderBy: { acknowledgedAt: "desc" },
  });

  const tokenByAxis = new Map<string, string>();
  for (const axis of new Set(gaps.map((gap) => gap.axis))) {
    tokenByAxis.set(
      axis,
      await patientRecordStateToken(
        { tx, organizationId: input.organizationId, patientId: order.patientId },
        axis
      )
    );
  }

  const out = new Map<
    string,
    | { readonly kind: "COVERED"; readonly acknowledgedAt: Date }
    | { readonly kind: "SUPERSEDED"; readonly lastAcknowledgedAt: Date }
    | { readonly kind: "NONE" }
  >();
  for (const gap of gaps) {
    const forFingerprint = rows.filter((row) => row.fingerprint === gap.fingerprint);
    const current = forFingerprint.find(
      (row) => row.recordStateToken === tokenByAxis.get(gap.axis)
    );
    if (current !== undefined) {
      out.set(gap.fingerprint, { kind: "COVERED", acknowledgedAt: current.acknowledgedAt });
    } else if (forFingerprint[0] !== undefined) {
      out.set(gap.fingerprint, {
        kind: "SUPERSEDED",
        lastAcknowledgedAt: forFingerprint[0].acknowledgedAt,
      });
    } else {
      out.set(gap.fingerprint, { kind: "NONE" });
    }
  }
  return out;
}
