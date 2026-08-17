// Typing workbench projection — drives `/ops/typing/[orderId]`.
//
// The typing stage was the only workflow stage without a per-order
// surface: the queue could claim and complete an order, but there was
// nowhere to actually review the transcription. This projection is that
// surface, and it exists mainly to carry the AI review loop — the
// technician requests a review here, and accepts or dismisses each
// field-level proposal here.
//
// What it returns:
//   - The order header (id, status, version, assignee)
//   - Per prescription on the order: drug identity plus the STRUCTURED
//     draft fields, which are exactly the fields a suggestion may
//     target (see `TYPING_SUGGESTION_FIELD_SPECS`)
//   - Per prescription: the latest suggestion run with its gate verdict
//     and model telemetry, its open proposals, and its resolved ones
//   - Whether the org has typing assist enabled at all
//
// PHI: nothing decrypted here, and no patient identity — same split the
// fill workbench uses. The sig is the one free-text field a typist
// cares about and it lives on `/ops/orders/[id]`, which carries the
// ViewPatient audit that displaying it requires. That is not a
// limitation of this page so much as its shape: every field the AI
// panel can act on is a structured non-PHI column by construction, so
// the review surface can be non-PHI too.
//
// The order `version` returned here is load-bearing, not decoration:
// the accept form submits it as `expectedOrderVersion`, so a proposal
// accepted from a stale render CAS-conflicts instead of overwriting
// whatever moved in the meantime.

import "server-only";

import {
  readInOrgScope,
  type ControlledSubstanceSchedule,
  type DoseUnit,
  type OrderStatus,
  type Prisma,
  type SigStructureKind,
  type TypingSuggestionRunStatus,
  type TypingSuggestionSource,
  type TypingSuggestionStatus,
} from "@pharmax/database";

/** How many resolved proposals to show per prescription, newest first. */
const RESOLVED_HISTORY_LIMIT = 8;

export interface TypingWorkbenchDraft {
  readonly quantityAuthorized: string;
  readonly daysSupply: number;
  readonly refillsAuthorized: number;
  readonly refillsRemaining: number;
  readonly daw: number;
  readonly originalDateWritten: Date;
  readonly expiresAt: Date;
  readonly earliestFillDate: Date | null;
  readonly controlledSubstanceSchedule: ControlledSubstanceSchedule;
  readonly sigStructureKind: SigStructureKind | null;
  readonly doseAmount: string | null;
  readonly doseUnit: DoseUnit | null;
  readonly dosesPerDay: string | null;
}

export interface TypingWorkbenchSuggestion {
  readonly suggestionId: string;
  readonly source: TypingSuggestionSource;
  readonly status: TypingSuggestionStatus;
  /** Set on deterministic proposals; null on model ones. */
  readonly findingCode: string | null;
  readonly field: string;
  /** Display forms — the raw JSON values never reach the page. */
  readonly currentValue: string;
  readonly suggestedValue: string;
  readonly rationale: string;
  readonly confidencePercent: number | null;
  readonly dismissReasonCode: string | null;
  readonly resolvedAt: Date | null;
}

export interface TypingWorkbenchRun {
  readonly runId: string;
  readonly status: TypingSuggestionRunStatus;
  readonly modelSuggestionsPermitted: boolean;
  readonly modelSkipReasonCode: string | null;
  readonly failureCode: string | null;
  readonly deterministicFindingCount: number;
  readonly minConfidencePercent: number | null;
  readonly provider: string | null;
  readonly modelId: string | null;
  /** True when the PHI tripwire withheld the sig from the prompt. */
  readonly sigOmittedByPhiTripwire: boolean;
  readonly createdAt: Date;
  readonly completedAt: Date | null;
}

export interface TypingWorkbenchLine {
  readonly orderLineId: string;
  readonly prescriptionId: string;
  readonly rxNumber: string;
  readonly drugNdc: string;
  readonly drugName: string;
  readonly drugStrength: string | null;
  readonly drugForm: string | null;
  readonly draft: TypingWorkbenchDraft;
  /** Newest run for this prescription, or null if never reviewed. */
  readonly latestRun: TypingWorkbenchRun | null;
  /** PROPOSED proposals awaiting the technician's decision. */
  readonly openSuggestions: ReadonlyArray<TypingWorkbenchSuggestion>;
  /** Recently accepted / dismissed / superseded, newest first. */
  readonly resolvedSuggestions: ReadonlyArray<TypingWorkbenchSuggestion>;
}

export interface TypingWorkbench {
  readonly orderId: string;
  readonly externalOrderNumber: string | null;
  readonly currentStatus: OrderStatus;
  readonly version: number;
  readonly currentAssigneeUserId: string | null;
  readonly lines: ReadonlyArray<TypingWorkbenchLine>;
  /**
   * Org-level switch. False (or no policy row) means a review request
   * would record a MODEL_SKIPPED run — the page says so up front rather
   * than offering a button whose only outcome is a skip.
   */
  readonly typingAssistEnabled: boolean;
}

/**
 * Render a suggestion's JSON value as text.
 *
 * The value space is closed to JSON scalars by the field vocabulary, so
 * this handles exactly those: a null means "field is empty" on a
 * before-value and "clear this field" on an after-value, which is why
 * it renders as a word rather than an empty cell — an empty cell in a
 * proposal reads as a rendering bug.
 */
function displayValue(value: Prisma.JsonValue | null): string {
  if (value === null) return "(none)";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  // Objects/arrays cannot occur through the vocabulary; if one appears,
  // show something honest rather than "[object Object]".
  return JSON.stringify(value);
}

