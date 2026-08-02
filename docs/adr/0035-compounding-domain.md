# ADR-0035: Compounding domain — formulas, BUD, compounding records, DSCSA

- Status: Accepted (slices 1–4 shipped)
- Date: 2026-08-01 (slice 2 + 3 amendments 2026-08-01)
- Related: ADR-0017 (workflow policy versioning), ADR-0021 (document
  storage), ADR-0033 (non-order aggregate precedent)
- Design inputs: USP <795> (nonsterile compounding, 2023 revision),
  USP <797> (sterile compounding, 2023 revision), USP <800> (hazardous
  drug handling), FDA DSCSA (transaction information / history /
  statement). All are public standards recorded in
  `docs/governance/public-sources-reference.md`.

## Context

The P1 plan commits us to a compounding domain: formula/compound + BUD
models, compounding records with USP 795/797/800 documentation
generated as workflow artifacts, and DSCSA transaction records layered
on the existing `Product → Lot → LotAssignment → InventoryTransaction`
traceability spine.

Today the fill stage assumes a stocked, manufactured product: `AssignLot`
matches a lot to the prescription by NDC and moves the inventory ledger.
Compounded preparations break that assumption — the dispensed article is
_made_, per a recipe, from multiple ingredient lots, and carries a
beyond-use date (BUD) computed at preparation time rather than a
manufacturer expiration.

What USP requires (public compendial standards, our only design input):

- **USP <795>/<797> Master Formulation Record (MFR)** — a versioned,
  written recipe required for any compound prepared in batch or from a
  formula: ingredients and quantities, preparation instructions, BUD
  with its basis, storage conditions, quality-control checks.
- **USP <795>/<797> Compounding Record (CR)** — a per-preparation
  record: who compounded, when, which MFR version, which ingredient
  lots (with quantities), the assigned BUD, QC outcomes, and the
  verifying pharmacist.
- **BUD assignment** — bounded by category. Nonsterile (<795> 2023):
  nonaqueous ≤ 90 days; aqueous preserved ≤ 35 days; aqueous
  nonpreserved ≤ 14 days refrigerated. Sterile (<797> 2023):
  Category 1/2/3 with their own limits. Longer BUDs require a
  documented stability study.
- **USP <800>** — hazardous drugs (NIOSH list) need flagged handling,
  PPE, and containment documentation.
- **DSCSA** — transaction information/history/statement for product
  chain of custody at receipt.

## Decision

### Shape

Three model families, built in three slices:

1. **`CompoundFormula` + `CompoundFormulaIngredient`** — the MFR.
   An org-scoped, _versioned, immutable-once-published_ catalog
   aggregate, mirroring the `WorkflowPolicy` lifecycle:
   `(organizationId, code, version)` unique; status
   `DRAFT → ACTIVE → RETIRED`; publishing version N retires the
   previously ACTIVE version of the same code in the same
   transaction. In-flight preparations pin the formula id + version
   they were made under (grandfather rule, same as ADR-0017).
   Ingredients are child rows — not JSON — so they are queryable and
   can carry a real FK to `Product` when the ingredient is a stocked
   item (`productId` nullable; bulk chemicals without an org NDC use
   the descriptive fields alone).

2. **`CompoundingRecord` + `CompoundingRecordIngredient`** (slice 2) —
   the CR. An append-only workflow artifact written at the fill stage
   of the _order_ workflow (no new workflow-policy family: the record
   has no human queue of its own — it rides `order.standard`, pinned
   via the order like `VerificationRecord`). Each ingredient row
   references the actual `Lot` consumed and writes the matching
   `InventoryTransaction` ledger movement, reusing the `AssignLot`
   guard set (org/site match, ACTIVE status, unexpired, not held).
   The BUD is computed at preparation time as
   `preparedAt + formula.budDays`, clamped by the formula's
   `budBasis` category, and stored on the record. Human-readable USP
   documentation (the CR as a printable artifact) is generated
   through the ADR-0021 `DocumentStorage` port, classified PHI when
   order-bound.

