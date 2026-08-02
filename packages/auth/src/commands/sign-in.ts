// SignIn — the successful-authentication command.
//
// A SYSTEM command: at sign-in there is no user tenancy context yet, but
// the target organization IS known (the web tier resolves it from the
// sign-in subdomain and passes `organizationId`). Running through the bus
// gives us `command_log` + `audit_log` ("user.signed_in") + `event_outbox`
// ("user.signed_in.v1") for free — the centralized audit contract.
//
// This command is the SUCCESS path only. Any failure (bad password,
// inactive user, MFA required/invalid) THROWS a typed AuthenticationError;
// the bus rolls the tx back and writes no command_log. The
// `signIn` orchestration wrapper (../sign-in.ts) records the failure in
// the `login_attempt` ledger (its own committed tx) and enforces lockout.
//
// Second factor (ADR-0036): the MFA branch accepts EITHER a TOTP /
// recovery code (`mfaCode`) OR a WebAuthn assertion (`webauthn`, minted
// via StartWebAuthnAuthentication). Both proofs satisfy the same
// `mfaSatisfied` session flag — downstream floors don't know or care
// which factor type was used.
//
// PHI rule: no PHI here — operator email/displayName only. `password`,
// `mfaCode`, `webauthn` (input) and `rawToken` (output) are on the bus
// redaction allowlist so they never reach `command_log`.

import { WebAuthnCeremony } from "@pharmax/database";
import type { SystemCommand, SystemHandlerResult } from "@pharmax/command-bus";
import { z } from "zod";

import { getAuthConfiguration } from "../configure.js";
import { mfaInvalidError, mfaRequiredError } from "../errors.js";
import { verifyRecoveryCode } from "../mfa/recovery-codes.js";
import { openTotpSecret } from "../mfa/secret-seal.js";
import { verifyTotpCode } from "../mfa/totp.js";
import { consumeWebAuthnChallenge } from "../mfa/webauthn-challenge.js";
import { verifyFirstFactor } from "../password/verify-first-factor.js";
import { createSessionInTx } from "../session/service.js";

const webauthnAssertionSchema = z
  .object({
    challengeId: z.string().uuid(),
    /** Relying-party id + origin, resolved by the web tier — not the browser. */
    rpId: z.string().min(1).max(253),
    origin: z.string().url().max(512),
    /** The browser's `startAuthentication()` response JSON (untrusted). */
    response: z.unknown(),
  })
  .strict();

const inputSchema = z
  .object({
    organizationId: z.string().uuid(),
    email: z.string().email().max(320),
    password: z.string().min(1).max(1024),
    /** TOTP code or recovery code, when the account has MFA enrolled. */
    mfaCode: z.string().min(1).max(64).optional(),
    /** WebAuthn assertion, as the alternative second factor (ADR-0036). */
    webauthn: webauthnAssertionSchema.optional(),
    ipAddress: z.string().max(64).optional(),
    userAgent: z.string().max(512).optional(),
  })
  .strict();

export type SignInInput = z.infer<typeof inputSchema>;

export interface SignInOutput {
  readonly userId: string;
  readonly organizationId: string;
  readonly sessionId: string;
  /** Bearer session token. Redacted from command_log; returned to caller. */
  readonly rawToken: string;
  readonly mfaSatisfied: boolean;
}