export async function getTypingWorkbench(input: {
  readonly organizationId: string;
  readonly orderId: string;
}): Promise<TypingWorkbench | null> {
  const { organizationId, orderId } = input;

  return readInOrgScope(organizationId, async (tx) => {
    const order = await tx.order.findFirst({
      where: { id: orderId, organizationId },
      select: {
        id: true,
        externalOrderNumber: true,
        currentStatus: true,
        version: true,
        currentAssigneeUserId: true,
      },
    });
    if (order === null) return null;

    const orderLines = await tx.orderLine.findMany({
      where: { organizationId, orderId: order.id },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        prescriptionId: true,
        prescription: {
          select: {
            id: true,
            rxNumber: true,
            drugNdc: true,
            drugName: true,
            drugStrength: true,
            drugForm: true,
            quantityAuthorized: true,
            daysSupply: true,
            refillsAuthorized: true,
            refillsRemaining: true,
            daw: true,
            originalDateWritten: true,
            expiresAt: true,
            earliestFillDate: true,
            controlledSubstanceSchedule: true,
            sigStructureKind: true,
            doseAmount: true,
            doseUnit: true,
            dosesPerDay: true,
          },
        },
      },
    });

    const policy = await tx.aiAssistPolicy.findFirst({
      where: { organizationId },
      select: { typingAssistEnabled: true },
    });

    // One suggestion query for the whole order rather than N per line:
    // the index is (organizationId, orderId, status), and a typing
    // order carries a handful of lines at most.
    const suggestions = await tx.typingSuggestion.findMany({
      where: { organizationId, orderId: order.id },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        prescriptionId: true,
        source: true,
        status: true,
        findingCode: true,
        field: true,
        currentValue: true,
        suggestedValue: true,
        rationale: true,
        confidencePercent: true,
        dismissReasonCode: true,
        resolvedAt: true,
      },
    });

    const runs = await tx.typingSuggestionRun.findMany({
      where: { organizationId, orderId: order.id },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        prescriptionId: true,
        status: true,
        modelSuggestionsPermitted: true,
        modelSkipReasonCode: true,
        failureCode: true,
        deterministicFindingCount: true,
        minConfidencePercent: true,
        provider: true,
        modelId: true,
        sigOmittedByPhiTripwire: true,
        createdAt: true,
        completedAt: true,
      },
    });

    // Runs arrive newest-first, so the first hit per prescription IS
    // the latest — no per-line query and no sort inside the loop.
    const latestRunByRx = new Map<string, TypingWorkbenchRun>();
    for (const run of runs) {
      if (latestRunByRx.has(run.prescriptionId)) continue;
      latestRunByRx.set(
        run.prescriptionId,
        Object.freeze({
          runId: run.id,
          status: run.status,
          modelSuggestionsPermitted: run.modelSuggestionsPermitted,
          modelSkipReasonCode: run.modelSkipReasonCode,
          failureCode: run.failureCode,
          deterministicFindingCount: run.deterministicFindingCount,
          minConfidencePercent: run.minConfidencePercent,
          provider: run.provider,
          modelId: run.modelId,
          sigOmittedByPhiTripwire: run.sigOmittedByPhiTripwire,
          createdAt: run.createdAt,
          completedAt: run.completedAt,
        })
      );
    }

    const project = (s: (typeof suggestions)[number]): TypingWorkbenchSuggestion =>
      Object.freeze({
        suggestionId: s.id,
        source: s.source,
        status: s.status,
        findingCode: s.findingCode,
        field: s.field,
        currentValue: displayValue(s.currentValue),
        suggestedValue: displayValue(s.suggestedValue),
        rationale: s.rationale,
        confidencePercent: s.confidencePercent,
        dismissReasonCode: s.dismissReasonCode,
        resolvedAt: s.resolvedAt,
      });

    const lines: TypingWorkbenchLine[] = orderLines.map((line) => {
      const rx = line.prescription;
      const mine = suggestions.filter((s) => s.prescriptionId === line.prescriptionId);
      return Object.freeze({
        orderLineId: line.id,
        prescriptionId: line.prescriptionId,
        rxNumber: rx.rxNumber,
        drugNdc: rx.drugNdc,
        drugName: rx.drugName,
        drugStrength: rx.drugStrength,
        drugForm: rx.drugForm,
        draft: Object.freeze({
          quantityAuthorized: String(rx.quantityAuthorized),
          daysSupply: rx.daysSupply,
          refillsAuthorized: rx.refillsAuthorized,
          refillsRemaining: rx.refillsRemaining,
          daw: rx.daw,
          originalDateWritten: rx.originalDateWritten,
          expiresAt: rx.expiresAt,
          earliestFillDate: rx.earliestFillDate,
          controlledSubstanceSchedule: rx.controlledSubstanceSchedule,
          sigStructureKind: rx.sigStructureKind,
          doseAmount: rx.doseAmount === null ? null : String(rx.doseAmount),
          doseUnit: rx.doseUnit,
          dosesPerDay: rx.dosesPerDay === null ? null : String(rx.dosesPerDay),
        }),
        latestRun: latestRunByRx.get(line.prescriptionId) ?? null,
        openSuggestions: mine.filter((s) => s.status === "PROPOSED").map(project),
        resolvedSuggestions: mine
          .filter((s) => s.status !== "PROPOSED")
          .slice(0, RESOLVED_HISTORY_LIMIT)
          .map(project),
      });
    });

    return Object.freeze({
      orderId: order.id,
      externalOrderNumber: order.externalOrderNumber,
      currentStatus: order.currentStatus,
      version: order.version,
      currentAssigneeUserId: order.currentAssigneeUserId,
      lines,
      typingAssistEnabled: policy?.typingAssistEnabled ?? false,
    });
  });
}
