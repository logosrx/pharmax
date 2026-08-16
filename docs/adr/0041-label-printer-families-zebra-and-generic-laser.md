# 0041 — Print-agent supports Zebra ZPL and generic laser labels behind a LabelRenderer + LabelTransport port

- **Status:** Proposed
- **Date:** 2026-08-15
- **Deciders:** Product owner, pharmacy ops lead, Platform team
- **Tags:** `print-agent`, `labels`, `schema`, `product`, `hardware`

## Context

The label stack is thermal-only today. `LabelPrinterVendor` allows
`ZEBRA | SATO | TSC`; `LabelPrinterProtocol` allows `ZPL | EPL | TSPL`;
`LabelPrinterConnection` is `WORKSTATION_AGENT | NETWORK_RAW`. The
schema even carries the guard in a comment
(`prisma/schema.prisma`, `LabelPrinter`): "Only thermal profiles may be
used for vial labels — enforced at command layer."

Rendering runs on the web tier: `packages/labels/render-vial-label-zpl.ts`
turns a `VialLabelRenderInput` (patient name, drug, Rx number, quantity,
sig, lot, barcode) into a ZPL string, which is persisted on
`print_job.renderedZpl`. Print-agent pulls that job and ships the
string over raw TCP 9100 (`apps/print-agent/src/printer/send-zpl.ts`,
`TcpZplTransport`), then verifies with a Zebra `~HS` host-status
query (`parseHostStatus`, checks paper-out, paused, head-up, ribbon-out).
The verification is why the system can honor "no silent printer
failures" — a successful socket write proves nothing; the `~HS` fault
flags do.

Product intent has shifted: some sites will use a generic **laser
printer** for vial labels (Avery-style sheet-fed stock on an existing
office printer), not a Zebra thermal. Reasons are commercial —
hardware already on-site, no thermal supply chain, lower per-site
cost. The thermal-only invariant is now a barrier to those sites.

## Decision

Extend the label stack to a **two-family** model: `THERMAL_ZPL` (the
current path) and `GENERIC_LASER_PDF` (new), behind two ports:

- **`LabelRenderer` port** in `@pharmax/labels`. Two implementations
  keyed off the printer's family: the existing `renderVialLabelZpl`
  and a new `renderVialLabelPdf`. Both consume the same
  `VialLabelRenderInput`. The command layer selects the renderer
  from the target `LabelPrinter.protocol`; operators never choose.
- **`LabelTransport` port** in `apps/print-agent`. The existing
  `ZplTransport` interface widens: `send(payload: RenderedLabel)` where
  `RenderedLabel = { format: "ZPL" | "PDF"; bytes: Buffer }`. Two
  implementations: `TcpZplTransport` (unchanged, TCP 9100) and
  `IppPdfTransport` (new, IPP over TCP 631, standard on CUPS + Windows).
- **Schema migration.** `print_job.renderedZpl: String` becomes
  `print_job.renderedPayload: Bytes` + `print_job.payloadFormat: PayloadFormat`
  (new enum `{ ZPL, PDF }`). RLS and PHI redaction cover the new
  columns exactly as they cover `renderedZpl` today. Add
  `LabelPrinterVendor.GENERIC_LASER` and `LabelPrinterProtocol.PDF_IPP`.
- **Fail-closed verification carries over.** `IppPdfTransport`
  implements the same optional `verifyPrinterReady()` by reading the
  IPP `printer-state` (`stopped`) + `printer-state-reasons`
  (`media-empty`, `media-jam-warning`, `cover-open`, `toner-empty`,
  `paused`) attributes. Sites whose spooler cannot relay status must
  opt out per-printer, the same way `PRINT_AGENT_VERIFY_STATUS=false`
  works for a Zebra behind a non-bidirectional print server today.
- **The command-layer thermal-only guard is relaxed** for
  `GENERIC_LASER` printers only. Zebra continuous-roll templates
  (2.25×4 in) and Avery sheet-fed templates (2×4 in landscape, 10-up)
  are laid out separately even though they render from the same input.

## Consequences

