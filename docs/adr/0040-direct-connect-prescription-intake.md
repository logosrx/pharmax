# 0040 — Direct-connect prescription intake via the partner API; Surescripts not adopted

- **Status:** Accepted
- **Date:** 2026-08-15
- **Deciders:** Product owner, Platform team, Compliance
- **Tags:** `intake`, `erx`, `partner-api`, `scope`

## Context

Prescriptions enter Pharmax through the ops-console typing surface
(`CreatePrescription` dispatched from the transcription form) and,
since ADR-0032, through the public v1 partner API
(`POST /api/v1/prescriptions`, which forwards to the same command with
`IntakeSourceKind.API`). Both channels are protected by the command bus
contract (ADR-0007): the DEA schedule comes from the product catalog,
the refill cap is checked at issuance, prescriber DEA is required for
controlled substances, the Rx number comes from the allocator, and PHI
never appears in `command_log`.

`docs/GO_LIVE_PROGRAM.md` listed Surescripts / NCPDP SCRIPT as Track B
annex work: "+6 wk of engineering plus 3–6 months of network
certification." As with ADR-0039, the absence has been read across
three readiness audits as "not started" rather than as a decision.

The commercial reality is different. Pharmax's target buyers are
prescribing clinics that want their own EHR (or the Pharmax provider
portal from ADR-0033) to write directly to Pharmax. They do not want
their prescriptions routed through Surescripts, and Pharmax does not
want the vendor relationship, the certification calendar, or the
NCPDP SCRIPT domain code. The partner API is not a placeholder for
Surescripts — it **is** the eRx surface.

## Decision

Prescriptions reach Pharmax through **direct connections to the
Pharmax platform**. The two ratified intake surfaces are:

- `POST /api/v1/prescriptions` — programmatic intake by clinics that
  connect their EHR straight to Pharmax, authenticated with a partner
  API key (ADR-0032) and scoped by `prescriptions.create`.
- The provider portal (ADR-0033) — interactive intake by prescribers
  who use Pharmax as their prescribing surface.

Both dispatch the same `CreatePrescription` command. Every safety
property (schedule, refill cap, DEA gate, allocator-issued Rx number,
PHI redaction) belongs to the command; intake channels stay thin.

**Surescripts / NCPDP SCRIPT / eRx clearinghouse integration is out
of scope.** Concretely:

- No `IntakeSourceKind.SURESCRIPTS`, no NCPDP SCRIPT XML parser, no
  Surescripts vendor contract, no SPI-directory sync, no NewRx /
  RefillRequest / CancelRx state machine, no `@pharmax/erx-network`
  package.
- New EHR partners integrate by consuming the partner API (or by
  running through the provider portal), not by pointing Surescripts
  at Pharmax.

This ADR is orthogonal to ADR-0037 (EPCS): controlled-substance
prescriber identity and 2FA signing credential requirements still
apply to whichever channel is used, and the CSP/CA-issued signing
credential is still someone else's regulated function.

## Consequences

**Easier.** No Surescripts vendor contract, no NCPDP SCRIPT
certification, no directory-of-record dependency, no
`erx-network` domain package. Prescribers get an idempotent, versioned,
audited intake surface with the same guarantees as the ops console.
The partner API is one code path with one test surface.

**Harder.** Pharmax cannot receive prescriptions from any prescriber
not enrolled in a partner-API integration or the provider portal.
Onboarding a new clinic is an integration project (their EHR calls
our API) or a portal-adoption project, not a Surescripts directory
flip. Prescribers using EHRs that only speak SCRIPT are unreachable
until the EHR agrees to add a direct integration or the prescriber
switches to the portal.

**Ongoing.** Every prescription intake path must dispatch
`CreatePrescription`; a route that reshapes the payload without going
through the command is a safety regression. The partner API's
rate/scope/idempotency contract (ADR-0032) **is** the eRx contract;
tightening one tightens the other. Prescriber identity proofing for
schedule II–V remains ADR-0037's problem, not this ADR's.

## Alternatives Considered

- **Adopt Surescripts.** Attractive because it plugs Pharmax into
  every major EHR without per-clinic integration. Rejected because
  the vendor contract + certification cycle (3–6 months calendar) +
  NCPDP SCRIPT parser + network-of-record retention and reversal
  handling all cost more than the target customers do, and the
  business does not need the network coverage that justifies that
  spend.
- **Hybrid** (direct API + optional Surescripts later). Attractive
  because it keeps the option open. Rejected because "optional" has
  an infinite half-life: the moment two intake surfaces exist,
  safety guarantees split and every future command pays the
  two-code-paths tax. If the business ever demands Surescripts, this
  ADR is superseded by an explicit successor that owns the migration
  cost.
- **Portal-only** (no partner API for intake). Attractive because it
  minimizes attack surface. Rejected by ADR-0032: EHR-to-API is the
  primary integration story the platform was built to support.

## References

- Code: `apps/web/app/api/v1/prescriptions/route.ts` (the intake
  seam), `packages/orders/src/commands/create-prescription.ts` (the
  command every intake path dispatches), `IntakeSourceKind` in
  `packages/database` (`MANUAL | CSV | API | EHR_INTEGRATION |
  TRANSFERRED_IN` — deliberately no `SURESCRIPTS` value)
- Companion ADRs: `0032-partner-api-keys-and-outbound-webhooks.md`,
  `0033-provider-portal-self-serve-onboarding.md`,
  `0037-epcs-controlled-substance-prescribing.md`
- Product framing: `docs/GO_LIVE_PROGRAM.md` (Track B annex); this
  ADR converts "Surescripts is deferred" into "Surescripts is not
  planned."
- Companion decision on the billing side: `0039-cash-only-no-pbm-adjudication.md`