3. **DSCSA transaction records** (slice 3) — `DscsaTransaction`
   rows (TI/TH/TS content) keyed to `Lot` receipt, layered on the
   existing traceability spine.

### BUD as data, not code

The formula stores `budDays` plus a closed `budBasis` enum:

- `USP795_NONAQUEOUS` (≤ 90 days)
- `USP795_AQUEOUS_PRESERVED` (≤ 35 days)
- `USP795_AQUEOUS_NONPRESERVED` (≤ 14 days)
- `USP797_CATEGORY_1` (≤ 12 hours room temp / 24 h refrigerated)
- `USP797_CATEGORY_2` (chapter table applies)
- `USP797_CATEGORY_3` (chapter table applies)
- `STABILITY_STUDY` (documented study; cap not enforced by us)

plus a `storageCondition` enum (`ROOM_TEMPERATURE`, `REFRIGERATED`,
`FROZEN`). Slice 1 _validates_ `budDays` against the hard <795> caps
for the three nonsterile bases (they are unconditional chapter
limits); the <797> categories vary by storage condition and sterility
testing, so those are validated as positive and bounded (≤ 1825 days)
with the chapter-precise clamp arriving with sterile support in slice 2. `STABILITY_STUDY` requires a non-empty `budReference` describing
the study.

### USP <800> in slice 1

A `hazardous` boolean on the formula. Handling/PPE documentation is a
slice-2 concern (it belongs on the CR artifact); the flag exists from
day one so formulas are classified at authoring time and the flag is
carried into events for downstream consumers.

### Commands (slice 1)

All three follow the plain `Command` shape (the aggregate is not an
order, so `defineCommand`'s order-locking factory does not apply —
same as the ADR-0033 onboarding commands; concurrent lifecycle
transitions are serialized by the in-transaction status guard):

- **`CreateCompoundFormula`** — creates version 1 of a new code, or
  the next DRAFT version of an existing code. At most one open DRAFT
  per code (enforced by a partial unique index). Validates BUD caps,
  validates every `productId` ingredient reference against the org
  catalog, writes formula + ingredient rows, emits
  `compounding.formula.created.v1`.
- **`PublishCompoundFormula`** — DRAFT → ACTIVE; retires the
  previously ACTIVE version of the same code in the same transaction
  (recorded as superseded in the event payload). Emits
  `compounding.formula.published.v1`.
- **`RetireCompoundFormula`** — ACTIVE → RETIRED with a closed
  reason-code enum (`SAFETY`, `FORMULARY_CHANGE`, `INGREDIENT_SOURCING`,
  `REGULATORY`, `ERROR`). Emits `compounding.formula.retired.v1`.

No PHI anywhere in this family: formulas are recipes, ingredients are
drugs/chemicals, events are `phiSafe: true`.

### Permissions

Two new codes: `compounding.formula.manage` (author/publish/retire —
pharmacist-level) and `compounding.read`. Role templates: `Pharmacist`
gets both; `PharmacyTechnician` gets read (they prepare from ACTIVE
formulas but do not author them).

## Alternatives considered

- **Formula as JSON on a generic catalog row** — rejected: ingredient
  rows need FK integrity to `Product` and per-ingredient queries
  ("which formulas use this ingredient?") for recall workflows.
- **A `compounding.formula` workflow-policy family** — rejected for
  slice 1: the lifecycle is a three-state catalog machine with no
  review queue; `WorkflowPolicy`'s own lifecycle is the closer
  precedent. Revisit if formula approval ever needs a second-person
  review queue.
- **Extending `Product` with a `COMPOUND` kind instead of a formula
  aggregate** — deferred, not rejected: slice 2 must decide how a
  compounded preparation appears on a `Prescription`/`OrderLine`
  (likely a `Product` row whose NDC-equivalent is the formula code,
  so the existing fill/label/billing spine keeps working). That
  linkage is a slice-2 decision recorded here as an open question.

