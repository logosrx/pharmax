// applyNewPassword — the shared "set a new password" core used by
// AcceptInvite, ChangePassword and ResetPassword.
//
// Enforces (in order): the structural policy merged with the
// PRE-COMPUTED breach verdict, then the anti-reuse history window; then
// hashes (Argon2id), stores the hash on the user, appends it to
// `password_history`, and prunes history beyond the policy depth.
// Throws `passwordPolicyViolationError` / `passwordReusedError` before
// any write.
//
// The breach verdict arrives as a required `breachScreen` argument
// rather than being fetched here. Fetching it here meant an outbound
// call to a third-party corpus with `tx` open; the argument is now the
// compiler's way of insisting the caller screened the password before
// the transaction started. See breach-screen.ts for the full reasoning.
//
// Callers own authentication (current-password check, or reset-token
// validation) and session revocation; this helper is purely the
// validate-and-store step so both paths apply identical policy.

import type { Prisma } from "@pharmax/database";

import type { AuthConfiguration } from "../configure.js";
import { passwordPolicyViolationError, passwordReusedError } from "../errors.js";
import type { BreachScreen } from "./breach-screen.js";
import { evaluatePasswordPolicy, type PasswordPolicy } from "./policy.js";

type PasswordDbClient = Pick<Prisma.TransactionClient, "user" | "passwordHistory">;

/**
 * Structural policy + the pre-computed breach verdict, as one gate.
 * Throws `passwordPolicyViolationError` listing every violation found.
 *
 * Safe to call inside a transaction: `evaluatePasswordPolicy` is pure
 * and synchronous, and the breach verdict was decided before the
 * transaction opened.
 */
export function assertPasswordMeetsPolicy(input: {
  readonly plaintext: string;
  readonly policy: PasswordPolicy;
  /** Substrings the password must not contain (email local-part, name). */
  readonly disallowedSubstrings: ReadonlyArray<string>;
  /** Verdict from `withScreenedPassword`, via `requireBreachScreen`. */
  readonly breachScreen: BreachScreen;
}): void {
  const structural = evaluatePasswordPolicy({
    plaintext: input.plaintext,
    policy: input.policy,
    disallowedSubstrings: input.disallowedSubstrings,
  });
  const violations = [...structural.violations, ...input.breachScreen.violations];
  if (violations.length > 0) {
    throw passwordPolicyViolationError({ violations });
  }
}

export async function applyNewPassword(input: {
  readonly tx: PasswordDbClient;
  readonly userId: string;
  readonly organizationId: string;
  readonly plaintext: string;
  /** Substrings the password must not contain (email local-part, name). */
  readonly disallowedSubstrings: ReadonlyArray<string>;
  /** The current stored hash, if any (included in the reuse check). */
  readonly currentHash: string | null;
  /** Verdict from `withScreenedPassword`, via `requireBreachScreen`. */
  readonly breachScreen: BreachScreen;
  readonly config: AuthConfiguration;
  readonly now: Date;
}): Promise<string> {
  const { tx, userId, organizationId, plaintext, config, now } = input;

  assertPasswordMeetsPolicy({
    plaintext,
    policy: config.password,
    disallowedSubstrings: input.disallowedSubstrings,
    breachScreen: input.breachScreen,
  });

  // Anti-reuse: current hash + recent history. This is the one gate
  // that genuinely needs `tx`, so it stays inside the transaction.
  const history = await tx.passwordHistory.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    take: config.password.historyDepth,
    select: { hashedPassword: true },
  });
  const priorHashes = [
    ...(input.currentHash === null ? [] : [input.currentHash]),
    ...history.map((h) => h.hashedPassword),
  ];
  for (const priorHash of priorHashes) {
    if (await config.hasher.verify(priorHash, plaintext)) {
      throw passwordReusedError();
    }
  }

  const newHash = await config.hasher.hash(plaintext);
  await tx.user.update({ where: { id: userId }, data: { hashedPassword: newHash } });
  await tx.passwordHistory.create({
    data: { organizationId, userId, hashedPassword: newHash, createdAt: now },
  });

  // Prune history beyond the policy depth (keep newest N).
  const keep = await tx.passwordHistory.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    take: config.password.historyDepth,
    select: { id: true },
  });
  if (keep.length === config.password.historyDepth) {
    await tx.passwordHistory.deleteMany({
      where: { userId, id: { notIn: keep.map((k) => k.id) } },
    });
  }

  return newHash;
}
