import {
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign as cryptoSign,
  verify as cryptoVerify,
} from "node:crypto";
import type { createPrivateKey } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  KmsAsymmetricSigner,
  LocalEd25519Signer,
  MERKLE_SIGN_FAILED,
  MERKLE_PUBLIC_KEY_FETCH_FAILED,
  SIGNING_DOMAIN_TAG,
  buildKmsAsymmetricSignerKid,
  buildSigningPreimage,
} from "./sign-merkle-root.js";
import type { KmsAsymmetricSigningClient } from "./kms-signing-client.js";

const ORG = "11111111-1111-7111-a111-111111111111";

function exampleSigningInput(): {
  rootHash: Buffer;
  organizationId: string;
  periodStart: Date;
  periodEnd: Date;
} {
  return {
    rootHash: Buffer.alloc(32, 0xab),
    organizationId: ORG,
    periodStart: new Date(Date.UTC(2026, 4, 24, 0, 0, 0)),
    periodEnd: new Date(Date.UTC(2026, 4, 25, 0, 0, 0)),
  };
}

describe("LocalEd25519Signer", () => {
  it("produces a verifiable signature over the canonical preimage", async () => {
    const signer = new LocalEd25519Signer();
    const inp = exampleSigningInput();
    const out = await signer.sign(inp);
    const publicMaterial = signer.exportPublicMaterial();
    const publicKey = createPublicKey(publicMaterial.publicKeyPem);
    const ok = cryptoVerify(null, buildSigningPreimage(inp), publicKey, out.signature);
    expect(ok).toBe(true);
    expect(out.algorithm).toBe("ed25519");
    expect(out.signerKid).toMatch(/^ed25519:[0-9a-f]{64}$/);
  });

  it("commits to organizationId — a forged manifest from a different tenant fails verification", async () => {
    const signer = new LocalEd25519Signer();
    const inp = exampleSigningInput();
    const out = await signer.sign(inp);
    const tampered = { ...inp, organizationId: "22222222-2222-7222-a222-222222222222" };
    const publicKey = createPublicKey(signer.exportPublicMaterial().publicKeyPem);
    const ok = cryptoVerify(null, buildSigningPreimage(tampered), publicKey, out.signature);
    expect(ok).toBe(false);
  });

  it("commits to the domain tag — bumping the tag invalidates the preimage shape", () => {
    expect(SIGNING_DOMAIN_TAG).toBe("pharmax/audit-merkle/v1");
    expect(buildSigningPreimage(exampleSigningInput()).toString("utf8")).toContain(
      SIGNING_DOMAIN_TAG
    );
  });

  it("derives the same signerKid from a deterministic seed", () => {
    const seed = Buffer.alloc(32, 0x42);
    const signerA = new LocalEd25519Signer({ seed });
    const signerB = new LocalEd25519Signer({ seed });
    expect(signerA.signerKid).toBe(signerB.signerKid);
  });

  it("rejects a non-32-byte deterministic seed", () => {
    expect(() => new LocalEd25519Signer({ seed: Buffer.alloc(31, 0x00) })).toThrow(
      /seed must be 32 bytes/
    );
  });
});

describe("buildKmsAsymmetricSignerKid", () => {
  it("formats kid as aws:kms:asymm:<keyArn>:v1 by default", () => {
    const kid = buildKmsAsymmetricSignerKid("arn:aws:kms:us-east-1:000000000000:key/abc");
    expect(kid).toBe("aws:kms:asymm:arn:aws:kms:us-east-1:000000000000:key/abc:v1");
  });

  it("supports an explicit rotation version suffix", () => {
    const kid = buildKmsAsymmetricSignerKid("arn:aws:kms:us-east-1:000000000000:key/abc", "v2");
    expect(kid).toMatch(/:v2$/);
  });

  it("rejects an empty keyArn", () => {
    expect(() => buildKmsAsymmetricSignerKid("")).toThrow(/keyArn/);
  });
});

/**
 * Construct an in-memory fake KMS client backed by a Node ECDSA-P256
 * keypair. We use the SAME keypair across `sign` and `getPublicKey`
 * so the fake mirrors KMS' "GetPublicKey returns the verification
 * key for the signing identity" contract.
 */
function buildFakeKmsClient(options?: {
  keyArn?: string;
  keySpec?: string;
  keyUsage?: string;
  signImpl?: (preimage: Buffer) => Promise<Uint8Array>;
  publicKeyDer?: Uint8Array;
}): {
  client: KmsAsymmetricSigningClient;
  publicKey: ReturnType<typeof createPublicKey>;
  privateKey: ReturnType<typeof createPrivateKey>;
  callLog: { sign: number; getPublicKey: number };
} {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const callLog = { sign: 0, getPublicKey: 0 };
  const keyArn = options?.keyArn ?? "arn:aws:kms:us-east-1:000000000000:key/test";
  const client: KmsAsymmetricSigningClient = {
    async sign(input) {
      callLog.sign += 1;
      if (input.SigningAlgorithm !== "ECDSA_SHA_256") {
        throw new Error(`unexpected SigningAlgorithm: ${input.SigningAlgorithm}`);
      }
      if (input.MessageType !== "RAW") {
        throw new Error(`unexpected MessageType: ${input.MessageType}`);
      }
      const sig =
        options?.signImpl !== undefined
          ? await options.signImpl(input.Message)
          : cryptoSign("sha256", input.Message, privateKey);
      return { Signature: sig, KeyId: keyArn, SigningAlgorithm: input.SigningAlgorithm };
    },
    async getPublicKey() {
      callLog.getPublicKey += 1;
      const spkiDer = options?.publicKeyDer ?? publicKey.export({ format: "der", type: "spki" });
      return {
        PublicKey: spkiDer instanceof Uint8Array ? spkiDer : Uint8Array.from(spkiDer),
        KeyId: keyArn,
        KeySpec: options?.keySpec ?? "ECC_NIST_P256",
        KeyUsage: options?.keyUsage ?? "SIGN_VERIFY",
      };
    },
  };
  return { client, publicKey, privateKey, callLog };
}

