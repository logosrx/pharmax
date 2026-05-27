import { createPublicKey, generateKeyPairSync, sign as cryptoSign } from "node:crypto";

import { describe, expect, it } from "vitest";

import type { AuditChainRow, ChainSource } from "@pharmax/audit";

import { computeDailyMerkleRoot } from "./compute-daily-merkle-root.js";
import type { KmsAsymmetricSigningClient } from "./kms-signing-client.js";
import { buildSignedMerkleManifest } from "./publish-merkle-manifest.js";
import { KmsAsymmetricSigner, LocalEd25519Signer, SIGNING_DOMAIN_TAG } from "./sign-merkle-root.js";
import {
  EcdsaP256SignatureVerifier,
  LocalEd25519SignatureVerifier,
  MultiKidSignatureVerifier,
  verifyMerkleManifest,
} from "./verify-merkle-manifest.js";

const ORG = "11111111-1111-7111-a111-111111111111";

function makeRow(seq: bigint, hashByte: number, occurredAt: Date): AuditChainRow {
  return {
    organizationId: ORG,
    seq,
    prevHash: null,
    entryHash: Buffer.alloc(32, hashByte),
    action: `act.${seq.toString()}`,
    resourceType: "Order",
    resourceId: `rid-${seq.toString()}`,
    actorUserId: `user-${seq.toString()}`,
    scope: { siteId: "site-1" },
    metadata: { commandLogId: `clog-${seq.toString()}` },
    occurredAt,
  };
}

function source(rows: ReadonlyArray<AuditChainRow>): ChainSource {
  return {
    async *iterate(opts) {
      for (const row of rows) {
        if (row.organizationId !== opts.organizationId) continue;
        yield row;
      }
    },
  };
}