export const SignIn: SystemCommand<SignInInput, SignInOutput> = {
  name: "SignIn",
  inputSchema,
  redactFields: ["password", "mfaCode", "webauthn", "rawToken"],

  async handle({ input, tx, commandLogId, clock }): Promise<SystemHandlerResult<SignInOutput>> {
    const config = getAuthConfiguration();
    const now = clock.now();
    const email = input.email.toLowerCase();

    const firstFactor = await verifyFirstFactor({
      tx,
      organizationId: input.organizationId,
      email,
      password: input.password,
    });
    const userId = firstFactor.userId;

    // Transparent KDF upgrade: if the stored hash used weaker params
    // than the current policy, re-hash with the verified plaintext.
    let rehashed = false;
    if (config.hasher.needsRehash(firstFactor.hashedPassword)) {
      const upgraded = await config.hasher.hash(input.password);
      await tx.user.update({ where: { id: userId }, data: { hashedPassword: upgraded } });
      rehashed = true;
    }

    // MFA floor: required if the user holds a floor role OR has MFA on.
    const roleCodes = await loadRoleCodes(tx, userId, input.organizationId);
    const requiredByRole = intersects(roleCodes, config.mfa.requiredRoleCodes);
    const mfaRequired = requiredByRole || firstFactor.mfaEnrolled;

    let mfaMethod: "TOTP" | "WEBAUTHN" | null = null;
    if (mfaRequired) {
      const [enrollment, webAuthnCredentials] = await Promise.all([
        tx.mfaEnrollment.findFirst({
          where: { userId, disabledAt: null, verifiedAt: { not: null } },
          select: { id: true, secretCiphertext: true },
        }),
        tx.webAuthnCredential.findMany({
          where: { userId, disabledAt: null },
          select: {
            id: true,
            credentialId: true,
            publicKey: true,
            counter: true,
            transports: true,
          },
        }),
      ]);

      const methods: string[] = [];
      if (enrollment !== null) methods.push("TOTP");
      if (webAuthnCredentials.length > 0) methods.push("WEBAUTHN");

      if (methods.length === 0) {
        // Floor role with no authenticator yet — must enroll before
        // access. The web tier routes MFA_REQUIRED(enrolled:false) to
        // the enrollment flow.
        throw mfaRequiredError({ userId, enrolled: false, methods });
      }

      if (input.webauthn !== undefined) {
        if (webAuthnCredentials.length === 0) {
          throw mfaInvalidError();
        }
        const verified = await verifyWebAuthnAssertion({
          tx,
          userId,
          assertion: input.webauthn,
          credentials: webAuthnCredentials,
          now,
        });
        if (!verified) {
          throw mfaInvalidError();
        }
        mfaMethod = "WEBAUTHN";
      } else if (input.mfaCode !== undefined) {
        if (enrollment === null) {
          // Codes can't satisfy a WebAuthn-only account — recovery
          // codes are still accepted below only when TOTP is enrolled;
          // WebAuthn-only accounts use their key or a recovery code.
          const recovered = await tryRecoveryCode(tx, userId, input.mfaCode);
          if (!recovered) {
            throw mfaInvalidError();
          }
          mfaMethod = "TOTP";
        } else {
          const verified = await verifyMfaCode({
            tx,
            userId,
            organizationId: input.organizationId,
            secretCiphertext: enrollment.secretCiphertext,
            code: input.mfaCode,
          });
          if (!verified) {
            throw mfaInvalidError();
          }
          mfaMethod = "TOTP";
        }
      } else {
        throw mfaRequiredError({ userId, enrolled: true, methods });
      }
    }

    // We only reach here once the MFA step (if any) is satisfied.
    const session = await createSessionInTx({
      tx,
      userId,
      organizationId: input.organizationId,
      mfaSatisfied: true,
      ipAddress: input.ipAddress ?? null,
      userAgent: input.userAgent ?? null,
      config,
    });

    await tx.user.update({ where: { id: userId }, data: { lastLoginAt: now } });

    const output: SignInOutput = {
      userId,
      organizationId: input.organizationId,
      sessionId: session.sessionId,
      rawToken: session.rawToken,
      mfaSatisfied: true,
    };

    return {
      output,
      targetOrganizationId: input.organizationId,
      audit: {
        action: "user.signed_in",
        resourceType: "User",
        resourceId: userId,
        metadata: { commandLogId, mfaUsed: mfaMethod !== null, mfaMethod, rehashed },
      },
      outboxEvents: [
        {
          eventType: "user.signed_in.v1",
          aggregateType: "User",
          aggregateId: userId,
          payload: {
            userId,
            organizationId: input.organizationId,
            sessionId: session.sessionId,
            mfaUsed: mfaMethod !== null,
            occurredAt: now.toISOString(),
          },
        },
      ],
    };
  },
};

// --- helpers ---------------------------------------------------------------

type TxLike = Parameters<SystemCommand<SignInInput, SignInOutput>["handle"]>[0]["tx"];

