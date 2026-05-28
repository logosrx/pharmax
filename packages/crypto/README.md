## @pharmax/crypto

Field-level envelope encryption, blind indexes, and audit-Merkle root signing for
the Pharmax platform. Two `KmsAdapter` implementations are shipped:

- **`LocalKmsAdapter`** — pure-Node HMAC + AES-GCM, no external dependencies. Used
  for `NODE_ENV=development` and the test suite. Refuses to boot in production
  via the `@pharmax/composition` guard.
- **`AwsKmsAdapter`** — AWS KMS-backed production adapter. Used for `NODE_ENV=production`
  in every Pharmax service that touches PHI.

The rest of the package (`encryptField`, `decryptField`, `blindIndex`,
`planCryptoShred`, `configureCrypto`) is adapter-agnostic and unchanged across
both.

Design rationale, AAD binding, kid format, search-key caching, and per-method
contract details live in inline JSDoc on `aws-kms-adapter.ts` and
`aws-kms-client.ts` — read those for the **why**. This README is the **operator
contract**.

---

### Production wiring (apps/web, apps/worker)

```ts
import { AwsKmsAdapter, configureCrypto, createAwsKmsClient } from "@pharmax/crypto";

const kms = new AwsKmsAdapter({
  client: createAwsKmsClient({ region: env.AWS_REGION }),
  dataKeyKeyId: env.AWS_KMS_DATA_KEY_ID,
  searchKeyKeyId: env.AWS_KMS_SEARCH_KEY_ID,
  keyIdLabel: "app-phi",
});

await kms.validate(); // throws if IAM is misconfigured
configureCrypto({ kms });
```

`validate()` issues one `DescribeKey` call per configured key at boot. Run it
before declaring the service ready so an IAM regression surfaces at startup
rather than at first PHI write.

---

### Environment variables

| Variable                | Required   | Purpose                                                                                                                                      |
| ----------------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `AWS_REGION`            | production | KMS endpoint region. **Must match the key's region** — KMS rejects cross-region calls.                                                       |
| `AWS_KMS_DATA_KEY_ID`   | production | ARN or alias of the symmetric `ENCRYPT_DECRYPT` CMK used to wrap per-field DEKs.                                                             |
| `AWS_KMS_SEARCH_KEY_ID` | production | ARN or alias of the HMAC `GENERATE_VERIFY_MAC` (HMAC_256) CMK used to derive blind-index keys.                                               |
| `AWS_KMS_KEY_LABEL`     | optional   | Short label embedded in stored kids (default `app-phi`). Changing this in production silently breaks decrypt of previously stored envelopes. |

**Two CMKs, not one.** AWS KMS forbids mixing `KeyUsage`: a key with
`ENCRYPT_DECRYPT` cannot perform `Mac`, and vice versa. The Terraform module
provisions both side by side. See `infra/terraform/modules/kms/`.

Credentials are supplied via the standard AWS provider chain — IRSA on EKS, ECS
task role, instance profile on EC2, or `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`
locally. The crypto package never reads those variables directly; the SDK does.

---

### IAM policy

Minimum permissions on the service task role. Apply each statement to the
matching key ARN (not `*`):

```jsonc
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "PhiDataKeyEnvelope",
      "Effect": "Allow",
      "Action": ["kms:GenerateDataKey", "kms:Decrypt", "kms:DescribeKey"],
      "Resource": "arn:aws:kms:<region>:<account>:key/<data-key-id>",
      "Condition": {
        "StringEquals": {
          "kms:EncryptionContextKeys": ["tenantId"],
        },
      },
    },
    {
      "Sid": "PhiBlindIndexHmac",
      "Effect": "Allow",
      "Action": ["kms:GenerateMac", "kms:DescribeKey"],
      "Resource": "arn:aws:kms:<region>:<account>:key/<search-key-id>",
    },
  ],
}
```

Notes:

- **`kms:EncryptionContextKeys` condition is mandatory.** It guarantees the
  service role can only ask KMS to unwrap a DEK if the caller passes a
  `tenantId` in the encryption context. Combined with the adapter passing
  `{ tenantId }` on every `GenerateDataKey` / `Decrypt`, a wrapped DEK
  created for tenant A cannot be unwrapped for tenant B — even by code with a
  bypassed application-level tenancy check.
