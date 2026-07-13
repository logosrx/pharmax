// applyNewPassword — the shared "set a new password" core used by both
// ChangePassword and ResetPassword.
//
// Enforces (in order): the structural policy, the breach screen, and the
// anti-reuse history window; then hashes (Argon2id), stores the hash on
// the user, appends it to `password_history`, and prunes history beyond
// the policy depth. Throws `passwordPolicyViolationError` /
// `passwordReusedError` before any write.
//
// Callers own authentication (current-password check, or reset-token
// validation) and session revocation; this helper is purely the
// validate-and-store step so both paths apply identical policy.

import type { Prisma } from "@pharmax/database";

import type { AuthConfiguration } from "../configure.js";
import { passwordPolicyViolationError, passwordReusedError } from "../errors.js";
import { checkNotBreached, evaluatePasswordPolicy } from "./policy.js";

type PasswordDbClient = Pick<Prisma.TransactionClient, "user" | "passwordHistory">;

export async function applyNewPassword(input: {
  readonly tx: PasswordDbClient;
  readonly userId: string;
  readonly organizationId: string;
  readonly plaintext: string;
  /** Substrings the password must not contain (email local-part, name). */
  readonly disallowedSubstrings: ReadonlyArray<string>;
  /** The current stored hash, if any (included in the reuse check). */
  readonly currentHash: string | null;
  readonly config: AuthConfiguration;
  readonly now: Date;
}): Promise<string> {
  const { tx, userId, organizationId, plaintext, config, now } = input;

  // Policy: structural + breach.
  const structural = evaluatePasswordPolicy({
    plaintext,
    policy: config.password,
    disallowedSubstrings: input.disallowedSubstrings,
  });
  const breach = await checkNotBreached({ plaintext, policy: config.password });
  const violations = [...structural.violations, ...breach.violations];
  if (violations.length > 0) {
    throw passwordPolicyViolationError({ violations });
  }

  // Anti-reuse: current hash + recent history.
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