async function loadRoleCodes(
  tx: TxLike,
  userId: string,
  organizationId: string
): Promise<ReadonlySet<string>> {
  const rows = await tx.userRole.findMany({
    where: { userId, organizationId },
    select: { role: { select: { code: true } } },
  });
  return new Set(rows.map((r) => r.role.code));
}

function intersects(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  for (const x of a) {
    if (b.has(x)) return true;
  }
  return false;
}

/**
 * Verify a WebAuthn assertion against the challenge minted by
 * StartWebAuthnAuthentication. The challenge is consumed in this same
 * tx BEFORE any cryptographic check, so a replayed assertion dies on
 * the consumed row. The stored signature counter is advanced on
 * success (clone detection — a regression rejects inside the adapter).
 */
async function verifyWebAuthnAssertion(input: {
  readonly tx: TxLike;
  readonly userId: string;
  readonly assertion: z.infer<typeof webauthnAssertionSchema>;
  readonly credentials: ReadonlyArray<{
    readonly id: string;
    readonly credentialId: string;
    readonly publicKey: string;
    readonly counter: bigint;
    readonly transports: ReadonlyArray<string>;
  }>;
  readonly now: Date;
}): Promise<boolean> {
  const config = getAuthConfiguration();

  const { challenge } = await consumeWebAuthnChallenge({
    tx: input.tx,
    challengeId: input.assertion.challengeId,
    userId: input.userId,
    purpose: WebAuthnCeremony.AUTHENTICATION,
    now: input.now,
  });

  // The assertion names which credential signed it; it must be one of
  // the user's ACTIVE credentials.
  const responseId = readResponseCredentialId(input.assertion.response);
  const credential =
    responseId === null ? undefined : input.credentials.find((c) => c.credentialId === responseId);
  if (credential === undefined) {
    return false;
  }

  const result = await config.webauthn.adapter.verifyAuthentication({
    response: input.assertion.response,
    expectedChallenge: challenge,
    expectedOrigin: input.assertion.origin,
    expectedRpId: input.assertion.rpId,
    credential: {
      credentialId: credential.credentialId,
      publicKey: credential.publicKey,
      counter: credential.counter,
      transports: credential.transports,
    },
  });
  if (!result.verified) {
    return false;
  }

  await input.tx.webAuthnCredential.update({
    where: { id: credential.id },
    data: { counter: result.newCounter, lastUsedAt: input.now },
  });
  return true;
}

/** Pull the base64url credential id off the untrusted ceremony response. */
function readResponseCredentialId(response: unknown): string | null {
  if (typeof response !== "object" || response === null) return null;
  const id = (response as Record<string, unknown>)["id"];
  return typeof id === "string" && id.length > 0 ? id : null;
}

/**
 * Verify a submitted MFA code against the enrolled TOTP secret, falling
 * back to single-use recovery codes. A consumed recovery code is stamped
 * `usedAt` in the same tx so it cannot be replayed.
 */
async function verifyMfaCode(input: {
  readonly tx: TxLike;
  readonly userId: string;
  readonly organizationId: string;
  readonly secretCiphertext: string;
  readonly code: string;
}): Promise<boolean> {
  const config = getAuthConfiguration();

  const secretBase32 = await openTotpSecret({
    ciphertext: input.secretCiphertext,
    organizationId: input.organizationId,
    userId: input.userId,
  });

  const totpOk = verifyTotpCode({
    secretBase32,
    issuer: config.mfa.issuer,
    accountName: input.userId,
    token: input.code,
    window: config.mfa.totpWindow,
  });
  if (totpOk) return true;

  return tryRecoveryCode(input.tx, input.userId, input.code);
}

/** Compare against unused recovery codes; consume on hit. */
async function tryRecoveryCode(tx: TxLike, userId: string, code: string): Promise<boolean> {
  const config = getAuthConfiguration();
  const codes = await tx.recoveryCode.findMany({
    where: { userId, usedAt: null },
    select: { id: true, codeHash: true },
  });
  for (const row of codes) {
    if (await verifyRecoveryCode(config.hasher, code, row.codeHash)) {
      await tx.recoveryCode.update({
        where: { id: row.id },
        data: { usedAt: config.clock.now() },
      });
      return true;
    }
  }
  return false;
}
