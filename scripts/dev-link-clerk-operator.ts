#!/usr/bin/env tsx
// scripts/dev-link-clerk-operator.ts — DEV ONLY.
//
// Links a Clerk identity to a seeded Pharmax operator row.
//
// Why this exists: in production the link is established by the
// Clerk `user.created` webhook (apps/web clerk-webhook-handlers.ts).
// On a local clone Clerk cannot deliver webhooks to localhost and
// CLERK_WEBHOOK_SECRET is unset, so a freshly signed-up operator
// stays USER_NOT_LINKED forever. This script performs the SAME
// mutation the webhook handler would (set clerkUserId, flip status
// to ACTIVE, write a chain-hashed audit entry) — with the audit
// metadata recording dev-script provenance.
//
//   pnpm tsx scripts/dev-link-clerk-operator.ts \
//     [--operator-email owner@acme.test] [--clerk-email you@example.com]
//
// Defaults: operator-email = owner@acme.test; clerk-email = the most
// recently created user in the Clerk dev instance (fine for a local
// instance that only you sign up to).
//
// Secrets: reads the Clerk secret key from CLERK_SECRET_KEY or the
// keyless-mode file apps/web/.clerk/.tmp/keyless.json. The key is
// used in-process for the API call and never printed.
//
// Refuses to run when NODE_ENV=production.

import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import process from "node:process";

import { writeAuditLogInTx, type AuditChainTxClient } from "@pharmax/audit";
import { prisma, UserStatus } from "@pharmax/database";
import {
  applySystemSessionGuc,
  withSystemContext,
  type SessionGucExecutor,
} from "@pharmax/tenancy";

const KEYLESS_PATH = new URL("../apps/web/.clerk/.tmp/keyless.json", import.meta.url);

interface ClerkApiUser {
  readonly id: string;
  readonly first_name: string | null;
  readonly last_name: string | null;
  readonly primary_email_address_id: string | null;
  readonly email_addresses: ReadonlyArray<{ readonly id: string; readonly email_address: string }>;
}

function primaryEmail(u: ClerkApiUser): string | null {
  const hit =
    u.email_addresses.find((e) => e.id === u.primary_email_address_id) ?? u.email_addresses[0];
  return hit?.email_address.toLowerCase() ?? null;
}

function resolveSecretKey(): string {
  const fromEnv = process.env["CLERK_SECRET_KEY"];
  if (typeof fromEnv === "string" && fromEnv.length > 0) return fromEnv;
  try {
    const parsed = JSON.parse(readFileSync(KEYLESS_PATH, "utf8")) as { secretKey?: string };
    if (typeof parsed.secretKey === "string" && parsed.secretKey.length > 0) {
      return parsed.secretKey;
    }
  } catch {
    /* fall through to the error below */
  }
  throw new Error(
    "No Clerk secret key found. Set CLERK_SECRET_KEY or run the dev server once so " +
      "Clerk keyless mode writes apps/web/.clerk/.tmp/keyless.json."
  );
}

async function main(): Promise<void> {
  if (process.env["NODE_ENV"] === "production") {
    throw new Error(
      "dev-link-clerk-operator is a development tool. Refusing to run in production."
    );
  }

  const { values } = parseArgs({
    options: {
      "operator-email": { type: "string" },
      "clerk-email": { type: "string" },
    },
    strict: true,
  });
  const operatorEmail = (values["operator-email"] ?? "owner@acme.test").toLowerCase();
  const clerkEmailFilter = values["clerk-email"]?.toLowerCase() ?? null;

  // ---- Fetch candidate identities from the Clerk dev instance ----
  const secretKey = resolveSecretKey();
  const response = await fetch("https://api.clerk.com/v1/users?limit=20&order_by=-created_at", {
    headers: { Authorization: `Bearer ${secretKey}` },
  });
  if (!response.ok) {
    throw new Error(`Clerk API responded ${response.status}: ${await response.text()}`);
  }
  const users = (await response.json()) as ClerkApiUser[];
  if (users.length === 0) {
    throw new Error(
      "No users exist in the Clerk dev instance yet. Sign up at http://localhost:3000/sign-up first."
    );
  }

  const clerkUser =
    clerkEmailFilter !== null ? users.find((u) => primaryEmail(u) === clerkEmailFilter) : users[0]; // most recent — fine for a single-person dev instance
  if (clerkUser === undefined) {
    const available = users.map((u) => primaryEmail(u) ?? "(no email)").join(", ");
    throw new Error(`No Clerk user with email ${clerkEmailFilter}. Available: ${available}`);
  }
  const clerkEmail = primaryEmail(clerkUser);
  const displayName =
    [clerkUser.first_name, clerkUser.last_name]
      .filter((s) => s !== null && s.length > 0)
      .join(" ") || null;

  // ---- Perform the link (mirrors clerk-webhook-handlers handleUserCreated) ----
  const outcome = await withSystemContext("dev-link-clerk-operator", () =>
    prisma.$transaction(async (tx) => {
      await applySystemSessionGuc(tx as unknown as SessionGucExecutor, "dev-link-clerk-operator");

      const row = await tx.user.findFirst({
        where: { email: operatorEmail, status: { not: UserStatus.TERMINATED } },
        select: { id: true, organizationId: true, status: true, clerkUserId: true },
      });
      if (row === null) {
        throw new Error(
          `No Pharmax user row with email ${operatorEmail}. Run \`pnpm db:seed\` (and ` +
            `scripts/seed-demo-orders.ts for pharmacist@acme.test) first.`
        );
      }
      if (row.clerkUserId !== null && row.clerkUserId !== clerkUser.id) {
        // Same takeover-refusal posture as the webhook handler.
        throw new Error(
          `Operator row ${row.id} is already linked to a different Clerk identity ` +
            `(${row.clerkUserId}). Refusing to re-link; clear it manually if intentional.`
        );
      }

      await tx.user.update({
        where: { id: row.id },
        data: {
          clerkUserId: clerkUser.id,
          status: UserStatus.ACTIVE,
          ...(displayName !== null ? { displayName } : {}),
        },
      });

      await writeAuditLogInTx(tx as unknown as AuditChainTxClient, {
        organizationId: row.organizationId,
        actorUserId: null,
        action: "user.clerk_linked",
        resourceType: "User",
        resourceId: row.id,
        scope: { organizationId: row.organizationId },
        metadata: {
          clerkUserId: clerkUser.id,
          email: operatorEmail,
          ...(clerkEmail !== null ? { clerkEmail } : {}),
          provenance: "dev-link-clerk-operator script (local webhook substitute)",
        },
        occurredAt: new Date(),
      });

      return { userId: row.id, previousStatus: row.status };
    })
  );

  process.stdout.write(
    `✓ Linked Clerk user ${clerkUser.id} (${clerkEmail ?? "no email"}) → Pharmax operator ` +
      `${outcome.userId} (${operatorEmail}); status ${outcome.previousStatus} → ACTIVE\n` +
      `  Refresh the browser — the operator console should now load.\n`
  );
  await prisma.$disconnect();
}

main().catch(async (cause: unknown) => {
  process.stderr.write(`\n${cause instanceof Error ? cause.message : String(cause)}\n`);
  await prisma.$disconnect().catch(() => undefined);
  process.exit(1);
});