## Slice 2 decisions (amendments)

Resolved when the compounding record shipped:

1. **Finished-preparation linkage** — the finished preparation keeps
   being modeled as an org `Product` + `Lot` (a batch is bottled and
   lotted; the formula code is the catalog identifier). `AssignLot`,
   vial-label printing, and `CompleteFill`'s lot + scan guards are
   UNCHANGED — the compounding record adds the ingredient-level
   traceability _behind_ that finished lot. Compound-aware
   `CompleteFill` rules for one-off patient-specific preparations
   (no finished-goods lot) were deferred here and shipped in slice 4
   (see "Slice 4 decisions").

2. **CR artifact storage** — the rendered USP compounding-record
   document is stored IN-ROW (`compounding_record.renderedDocument` +
   sha-256), following the `PrintJob.renderedZpl` precedent: the
   artifact commits atomically with the record and sits behind RLS.
   `@pharmax/documents` has no production adapter yet (in-memory
   only); offloading rendered documents to object storage via the
   ADR-0021 port is deferred until an S3 adapter exists. The DB row
   remains the authoritative record either way.

3. **Ingredient ledger** — each product-backed ingredient consumption
   writes an `InventoryTransaction` with a new `COMPOUND_CONSUMED`
   reason (not `LOT_ASSIGNED`, which means "dispensed lot bound to a
   line"). No `LotAssignment` rows are written for ingredients —
   that model means "the dispensed lot"; the CR ingredient row is the
   ingredient-side traceability anchor. Non-product ingredients (bulk
   chemicals without an org catalog row) record `manualLotNumber` (+
   optional expiration) instead of a `Lot` FK, per the USP
   requirement to document every component's source lot.

4. **BUD at preparation time** — `budAt = preparedAt + budDays`,
   clamped to the EARLIEST expiration among all consumed lots and
   manually recorded ingredient expirations (USP <795>/<797>: the BUD
   must not exceed any component's expiration/BUD).

5. **USP <797> ceilings** — the formula does not model the
   sterilization/testing mode (aseptic vs. terminally sterilized,
   sterility-tested or not), so the chapter's per-storage tables
   cannot be applied precisely. `CreateCompoundFormula` now enforces
   each category's OUTER bound (Category 1 ≤ 1 day, Category 2 ≤ 45
   days, Category 3 ≤ 180 days) plus preparation-kind ↔ basis
   coherence (NONSTERILE ⇒ USP <795> basis; STERILE ⇒ USP <797>
   basis; STABILITY_STUDY allowed for both). The precise per-storage
   clamp lands if/when processing-mode fields are added.

6. **Quality documentation** — every CR records a `qualityOutcome`
   (PASS/FAIL); FAIL requires notes (house rule: every failure
   carries a reason). A FAIL record documents the discarded prep —
   it does not gate fill (the finished lot simply never gets
   assigned). Hazardous formulas (USP <800>) require
   `handlingNotes` documenting containment/PPE on every record.

## Slice 3 decisions (amendments)

Resolved when DSCSA lot-receipt records shipped:

1. **TI + TS, not TH** — since the DSCSA enhanced drug distribution
   security phase (statutory date 2023-11-27), trading partners
   exchange Transaction Information and the Transaction Statement
   electronically with package-level identifiers; Transaction History
   is no longer part of the exchange. We model a structured TI
   snapshot (21 USC 360eee(26): product name, strength, dosage form,
   NDC, container size/count, lot number, transaction + shipment
   dates, seller and buyer name/address) plus a
   `transactionStatementReceived` attestation gate — `ReceiveLot`
   refuses receipt unless the seller's TS accompanied the shipment,
   which is the dispenser's statutory obligation. The electronic
   source (EPCIS file / ASN reference) is recorded as
   `sourceDocumentRef`. Statutory retention is 6 years; rows are
   append-only and never deleted.

2. **Receipt-scoped, not lot-scoped** — one `dscsa_transaction` row
   per RECEIPT (a lot can arrive across multiple shipments), keyed to
   the `Lot` it lands in. `ReceiveLot` creates the lot on first
   receipt and reuses it on subsequent receipts of the same
   (site, product, lotNumber); each receipt writes a `LOT_RECEIVED`
   inventory ledger credit, so on-hand remains a pure ledger fold.

3. **Home: `@pharmax/inventory`** — receiving is neither fill
   (consumption) nor compounding (preparation); it is the missing
   inbound edge of the Lot/InventoryTransaction spine. New domain
   package with `ReceiveLot` and the chain-of-custody read
   (`getLotChainOfCustody`): inbound DSCSA receipts + ledger +
   dispensing assignments + compounding-ingredient consumptions for a
   lot, in one PHI-safe view (ids only) — the recall-response query.

4. **Expired stock is refused at the door** — `ReceiveLot` rejects a
   receipt whose expiration date is already past, extending the
   "no expired lot assignment" rule upstream to receiving.

## Slice 4 decisions (amendments)

Resolved when compound-aware fill completion shipped:

1. **The compounding record IS the lot, operationally** — a
   patient-specific preparation has no finished-goods `Lot`; its
   physical-verification anchor is the slice-2 `compounding_record`.
   A line is treated as a compound-prep line when `lotId` is null and
   a compounding record exists for it; a line with an assigned lot
   always follows the stock rules (batch-prepared compounds keep
   their finished-goods lot path unchanged).

2. **The LATEST record per line is authoritative** — a FAIL followed
   by a re-prep PASS completes; a PASS followed by a FAIL re-check
   blocks. `CompleteFill` requires the latest record to be PASS
   (`FILL_COMPOUND_QUALITY_FAILED`) with a future BUD
   (`FILL_COMPOUND_BUD_EXPIRED` — the prep-side mirror of "no expired
   lot"). A line with neither lot nor record still fails with
   `FILL_LOT_NOT_ASSIGNED`.

3. **Scan rules split by line kind** — stock lines keep the full lot
   - vial-label scan pair (a missing lot scan is now a typed
     `FILL_SCAN_LOT_SCAN_REQUIRED`). Compound lines have no
     manufacturer barcode to scan: the lot scan is FORBIDDEN
     (`FILL_SCAN_COMPOUND_LOT_UNEXPECTED` — a stock scan on a compound
     line means the wrong physical item is on the bench) and the vial
     label scan remains required; the label barcode encodes the order
     line id, so it is the compound line's physical check.

4. **Vial labels carry the CR + BUD** — `loadVialLabelRenderContext`
   falls back to the latest PASS compounding record when no lot is
   assigned: the label's lot field renders `CR-{record id prefix}`
   and the expiration field renders the BUD, per USP <795>/<797>
   labeling. Printing is blocked while the latest record is FAIL
   (`VIAL_LABEL_COMPOUND_QUALITY_FAILED`) and — unchanged — when
   there is neither lot nor record.

## Slices

1. **(this slice)** Formula/BUD schema + migration + tenancy
   registration, `@pharmax/compounding` package with the three
   lifecycle commands, events + registry entries, permissions + role
   templates, tests.
2. Compounding records as fill-stage workflow artifacts: CR schema,
   `RecordCompoundingPreparation` command with per-ingredient lot
   guards + ledger writes, BUD computation, sterile (<797>) BUD
   clamps, USP <800> handling documentation, printable CR artifact
   via `DocumentStorage`, formula ↔ order-line linkage decision.
3. DSCSA transaction records (TI/TH/TS) on lot receipt, with
   chain-of-custody reads.
4. Compound-aware fill completion for patient-specific preps without
   a finished-goods lot (scan rules by line kind, CR-anchored vial
   labels), plus the ops receiving UI and the chain-of-custody page.