- **No `kms:Encrypt` and no `kms:ReEncrypt*`.** The adapter uses
  `GenerateDataKey` only; the wrapped DEK round-trips via `Decrypt`. Granting
  `kms:Encrypt` would let a compromised app re-wrap a DEK for a different
  encryption context — a tenancy-bypass primitive.
- **`kms:DescribeKey`** is required for `validate()` to detect misconfig at
  boot. Without it, the first PHI write of the day will be the discovery path.
- Audit-Merkle signing (`signRoot` / `verifyRoot` on `KmsAdapter`) uses a
  _third_ CMK — asymmetric `SIGN_VERIFY` (RSA-3072 or ECC_NIST_P384). That key
  and its IAM policy live in the audit-Merkle slice, not this package. See
  `docs/adr/0024-merkle-root-signing-and-evidence.md`.

---

### Key rotation

| Surface                     | Mechanism                                                                                                                                                                           | Cadence              |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| KMS key material            | AWS automatic annual rotation (`enable_key_rotation = true` on every symmetric CMK).                                                                                                | Annual, automatic    |
| Per-field DEK               | New DEK per `GenerateDataKey` call — i.e., per encrypted field. Rotation is implicit.                                                                                               | Per write            |
| Per-tenant blind-index key  | Deterministic HMAC of `pharmax.search.v1.<tenantId>.<purpose>` against the KMS HMAC key. Rotates only when the underlying CMK key material is rotated AND the process is restarted. | When CMK rotates     |
| Adapter epoch (`v1` in kid) | Hardcoded `v1` slot reserved for explicit application-level KEK cutover (e.g., post-compromise). Procedure: see [`docs/RUNBOOK.md`](../../docs/RUNBOOK.md).                         | On material-incident |

In normal operation, AWS handles rotation transparently — every wrapped DEK
stays decryptable across rotation events because KMS retains old key material
for the lifetime of the CMK. No application action is required.

Process restart is required after a CMK rotation to invalidate the in-process
search-key cache (otherwise blind-index reads continue against the previous key
material until cache eviction, which never happens because the cache lives for
the process lifetime by design).

---

### Composition root wiring

`@pharmax/composition`'s `crypto-configurator` selects the adapter based on
`NODE_ENV`. In production:

1. Boot reads `AWS_REGION`, `AWS_KMS_DATA_KEY_ID`, `AWS_KMS_SEARCH_KEY_ID` from
   `apps/web/src/server/env.ts` or `apps/worker/src/env.ts`.
2. Boot constructs `AwsKmsAdapter` via `createAwsKmsClient`.
3. Boot calls `kms.validate()` — boot fails fast if KMS / IAM is wrong.
4. Boot calls `configureCrypto({ kms })`.
5. Boot calls `configureBlindIndex({ kms })`.
6. Service is ready; PHI reads / writes use the adapter transparently.

The bootstrap layer never branches on adapter type after step 4 — the
`KmsAdapter` interface is the only contract the rest of the platform sees.

---

### Observability

Every KMS call is decorated by the SDK with a `pharmax-crypto/<version>` User-Agent
token so CloudTrail attributes calls to this package. Failures surface as typed
errors from `@pharmax/crypto` (`DECRYPT_FAILED`, `KMS_KEY_NOT_FOUND`,
`CRYPTO_VALIDATION`); each carries a `pharmaxErrorCode` the operator runbook
maps to a remediation step. PHI is never logged — KMS plaintext IS the PHI
envelope.

For the alert rules that fire on KMS failures, see
[`observability/prometheus/rules/alert-rules.yaml`](../../observability/prometheus/rules/alert-rules.yaml)
(`KmsErrorBudgetExhausted`).

---

### Related ADRs

- [ADR-0005](../../docs/adr/0005-envelope-encryption-per-phi-field.md) — envelope encryption per PHI field
- [ADR-0010](../../docs/adr/0010-blind-indexes-for-phi-search.md) — blind indexes for PHI search
- [ADR-0023](../../docs/adr/0023-aws-kms-adapter.md) — production KMS adapter design
- [ADR-0024](../../docs/adr/0024-merkle-root-signing-and-evidence.md) — audit-Merkle signing
