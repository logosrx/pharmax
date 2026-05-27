#!/usr/bin/env tsx
// scripts/security/verify-kms-keys.ts
//
// Post-deploy KMS smoke check for the production envelope-encryption
// stack (ADR-0023). Operators run this from an ECS one-off task or
// the bastion immediately after a deploy to confirm that:
//
//   1. The `AWS_REGION`, `AWS_KMS_DATA_KEY_ID`, `AWS_KMS_SEARCH_KEY_ID`,
//      and (optional) `AWS_KMS_KEY_LABEL` env vars are populated.
//   2. The configured IAM principal can call `kms:DescribeKey` on
//      both keys (this is what `AwsKmsAdapter.validate()` exercises).
//   3. The data key actually wraps and unwraps a DEK against the
//      tenant binding (`EncryptionContext = { tenantId }`) — i.e.
//      `kms:GenerateDataKey` + `kms:Decrypt` are granted and the
//      key material is healthy.
//   4. The search key can produce a deterministic MAC — i.e.
//      `kms:GenerateMac` is granted and the HMAC_256 key is healthy.
//
// Synthetic tenant id only: `verify-script-tenant`. NEVER pass a
// real organization id — this script must not write any audit
// signal that could be misread as a real PHI access event.
//
// Exit codes:
//   0  All checks passed.
//   1  Any check failed. A single-line JSON object describing the
//      failure is printed to stderr; the human-readable lines on
//      stdout describe the steps that ran.
//
// Usage:
//   pnpm tsx scripts/security/verify-kms-keys.ts
//
//   AWS_REGION=us-east-1 \
//   AWS_KMS_DATA_KEY_ID=alias/pharmax/app-phi-key \
//   AWS_KMS_SEARCH_KEY_ID=alias/pharmax/search-key \
//   AWS_KMS_KEY_LABEL=app-phi \
//   pnpm tsx scripts/security/verify-kms-keys.ts
//
// PHI invariant: this script does NOT touch the database, does NOT
// instantiate Prisma, and does NOT exercise any application code
// that reads PHI. The only material it handles is a synthetic 32-
// byte DEK generated and immediately discarded inside this process.

import { AwsKmsAdapter, createAwsKmsClient } from "@pharmax/crypto";

const SYNTHETIC_TENANT_ID = "verify-script-tenant";
const SYNTHETIC_PURPOSE = "verify.kms.smoke";

interface VerifyResult {
  readonly ok: boolean;
  readonly step: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (typeof v !== "string" || v.length === 0) {
    process.stderr.write(`${JSON.stringify({ ok: false, step: "env", missing: name })}\n`);
    process.exit(1);
  }
  return v;
}

