// Shared probe adapters that bridge `@pharmax/security`'s
// digest/verification ports to the live `@pharmax/database` Prisma
// client. Kept under `scripts/security/` (not under the package)
// because they are the "outside the package boundary" wiring layer
// — the package itself remains free of any Prisma model assumptions
// beyond the audit_log/audit_chain_state schema.

import { verifyChain } from "@pharmax/audit";
import type { PrismaClient } from "@pharmax/database";
import type { logger as loggerContract } from "@pharmax/platform-core";
import {
  createPrismaAuditChainSource,
  type AuditChainStatus,
  type AuditChainStatusProbe,
} from "@pharmax/security";
import { withSystemContext } from "@pharmax/tenancy";

type Logger = loggerContract.Logger;

/**
 * Build an `AuditChainStatusProbe` that walks every organization's
 * audit chain via `verifyChain` and reports the result. Failures are
 * surfaced as a `{ valid: false, reason }` row — exceptions are
 * caught and converted, NEVER thrown out of the probe (the digest
 * pipeline must keep going).
 */
export function verifyChainProbeFromPrisma(prisma: PrismaClient): AuditChainStatusProbe {
  return {
    async verifyAllOrgs(args: {
      readonly logger: Logger;
    }): Promise<ReadonlyArray<AuditChainStatus>> {
      const orgs = await withSystemContext("security:list-orgs-for-chain-verify", () =>
        prisma.organization.findMany({ select: { id: true } })
      );
      const out: AuditChainStatus[] = [];
      const source = createPrismaAuditChainSource(prisma);
      for (const org of orgs) {
        try {
          const result = await withSystemContext("security:verify-chain", () =>
            verifyChain(source, { organizationId: org.id })
          );
          out.push({
            organizationId: org.id,
            valid: true,
            verifiedRows: result.verifiedRows,
            lastSeq: result.lastSeq === null ? null : result.lastSeq.toString(),
          });
        } catch (cause) {
          const reason = cause instanceof Error ? `${cause.name}: ${cause.message}` : "unknown";
          const seq = extractSeqFromError(cause);
          args.logger.error("digest.chain.broken", {
            organizationId: org.id,
            reason,
            seq,
          });
          out.push({
            organizationId: org.id,
            valid: false,
            reason,
            seq,
          });
        }
      }
      return out;
    },
  };
}

function extractSeqFromError(cause: unknown): string | null {
  if (cause === null || typeof cause !== "object") return null;
  const metadata = (cause as { metadata?: unknown }).metadata;
  if (metadata === null || typeof metadata !== "object") return null;
  const seq = (metadata as { seq?: unknown }).seq;
  if (typeof seq === "string") return seq;
  if (typeof seq === "bigint") return seq.toString();
  if (typeof seq === "number") return seq.toString();
  return null;
}