**Easier.** Sites can adopt Pharmax without a Zebra investment.
Non-vial print surfaces (packing slips, patient handouts) fall out of
the same abstraction almost free. Future thermal families (SATO, TSC,
already in the enum) become concrete `LabelTransport` implementations
without further ADR work.

**Harder.** Every future label field — a new barcode symbology, a
controlled-substance indicator, a warning icon — must be added to both
the ZPL and PDF renderer, and the two must be tested against each
other for content equivalence. `print_job.renderedZpl` becomes
`renderedPayload` in a real migration: existing rows must be backfilled
(`payloadFormat = 'ZPL'`, `renderedPayload = utf8(renderedZpl)`) and
the `hashZplContent` code renames to `hashLabelPayload`. IPP status
reporting is genuinely less strict than `~HS` — some laser printers
under-report `media-empty`, some spoolers drop `printer-state-reasons`
entirely; ops must be able to disable verification per printer without
a code deploy.

**Ongoing.** USP §17 (Prescription Container Labeling) and 21 CFR
1306 legibility requirements apply regardless of printer family. A
laser-printed label on Avery stock is regulator-equivalent to a
thermal only if it stays legible under moisture and handling. The
site-onboarding checklist must call this out — the platform does not
enforce it because the platform cannot see the physical output.

## Alternatives Considered

- **Refuse laser; require Zebra.** Attractive because the current
  thermal-only stack is tight — one renderer, one transport, `~HS`
  verification. Rejected because the user has explicitly named laser
  as a supported family, and refusing turns away real customers.
- **Drop ZPL entirely; render PDF for everyone; ship over IPP.**
  Attractive because it collapses the stack to one path. Rejected:
  thermal Zebra over raw 9100 is faster (tens of ms vs. hundreds
  through a spooler), `~HS` is stricter than any IPP state, and every
  Zebra-equipped site would lose reliability and speed for no gain.
- **Render a universal JSON at web; lay out at print-agent.**
  Attractive because layout decisions move to the edge. Rejected
  because it puts label PHI on every workstation's render path
  (blast-radius regression), makes template changes require
  print-agent redeploys, and moves the trust boundary the wrong way.
- **Browser-side print for laser (skip print-agent entirely).**
  Attractive because it needs no new agent code. Rejected because
  browser print dialogs let the operator cancel or misroute silently,
  breaking "no silent printer failures" and severing the audited
  `print_job → confirm-outcome` chain.

## References

- Code: `apps/print-agent/src/printer/send-zpl.ts` (current `ZplTransport`,
  `~HS` verification), `apps/print-agent/src/process-sent-print-job.ts`
  (job loop; already format-agnostic in scaffolding),
  `packages/labels/src/render-vial-label-zpl.ts` (existing renderer),
  `packages/labels/src/types.ts` (`VialLabelRenderInput` — already
  format-agnostic), `packages/labels/src/hash-zpl-content.ts`,
  `packages/fill/src/commands/print-vial-label.ts` (command that
  currently hard-codes ZPL).
- Schema: `prisma/schema.prisma` — `LabelPrinterVendor` /
  `LabelPrinterProtocol` / `LabelPrinterConnection` enums,
  `LabelPrinter` model (thermal-only guard comment), `PrintJob`
  (`renderedZpl`).
- Migrations this ADR obligates: add `PayloadFormat` enum, add
  `LabelPrinterVendor.GENERIC_LASER`, add `LabelPrinterProtocol.PDF_IPP`,
  convert `print_job.renderedZpl` → `renderedPayload` (Bytes) +
  `payloadFormat` (PayloadFormat), backfill existing rows, update
  RLS + PHI-redaction rules.
- Regulation: USP §17 Prescription Container Labeling; 21 CFR
  1306.14 / 1306.24 (labeling requirements for CS prescriptions);
  state Board of Pharmacy legibility rules.
- Companion ADRs: `0002-modular-monolith-event-driven-internals.md`
  (renderer stays in `@pharmax/labels`), `0007-command-bus-twenty-step-contract.md`
  (dispatcher runs at command layer), `0009-outbox-via-database-polling.md`
  (the print-job queue print-agent drains from).
