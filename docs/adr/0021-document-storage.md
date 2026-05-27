# 0021 — Classification-aware document storage port

- **Status:** Accepted
- **Date:** 2026-05-25
- **Deciders:** Platform team
- **Tags:** `architecture`, `security`, `storage`, `phi`

## Context

The platform predictably needs to store classified bytes from many
domain packages: prescription images and lab results (PHI), generated
invoice PDFs and signed clinic contracts (CONFIDENTIAL), operational
reports and SOPs (INTERNAL), the public terms-of-service PDF
(PUBLIC). Today the only blob-storage port in the codebase is
`@pharmax/package-capture::PackagePhotoStorage`, scoped narrowly to
dock-side package photos with a hard-coded threat model
("a sealed package on a dock is not PHI").

That scope is correct for what it covers but leaves every OTHER document
type without a structural home. Two failure modes follow.

First, every new document type that ships is tempted to either
(a) reinvent the port shape ("file storage for invoices", "file storage
for signed consents") or (b) drop the bytes through Prisma as a `Bytes`
column. (a) creates a thicket of nearly-identical ports each with its
own subtle differences in error codes, signed-URL TTLs, and crypto
posture. (b) defeats every benefit of object storage (cheap reads,
presigned URLs that bypass the API server, lifecycle policies) AND
breaks the principle that PHI bytes live behind an AAD-bound envelope.

Second, PHI documents need stronger handling than non-PHI documents.
The same code path that stores a public press kit MUST NOT be the same
code path that stores a prescription image — the latter needs
envelope encryption with an AAD binding to its anchor record
(per `@pharmax/crypto::encryptField`), a HIPAA-eligible bucket, a
short signed-URL TTL, and structured logging that avoids the document
id outside audit feeds. A port without a CLASSIFICATION input has no
language to enforce these rules at the boundary.

We need a single cross-cutting port that every domain depends on,
that distinguishes PHI from non-PHI structurally, and that exercises
the AAD-binding contract end-to-end against an in-memory adapter so
production adapters inherit a proven shape.

## Decision

Introduce `@pharmax/documents` as a new workspace package with **four**
day-one pieces:

1. **`DocumentClassification` enum** — `"PHI" | "CONFIDENTIAL" |
"INTERNAL" | "PUBLIC"`. Closed; no `MIXED`, no `UNKNOWN`. The
   helpers `requiresAadBinding(c)` and `maxSignedUrlTtlSeconds(c)` are
   single sources of truth (a new level only flips two switches).

2. **`DocumentStorage` port** with four methods: `put`, `get`,
   `signUrl`, `delete`.
   - `put` accepts `{ tenantId, classification, contentType, bytes,
aadBinding?, metadata? }` and returns
     `{ documentId, sha256, bucket, key, fileSize }`.
   - `get(documentId, { aadBinding? })` returns
     `{ bytes, contentType, classification }`.
   - `signUrl(documentId, { ttlSeconds, downloadFilename? })` returns
     `{ url, expiresAt }`.
   - `delete(documentId, { reason })` where `reason` is a closed enum
     (`USER_REQUESTED`, `RETENTION_POLICY_EXPIRY`,
     `REPLACED_BY_NEW_VERSION`, `CRYPTO_SHRED`, `ADMIN_PURGE`) so
     audit reports group cleanly.

3. **AAD binding for PHI.** The port's `AadBinding` is a re-export of
   `@pharmax/crypto::RecordBinding`. PHI documents MUST carry one at
   `put` and MUST present the same one at `get`. The in-memory adapter
   actually calls `encryptField` / `decryptField` so a wrong recordId
   at read time surfaces as the crypto layer's `AAD_MISMATCH` — the
   same security signal as any other AAD-bound field. PUBLIC documents
   MUST NOT carry an `aadBinding` (forbidden by the validator);
   CONFIDENTIAL / INTERNAL MAY carry one as record-keeping metadata
   but it is not crypto-bound at this layer.

4. **In-memory adapter** (`InMemoryDocumentStorage`) and the boot-time
   `configureDocumentStorage({ storage })` singleton. Same shape as
   `@pharmax/package-capture` and `@pharmax/notifications`; reading
   without configuration throws `InternalError(DOCUMENTS_NOT_CONFIGURED)`.

The signed-URL TTL ceiling per classification is enforced at the
adapter boundary: PHI = 5 minutes, CONFIDENTIAL = 15 minutes, INTERNAL
= 1 hour, PUBLIC = 1 day. Callers may request shorter; the adapter
rejects longer with `DOCUMENT_TTL_EXCEEDED`.

## Consequences

**Becomes easier.**

- Every future document type slots in with no port shape ceremony —
  prescription images, signed patient consents, lab results, generated
  invoice PDFs, operational reports, the public terms-of-service PDF
  — all use the same `put` / `get` / `signUrl` / `delete` surface.
- PHI handling is structural. The validator rejects "store this PHI
  document with no aadBinding" at the port boundary, before any bytes
  hit storage; the read path refuses to return ciphertext without
  the binding. A bug that defaults to PHI is strictly preferable to
  a bug that defaults to PUBLIC, and the closed enum forces every
  caller to pick.
- The signed-URL pattern lets the web app skip large-byte transit:
  the client uploads to / downloads from the bucket directly with a
  short-lived presigned URL, while the API server only handles
  small JSON envelopes carrying document ids.
- Swapping the bytes backend (in-memory → S3 → GCS) is one boot-time
  line. The crypto wrapper is independent of the backend.
- Tests run against the in-memory adapter with no network, no bucket,
  no AWS credentials. The same `encryptField` / `decryptField` calls
  fire as in production, so the crypto contract is exercised on every
  PR.

**Becomes harder / ongoing obligations.**

- Every put site picks a classification. We accept this: the call
  site is the only place that has the editorial context for that
  decision, and a default would erode safety.
- Production adapters MUST honor the TTL ceilings. A future S3 adapter
  that ignores the classification ceiling and signs PHI URLs for an
  hour is a security incident. The contract test in the in-memory
  adapter pins the rule; the production adapter's own tests must
  re-verify it.
- A `PUBLIC` document put with an `aadBinding` is rejected — the
  combination is meaningless. We accept the harder error path in
  exchange for the structural guarantee that PUBLIC documents are
  not crypto-bound.
- Cross-tenant access is rejected at the GET boundary BEFORE crypto
  runs (`DOCUMENT_TENANT_MISMATCH`), saving the crypto round-trip and
  giving a clearer audit signal.

**Failure modes + detection.**

- Caller forgets `aadBinding` for PHI → `DOCUMENT_AAD_BINDING_REQUIRED`
  at put (or get).
- Caller uses the wrong `recordId` at get → `AAD_MISMATCH` from the
  crypto layer; logged as a SOC 2 security event.
- Caller targets the wrong tenant at get → `DOCUMENT_TENANT_MISMATCH`
  before crypto runs.
- Caller asks for a too-long signed URL → `DOCUMENT_TTL_EXCEEDED`.
- Backend transport blows up → `DOCUMENT_TRANSPORT_ERROR` (the retry
  policy lives in the worker that calls `put`, not in this layer).

## Alternatives Considered

- **Per-domain storage (`InvoiceDocumentStorage`,
  `PrescriptionImageStorage`, ...).** Rejected: every domain reinvents
  the same shape with subtle differences. Reviewers can't audit
  "what documents does the platform store?" in one place. PHI safety
  becomes a per-port discipline rather than a structural property.

- **Pass bytes through the API surface end-to-end (no signed URLs).**
  Rejected for non-trivial documents (prescription images, generated
  PDFs). Large-byte transit through the Next.js API saturates the
  function memory limit, slows every other concurrent request, and
  inflates the `command_log.requestPayload` audit row by megabytes
  per call. Signed URLs let the client talk to the bucket directly
  while the API server only handles small JSON envelopes.

- **Treat `PackagePhotoStorage` as the general-purpose port.**
  Rejected for now: the package-photo port has the wrong threat model
  baked in (photo bytes are explicitly NOT PHI in that port's
  contract, with no AAD binding). Generalizing it would require
  loosening that contract in ways the current consumers don't expect.
  The follow-up below is the cleaner path.

## Follow-ups

- Production adapter: `S3DocumentStorage` with SSE-KMS at rest, per-
  classification bucket policies, per-tenant prefix paths, presigned
  PUT for client-side upload, and presigned GET for client-side
  download with the TTL ceilings from `classification.ts`.
- Boot wiring: parallel agent is refactoring
  `apps/web/src/server/bootstrap.ts` and `apps/worker/src/main.ts` to
  call `configureDocumentStorage({ storage })` at process startup.
- **Refactor `@pharmax/package-capture::PackagePhotoStorage` onto
  `DocumentStorage`.** The package-photo port becomes a thin wrapper
  around `put({ classification: "INTERNAL", ... })` — package photos
  remain not-PHI per the existing threat model, but the storage
  shape unifies under one port. This is a follow-up slice; doing the
  refactor now would churn every existing call site for no day-one
  benefit. Path:
  1. Replace the in-memory photo storage with a wrapper that
     delegates to `InMemoryDocumentStorage`.
  2. The S3 photo storage (when it ships) is a wrapper around
     `S3DocumentStorage` parameterized to the photos bucket.
  3. The `PackagePhotoStorage` interface stays put as a domain-
     specific facade so existing call sites don't churn; only the
     adapter wiring changes.

## References

- Code: `packages/documents/src/index.ts`
- Code: `packages/documents/src/ports/document-storage.ts`
- Code: `packages/documents/src/classification.ts`
- Code: `packages/documents/src/adapters/in-memory-document-storage.ts`
- Sibling pattern: `packages/package-capture/src/storage/package-photo-storage.ts`
- Crypto contract: `packages/crypto/src/encrypt.ts`,
  `packages/crypto/src/aad.ts`
- Companion: ADR 0020 — Notification channel port