describe("KmsAsymmetricSigner", () => {
  const keyArn = "arn:aws:kms:us-east-1:000000000000:key/aaaa-bbbb";

  it("produces a DER ECDSA signature verifiable with the cached public key", async () => {
    const fake = buildFakeKmsClient({ keyArn });
    const signer = new KmsAsymmetricSigner({ keyArn, kmsClient: fake.client });
    const inp = exampleSigningInput();
    const out = await signer.sign(inp);
    expect(out.algorithm).toBe("ecdsa_sha_256");
    expect(out.signerKid).toBe(`aws:kms:asymm:${keyArn}:v1`);
    expect(out.signature.length).toBeGreaterThan(0);
    const ok = cryptoVerify("sha256", buildSigningPreimage(inp), fake.publicKey, out.signature);
    expect(ok).toBe(true);
  });

  it("caches the public key — concurrent GetPublicKey calls coalesce into one fetch", async () => {
    const fake = buildFakeKmsClient({ keyArn });
    const signer = new KmsAsymmetricSigner({ keyArn, kmsClient: fake.client });
    const [pemA, pemB, pemC] = await Promise.all([
      signer.getPublicKeyPem(),
      signer.getPublicKeyPem(),
      signer.getPublicKeyPem(),
    ]);
    expect(pemA).toBe(pemB);
    expect(pemB).toBe(pemC);
    expect(fake.callLog.getPublicKey).toBe(1);
    const pem4 = await signer.getPublicKeyPem();
    expect(pem4).toBe(pemA);
    expect(fake.callLog.getPublicKey).toBe(1);
  });

  it("rejects a KMS key with the wrong KeySpec at first GetPublicKey", async () => {
    const fake = buildFakeKmsClient({ keyArn, keySpec: "RSA_2048" });
    const signer = new KmsAsymmetricSigner({ keyArn, kmsClient: fake.client });
    await expect(signer.getPublicKeyPem()).rejects.toMatchObject({
      code: MERKLE_PUBLIC_KEY_FETCH_FAILED,
    });
  });

  it("rejects a KMS key whose KeyUsage is not SIGN_VERIFY", async () => {
    const fake = buildFakeKmsClient({ keyArn, keyUsage: "ENCRYPT_DECRYPT" });
    const signer = new KmsAsymmetricSigner({ keyArn, kmsClient: fake.client });
    await expect(signer.getPublicKeyPem()).rejects.toMatchObject({
      code: MERKLE_PUBLIC_KEY_FETCH_FAILED,
    });
  });

  it("maps a KMS Sign SDK error to MERKLE_SIGN_FAILED with the AWS error name", async () => {
    const fake = buildFakeKmsClient({
      keyArn,
      signImpl: () => {
        const err = new Error("AccessDenied: not authorized to call kms:Sign");
        err.name = "AccessDeniedException";
        throw err;
      },
    });
    const signer = new KmsAsymmetricSigner({ keyArn, kmsClient: fake.client });
    await expect(signer.sign(exampleSigningInput())).rejects.toMatchObject({
      code: MERKLE_SIGN_FAILED,
    });
  });

  it("rejects construction with an empty keyArn", () => {
    expect(
      () => new KmsAsymmetricSigner({ keyArn: "", kmsClient: {} as KmsAsymmetricSigningClient })
    ).toThrow(/keyArn/);
  });

  it("binds the signature to the period — swapping periodEnd invalidates the signature", async () => {
    const fake = buildFakeKmsClient({ keyArn });
    const signer = new KmsAsymmetricSigner({ keyArn, kmsClient: fake.client });
    const inp = exampleSigningInput();
    const out = await signer.sign(inp);
    const tampered = { ...inp, periodEnd: new Date(inp.periodEnd.getTime() + 1) };
    const ok = cryptoVerify(
      "sha256",
      buildSigningPreimage(tampered),
      fake.publicKey,
      out.signature
    );
    expect(ok).toBe(false);
  });

  it("does not include any secret in the cached PEM (smoke check)", async () => {
    const fake = buildFakeKmsClient({ keyArn });
    const signer = new KmsAsymmetricSigner({ keyArn, kmsClient: fake.client });
    const pem = await signer.getPublicKeyPem();
    expect(pem.startsWith("-----BEGIN PUBLIC KEY-----")).toBe(true);
    expect(pem.includes("PRIVATE KEY")).toBe(false);
  });

  it("emits a stable signature length distribution across many runs (sanity)", async () => {
    const fake = buildFakeKmsClient({ keyArn });
    const signer = new KmsAsymmetricSigner({ keyArn, kmsClient: fake.client });
    const lengths = new Set<number>();
    for (let i = 0; i < 8; i++) {
      const out = await signer.sign({
        ...exampleSigningInput(),
        rootHash: randomBytes(32),
      });
      lengths.add(out.signature.length);
    }
    // ECDSA-P256 DER signatures vary between ~70-72 bytes depending
    // on r/s leading-zero stripping. Catch a runaway algorithm bug
    // that produced fixed-size 32-byte raw signatures, etc.
    for (const len of lengths) {
      expect(len).toBeGreaterThanOrEqual(68);
      expect(len).toBeLessThanOrEqual(72);
    }
  });
});