describe("verifyMerkleManifest with LocalEd25519", () => {
  const periodStart = new Date(Date.UTC(2026, 4, 24, 0, 0, 0));
  const periodEnd = new Date(Date.UTC(2026, 4, 25, 0, 0, 0));
  const rows: ReadonlyArray<AuditChainRow> = [
    makeRow(1n, 0xaa, new Date(Date.UTC(2026, 4, 24, 9, 0, 0))),
    makeRow(2n, 0xbb, new Date(Date.UTC(2026, 4, 24, 12, 0, 0))),
    makeRow(3n, 0xcc, new Date(Date.UTC(2026, 4, 24, 18, 0, 0))),
  ];

  async function buildSignedManifestForRows(): Promise<{
    manifest: ReturnType<typeof buildSignedMerkleManifest>;
    publicKey: ReturnType<typeof createPublicKey>;
    signerKid: string;
  }> {
    const signer = new LocalEd25519Signer({ seed: Buffer.alloc(32, 0x42) });
    const root = await computeDailyMerkleRoot({
      organizationId: ORG,
      periodStart,
      periodEnd,
      source: source(rows),
    });
    const signed = await signer.sign({
      rootHash: root.rootHash,
      organizationId: ORG,
      periodStart,
      periodEnd,
    });
    const manifest = buildSignedMerkleManifest({
      organizationId: ORG,
      periodStart,
      periodEnd,
      computedAt: root.computedAt,
      signedAt: signed.signedAt,
      leafCount: root.leafCount,
      firstSeq: root.firstSeq,
      lastSeq: root.lastSeq,
      rootHash: root.rootHash,
      signature: signed.signature,
      signerKid: signed.signerKid,
      algorithm: signed.algorithm,
      signingDomainTag: SIGNING_DOMAIN_TAG,
    });
    return {
      manifest,
      publicKey: createPublicKey(signer.exportPublicMaterial().publicKeyPem),
      signerKid: signed.signerKid,
    };
  }

  it("accepts a manifest whose root and signature match the live audit log", async () => {
    const { manifest, publicKey, signerKid } = await buildSignedManifestForRows();
    const verifier = new LocalEd25519SignatureVerifier({ publicKey, signerKid });
    const result = await verifyMerkleManifest({
      manifest,
      source: source(rows),
      signatureVerifier: verifier,
    });
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.leafCount).toBe(3);
    }
  });

  it("rejects a manifest with the wrong domain tag", async () => {
    const { manifest, publicKey, signerKid } = await buildSignedManifestForRows();
    const tampered = { ...manifest, signingDomainTag: "pharmax/audit-merkle/wrong" };
    const verifier = new LocalEd25519SignatureVerifier({ publicKey, signerKid });
    const result = await verifyMerkleManifest({
      manifest: tampered,
      source: source(rows),
      signatureVerifier: verifier,
    });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toBe("domain-tag-mismatch");
  });

  it("detects a deleted row (merkle-root-mismatch)", async () => {
    const { manifest, publicKey, signerKid } = await buildSignedManifestForRows();
    const verifier = new LocalEd25519SignatureVerifier({ publicKey, signerKid });
    const result = await verifyMerkleManifest({
      manifest,
      source: source(rows.slice(0, 2)),
      signatureVerifier: verifier,
    });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toBe("merkle-root-mismatch");
  });

  it("detects a row whose entryHash byte was flipped (merkle-root-mismatch)", async () => {
    const { manifest, publicKey, signerKid } = await buildSignedManifestForRows();
    const verifier = new LocalEd25519SignatureVerifier({ publicKey, signerKid });
    const tamperedRows = [
      makeRow(1n, 0xaa, rows[0]!.occurredAt),
      makeRow(2n, 0xee, rows[1]!.occurredAt),
      makeRow(3n, 0xcc, rows[2]!.occurredAt),
    ];
    const result = await verifyMerkleManifest({
      manifest,
      source: source(tamperedRows),
      signatureVerifier: verifier,
    });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toBe("merkle-root-mismatch");
  });

  it("detects a forged signature", async () => {
    const { manifest, publicKey, signerKid } = await buildSignedManifestForRows();
    const verifier = new LocalEd25519SignatureVerifier({ publicKey, signerKid });
    const sigBuf = Buffer.from(manifest.signatureBase64, "base64");
    sigBuf[0] = (sigBuf[0]! ^ 0xff) & 0xff;
    const tampered = { ...manifest, signatureBase64: sigBuf.toString("base64") };
    const result = await verifyMerkleManifest({
      manifest: tampered,
      source: source(rows),
      signatureVerifier: verifier,
    });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toBe("signature-invalid");
  });

  it("rejects an untrusted signer kid even when the signature is valid", async () => {
    const { manifest, publicKey, signerKid } = await buildSignedManifestForRows();
    const verifier = new LocalEd25519SignatureVerifier({ publicKey, signerKid });
    const result = await verifyMerkleManifest({
      manifest,
      source: source(rows),
      signatureVerifier: verifier,
      trustedSignerKids: [
        "ed25519:0000000000000000000000000000000000000000000000000000000000000000",
      ],
    });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toBe("signer-kid-untrusted");
  });

  it("rejects a manifest whose periodStart is before bounds.periodStartAfter", async () => {
    const { manifest, publicKey, signerKid } = await buildSignedManifestForRows();
    const verifier = new LocalEd25519SignatureVerifier({ publicKey, signerKid });
    const result = await verifyMerkleManifest({
      manifest,
      source: source(rows),
      signatureVerifier: verifier,
      bounds: {
        periodStartAfter: new Date(Date.UTC(2026, 5, 1, 0, 0, 0)),
      },
    });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toBe("period-out-of-bounds");
  });

  it("rejects a manifest whose periodEnd is after bounds.periodEndBefore", async () => {
    const { manifest, publicKey, signerKid } = await buildSignedManifestForRows();
    const verifier = new LocalEd25519SignatureVerifier({ publicKey, signerKid });
    const result = await verifyMerkleManifest({
      manifest,
      source: source(rows),
      signatureVerifier: verifier,
      bounds: {
        periodEndBefore: new Date(Date.UTC(2026, 4, 1, 0, 0, 0)),
      },
    });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toBe("period-out-of-bounds");
  });
});