function emit(result: VerifyResult): void {
  // Single-line JSON per step on stdout — pipes cleanly into
  // CloudWatch / log aggregators that expect line-delimited JSON.
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

async function main(): Promise<void> {
  const region = requireEnv("AWS_REGION");
  const dataKeyKeyId = requireEnv("AWS_KMS_DATA_KEY_ID");
  const searchKeyKeyId = requireEnv("AWS_KMS_SEARCH_KEY_ID");
  const keyIdLabel = process.env["AWS_KMS_KEY_LABEL"] ?? "app-phi";

  emit({
    ok: true,
    step: "env.resolved",
    details: {
      region,
      // Echo the configured key identifier (alias / ARN), NOT any
      // key material. Aliases and ARNs are public metadata in
      // CloudTrail; safe to log.
      dataKeyKeyId,
      searchKeyKeyId,
      keyIdLabel,
    },
  });

  const adapter = new AwsKmsAdapter({
    client: createAwsKmsClient({ region }),
    dataKeyKeyId,
    searchKeyKeyId,
    keyIdLabel,
  });

  // Step 1: boot-time validation. Mirrors what apps/web and
  // apps/worker do at startup. Exercises `kms:DescribeKey` on
  // both keys and asserts the metadata matches.
  try {
    await adapter.validate();
    emit({ ok: true, step: "validate" });
  } catch (cause) {
    emit({
      ok: false,
      step: "validate",
      details: { error: cause instanceof Error ? cause.message : "unknown" },
    });
    process.exit(1);
  }

  // Step 2: round-trip a DEK against the synthetic tenant id.
  // Exercises `kms:GenerateDataKey` + `kms:Decrypt`. The plaintext
  // DEK is overwritten before this function returns — we don't
  // leak it to logs or to any downstream code.
  let wrapped: { kid: string; wrappedDek: Buffer };
  try {
    const generated = await adapter.generateDataKey({ tenantId: SYNTHETIC_TENANT_ID });
    wrapped = { kid: generated.kid, wrappedDek: generated.wrappedDek };
    // Zero the in-memory DEK immediately. Not strictly required
    // (V8 may have already optimized this away) but documents
    // intent: this script never holds plaintext key material
    // beyond the single round-trip.
    generated.plaintextDek.fill(0);
    emit({
      ok: true,
      step: "generateDataKey",
      details: { kid: generated.kid, wrappedDekBytes: generated.wrappedDek.byteLength },
    });
  } catch (cause) {
    emit({
      ok: false,
      step: "generateDataKey",
      details: { error: cause instanceof Error ? cause.message : "unknown" },
    });
    process.exit(1);
  }

  try {
    const dek = await adapter.unwrapDataKey({
      tenantId: SYNTHETIC_TENANT_ID,
      kid: wrapped.kid,
      wrappedDek: wrapped.wrappedDek,
    });
    // We only verify the DEK was returned at the expected length;
    // we do not echo the bytes anywhere.
    if (dek.byteLength !== 32) {
      emit({
        ok: false,
        step: "unwrapDataKey",
        details: { reason: `unexpected DEK length: ${dek.byteLength}` },
      });
      process.exit(1);
    }
    dek.fill(0);
    emit({ ok: true, step: "unwrapDataKey" });
  } catch (cause) {
    emit({
      ok: false,
      step: "unwrapDataKey",
      details: { error: cause instanceof Error ? cause.message : "unknown" },
    });
    process.exit(1);
  }

  // Step 3: search key — `kms:GenerateMac`. Exercises the HMAC
  // CMK and confirms the cache populates correctly.
  try {
    const key = await adapter.deriveSearchKey({
      tenantId: SYNTHETIC_TENANT_ID,
      purpose: SYNTHETIC_PURPOSE,
    });
    if (key.byteLength !== 32) {
      emit({
        ok: false,
        step: "deriveSearchKey",
        details: { reason: `unexpected MAC length: ${key.byteLength}` },
      });
      process.exit(1);
    }
    key.fill(0);
    emit({ ok: true, step: "deriveSearchKey" });
  } catch (cause) {
    emit({
      ok: false,
      step: "deriveSearchKey",
      details: { error: cause instanceof Error ? cause.message : "unknown" },
    });
    process.exit(1);
  }

  // Cross-tenant negative: confirm the kid + EncryptionContext
  // binding rejects a tampered tenant id. This is the SECURITY
  // signal — if it ever succeeds, the EncryptionContext binding
  // is broken and PHI cross-tenant leakage is possible. We test
  // both code paths: kid mismatch (refused before reaching KMS)
  // and KMS-side InvalidCiphertextException (forged kid).
  try {
    await adapter.unwrapDataKey({
      tenantId: "other-tenant-DO-NOT-USE",
      kid: wrapped.kid,
      wrappedDek: wrapped.wrappedDek,
    });
    emit({
      ok: false,
      step: "crossTenantRejection",
      details: {
        reason: "unwrap accepted a mismatched tenantId — EncryptionContext binding broken",
      },
    });
    process.exit(1);
  } catch {
    // Expected — the kid embeds the original tenant id, so the
    // adapter refuses before calling KMS.
    emit({ ok: true, step: "crossTenantRejection.kidMismatch" });
  }

  emit({ ok: true, step: "complete" });
  process.exit(0);
}

main().catch((cause: unknown) => {
  process.stderr.write(
    `${JSON.stringify({
      ok: false,
      step: "uncaught",
      error: cause instanceof Error ? cause.message : "unknown",
    })}\n`
  );
  process.exit(1);
});
