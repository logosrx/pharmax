// Server-side WebAuthn challenge lifecycle (ADR-0036).
//
// Challenges are single-use rows: minted with a short TTL, consumed
// (stamped `consumedAt`) in the SAME transaction as the cryptographic
// verification, so a replayed ceremony response dies on the consumed
// row before any signature check runs. Expired rows for the same
// user+purpose are purged opportunistically at mint time — no cron.

import type { WebAuthnCeremony } from "@pharmax/database";

import { webAuthnChallengeInvalidError } from "../errors.js";

/** Minimal structural slice of the Prisma tx the helpers need. */
export interface WebAuthnChallengeTx {
  readonly webAuthnChallenge: {
    deleteMany(args: {
      where: { userId: string; purpose: WebAuthnCeremony; expiresAt: { lt: Date } };
    }): Promise<unknown>;
    create(args: {
      data: {
        organizationId: string;
        userId: string;
        purpose: WebAuthnCeremony;
        challenge: string;
        expiresAt: Date;
        createdAt: Date;
      };
      select: { id: true };
    }): Promise<{ id: string }>;
    findUnique(args: {
      where: { id: string };
      select: {
        id: true;
        userId: true;
        purpose: true;
        challenge: true;
        expiresAt: true;
        consumedAt: true;
      };
    }): Promise<{
      id: string;
      userId: string;
      purpose: WebAuthnCeremony;
      challenge: string;
      expiresAt: Date;
      consumedAt: Date | null;
    } | null>;
    update(args: { where: { id: string }; data: { consumedAt: Date } }): Promise<unknown>;
  };
}

export async function mintWebAuthnChallenge(input: {
  readonly tx: WebAuthnChallengeTx;
  readonly organizationId: string;
  readonly userId: string;
  readonly purpose: WebAuthnCeremony;
  readonly challenge: string;
  readonly now: Date;
  readonly ttlMs: number;
}): Promise<{ readonly challengeId: string }> {
  await input.tx.webAuthnChallenge.deleteMany({
    where: { userId: input.userId, purpose: input.purpose, expiresAt: { lt: input.now } },
  });
  const row = await input.tx.webAuthnChallenge.create({
    data: {
      organizationId: input.organizationId,
      userId: input.userId,
      purpose: input.purpose,
      challenge: input.challenge,
      expiresAt: new Date(input.now.getTime() + input.ttlMs),
      createdAt: input.now,
    },
    select: { id: true },
  });
  return { challengeId: row.id };
}

/**
 * Load-validate-consume a challenge in one step. Throws the same typed
 * `WEBAUTHN_CHALLENGE_INVALID` for every failure mode (unknown id,
 * wrong user, wrong purpose, expired, already consumed) — the caller
 * never learns WHICH check failed.
 */
export async function consumeWebAuthnChallenge(input: {
  readonly tx: WebAuthnChallengeTx;
  readonly challengeId: string;
  readonly userId: string;
  readonly purpose: WebAuthnCeremony;
  readonly now: Date;
}): Promise<{ readonly challenge: string }> {
  const row = await input.tx.webAuthnChallenge.findUnique({
    where: { id: input.challengeId },
    select: {
      id: true,
      userId: true,
      purpose: true,
      challenge: true,
      expiresAt: true,
      consumedAt: true,
    },
  });
  if (
    row === null ||
    row.userId !== input.userId ||
    row.purpose !== input.purpose ||
    row.consumedAt !== null ||
    row.expiresAt.getTime() <= input.now.getTime()
  ) {
    throw webAuthnChallengeInvalidError();
  }
  await input.tx.webAuthnChallenge.update({
    where: { id: row.id },
    data: { consumedAt: input.now },
  });
  return { challenge: row.challenge };
}