describe("verifyMerkleManifest with KmsAsymmetricSigner (ECDSA P-256)", () => {
  const periodStart = new Date(Date.UTC(2026, 4, 24, 0, 0, 0));
  const periodEnd = new Date(Date.UTC(2026, 4, 25, 0, 0, 0));
  const rows: ReadonlyArray<AuditChainRow> = [
    makeRow(1n, 0xaa, new Date(Date.UTC(2026, 4, 24, 9, 0, 0))),
    makeRow(2n, 0xbb, new Date(Date.UTC(2026, 4, 24, 12, 0, 0))),
  ];
  const keyArn = "arn:aws:kms:us-east-1:000000000000:key/audit-signer";

  function buildFakeKms(): {
    client: KmsAsymmetricSigningClient;
    publicKey: ReturnType<typeof createPublicKey>;
  } {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const client: KmsAsymmetricSigningClient = {
      async sign(input) {
        if (input.MessageType !== "RAW") throw new Error("MessageType not RAW");
        if (input.SigningAlgorithm !== "ECDSA_SHA_256") throw new Error("alg");
        return {
          Signature: cryptoSign("sha256", input.Message, privateKey),
          KeyId: keyArn,
          SigningAlgorithm: "ECDSA_SHA_256",
        };
      },
      async getPublicKey() {
        return {
          PublicKey: Uint8Array.from(publicKey.export({ format: "der", type: "spki" })),
          KeyId: keyArn,
          KeyUsage: "SIGN_VERIFY",
          KeySpec: "ECC_NIST_P256",
        };
      },
    };
    return { client, publicKey };
  }

  it("re-derives root, fetches the KMS public key, and verifies the ECDSA signature", async () => {
    const { client, publicKey } = buildFakeKms();
    const signer = new KmsAsymmetricSigner({ keyArn, kmsClient: client });
    const root = await computeDailyMerkleRoot({
      organizationId: ORG,
      periodStart,
      periodEnd,
      source: source(rows),
    });
    const signed = await signer.sign({
      rootHash: root.rootHash,
      organizationId: ORG,
      periodStart,
      periodEnd,
    });
    const manifest = buildSignedMerkleManifest({
      organizationId: ORG,
      periodStart,
      periodEnd,
      computedAt: root.computedAt,
      signedAt: signed.signedAt,
      leafCount: root.leafCount,
      firstSeq: root.firstSeq,
      lastSeq: root.lastSeq,
      rootHash: root.rootHash,
      signature: signed.signature,
      signerKid: signed.signerKid,
      algorithm: signed.algorithm,
      signingDomainTag: SIGNING_DOMAIN_TAG,
    });
    const verifier = new EcdsaP256SignatureVerifier({
      publicKey,
      signerKid: signed.signerKid,
    });
    const result = await verifyMerkleManifest({
      manifest,
      source: source(rows),
      signatureVerifier: verifier,
    });
    expect(result.valid).toBe(true);
    if (result.valid) expect(result.leafCount).toBe(2);
  });

  it("MultiKidSignatureVerifier dispatches to the right kid", async () => {
    const { client, publicKey } = buildFakeKms();
    const signer = new KmsAsymmetricSigner({ keyArn, kmsClient: client });
    const root = await computeDailyMerkleRoot({
      organizationId: ORG,
      periodStart,
      periodEnd,
      source: source(rows),
    });
    const signed = await signer.sign({
      rootHash: root.rootHash,
      organizationId: ORG,
      periodStart,
      periodEnd,
    });
    const manifest = buildSignedMerkleManifest({
      organizationId: ORG,
      periodStart,
      periodEnd,
      computedAt: root.computedAt,
      signedAt: signed.signedAt,
      leafCount: root.leafCount,
      firstSeq: root.firstSeq,
      lastSeq: root.lastSeq,
      rootHash: root.rootHash,
      signature: signed.signature,
      signerKid: signed.signerKid,
      algorithm: signed.algorithm,
      signingDomainTag: SIGNING_DOMAIN_TAG,
    });
    const verifier = new MultiKidSignatureVerifier([
      {
        signerKid: "aws:kms:asymm:arn:aws:kms:us-east-1:000000000000:key/SOMETHING-ELSE:v1",
        verifier: new EcdsaP256SignatureVerifier({ publicKey, signerKid: signed.signerKid }),
      },
      {
        signerKid: signed.signerKid,
        verifier: new EcdsaP256SignatureVerifier({ publicKey, signerKid: signed.signerKid }),
      },
    ]);
    const result = await verifyMerkleManifest({
      manifest,
      source: source(rows),
      signatureVerifier: verifier,
    });
    expect(result.valid).toBe(true);
  });
});
