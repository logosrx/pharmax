// Provider-onboarding NPPES proofing drain (ADR-0033, slice 1).
//
// Each tick:
//   1. In system context, claim up to `batchSize` SUBMITTED
//      applications (oldest first).
//   2. Per application: resolve the org's ProviderOnboardingService
//      machine user (`provider-onboarding@<org-slug>.test`), enter
//      the org's tenancy frame, fetch the NPI from the public CMS
//      NPPES registry, evaluate the match rules
//      (`evaluateProofing`), and dispatch
//      `RecordProviderOnboardingProofing` with the verdict.
//   3. Registry failures (429/5xx/network after the client's own
//      retries) increment `proofingAttempts` and leave the row
//      SUBMITTED for the next tick; once `maxRegistryAttempts` is
//      reached the verdict REGISTRY_UNAVAILABLE routes the
//      application to the ops review queue — a human decides, the
//      applicant is never silently stuck.
//
// Concurrency: no claim marker. Two pods proofing the same
// application race benignly — the command's SUBMITTED state check
// makes the loser's dispatch a typed
// PROVIDER_ONBOARDING_INVALID_STATE conflict, tallied as SKIPPED.
//
// Cross-tenant scope: identical pattern to `npi-sync-scheduler.ts`
// — system-context claim, per-org tenancy for dispatch. Legitimate
// system-context bridge.
//
// Slice 2 (ADR-0033): a PASS auto-approval also provisions a
// PENDING_SETUP portal account inside the command's transaction.
// Post-commit — and only for a NON-replayed dispatch — this drain
// mints the one-time setup token (`issuePortalSetupToken`) and
// hands the raw token to the mailer port. Delivery is best-effort:
// a mail failure never fails the tick (ops can resend a link).

import { executeCommandDetailed } from "@pharmax/command-bus";
import type { PrismaClient } from "@pharmax/database";
import { errors, ids } from "@pharmax/platform-core";
import type { clock as clockContract, logger as loggerContract } from "@pharmax/platform-core";
import {
  buildProofingSnapshotJson,
  evaluateProofing,
  issuePortalSetupToken,
  NOOP_PORTAL_SETUP_MAILER,
  RecordProviderOnboardingProofing,
  PROVIDER_ONBOARDING_INVALID_STATE,
  type CmsNppesClient,
  type PortalSetupMailer,
  type RecordProviderOnboardingProofingOutput,
} from "@pharmax/providers";
import { buildTenancyContext, withSystemContext, withTenancyContext } from "@pharmax/tenancy";

type Logger = loggerContract.Logger;
type Clock = clockContract.Clock;

export type ProviderOnboardingProverPrismaSurface = Pick<
  PrismaClient,
  "providerOnboardingApplication" | "user"
>;

export interface ProviderOnboardingProverDeps {
  readonly client: ProviderOnboardingProverPrismaSurface;
  readonly logger: Logger;
  readonly clock: Clock;
  readonly cmsClient: Pick<CmsNppesClient, "fetchByNpi">;
  /**
   * Local-part of the per-org service-user email. Defaults to
   * `provider-onboarding`; full email is
   * `${actorEmailLocalPart}@${org.slug}.test` per the seed
   * convention.
   */
  readonly actorEmailLocalPart?: string;
  /**
   * Delivery port for portal setup links after an auto-approval
   * (ADR-0033 slice 2). Defaults to the silent no-op — safe but
   * non-functional; main.ts wires the real adapter.
   */
  readonly portalSetupMailer?: PortalSetupMailer;
}

export interface ProviderOnboardingProverOptions {
  /** Max applications claimed per tick. */
  readonly batchSize: number;
  /**
   * Registry-fetch failures tolerated before the application is
   * routed to review with REGISTRY_UNAVAILABLE.
   */
  readonly maxRegistryAttempts: number;
}

export interface ProviderOnboardingProverTickResult {
  readonly claimed: number;
  readonly proofed: number;
  readonly deferred: number;
  readonly skipped: number;
  readonly failed: number;
}

export interface ProviderOnboardingProver {
  tick(): Promise<ProviderOnboardingProverTickResult>;
}

export function createProviderOnboardingProver(
  deps: ProviderOnboardingProverDeps,
  options: ProviderOnboardingProverOptions
): ProviderOnboardingProver {
  const log = deps.logger.child({ component: "provider-onboarding-prover" });
  const actorEmailLocalPart = deps.actorEmailLocalPart ?? "provider-onboarding";

  return {
    async tick(): Promise<ProviderOnboardingProverTickResult> {
      const apps = await withSystemContext(
        "worker:provider-onboarding-prover:claim",
        async () =>
          await deps.client.providerOnboardingApplication.findMany({
            where: { status: "SUBMITTED" },
            orderBy: { createdAt: "asc" },
            take: options.batchSize,
            select: {
              id: true,
              organizationId: true,
              npi: true,
              firstName: true,
              lastName: true,
              credential: true,
              email: true,
              proofingAttempts: true,
              organization: { select: { slug: true } },
            },
          })
      );

      const tally = { claimed: apps.length, proofed: 0, deferred: 0, skipped: 0, failed: 0 };
      if (apps.length === 0) return Object.freeze(tally);
      log.info("provider-onboarding-prover.claimed", { claimed: apps.length });

      // Sequential on purpose: every fetch rides the CMS client's
      // shared rate gate, so fan-out would only queue.
      for (const app of apps) {
        const outcome = await processApplication({
          deps,
          options,
          actorEmailLocalPart,
          app,
          log,
        });
        tally[outcome] += 1;
      }
      return Object.freeze(tally);
    },
  };
}

interface ClaimedApplication {
  readonly id: string;
  readonly organizationId: string;
  readonly npi: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly credential: string | null;
  readonly email: string;
  readonly proofingAttempts: number;
  readonly organization: { readonly slug: string };
}

async function processApplication(args: {
  readonly deps: ProviderOnboardingProverDeps;
  readonly options: ProviderOnboardingProverOptions;
  readonly actorEmailLocalPart: string;
  readonly app: ClaimedApplication;
  readonly log: Logger;
}): Promise<"proofed" | "deferred" | "skipped" | "failed"> {
  const { deps, options, app } = args;
  const log = args.log.child({
    applicationId: app.id,
    organizationId: app.organizationId,
  });

  // Resolve the machine actor (system context; no actor to enter
  // the frame as yet).
  const actor = await withSystemContext(
    "worker:provider-onboarding-prover:resolve-actor",
    async () =>
      await deps.client.user.findFirst({
        where: {
          organizationId: app.organizationId,
          email: `${args.actorEmailLocalPart}@${app.organization.slug}.test`,
        },
        select: { id: true },
      })
  );
  if (actor === null) {
    log.warn("provider-onboarding-prover.skipped_no_actor", {
      event: "provider-onboarding-prover.skipped_no_actor",
      reason: "ProviderOnboardingService user not seeded for org",
      expectedEmail: `${args.actorEmailLocalPart}@${app.organization.slug}.test`,
    });
    return "skipped";
  }

  const tenancy = buildTenancyContext({
    organizationId: app.organizationId,
    actor: { userId: actor.id, correlationId: ids.generateUlid() },
  });

  return withTenancyContext(tenancy, async () => {
    // Step 1 — fetch the public registry record.
    let verdict: Parameters<typeof dispatchProofing>[0]["verdict"];
    try {
      const snapshot = await deps.cmsClient.fetchByNpi(app.npi);
      verdict = {
        outcome: evaluateProofing({ lastName: app.lastName }, snapshot),
        snapshot: snapshot === null ? null : buildProofingSnapshotJson(snapshot),
      };
    } catch (cause) {
      const attempts = app.proofingAttempts + 1;
      if (attempts < options.maxRegistryAttempts) {
        // Transient registry trouble: bump the counter, leave the
        // row SUBMITTED, retry next tick. Bookkeeping only — not a
        // workflow transition, so no command.
        await deps.client.providerOnboardingApplication.update({
          where: { id: app.id },
          data: { proofingAttempts: { increment: 1 } },
          select: { id: true },
        });
        log.warn("provider-onboarding-prover.registry_fetch_deferred", {
          event: "provider-onboarding-prover.registry_fetch_deferred",
          attempts,
          maxRegistryAttempts: options.maxRegistryAttempts,
          error: cause,
        });
        return "deferred";
      }
      // Ceiling reached: route to review — never leave the
      // applicant silently stuck behind a registry outage.
      verdict = { outcome: "REGISTRY_UNAVAILABLE", snapshot: null };
    }

    // Step 2 — dispatch the verdict.
    try {
      const { output, replayed } = await dispatchProofing({ app, verdict });
      log.info("provider-onboarding-prover.proofed", {
        event: "provider-onboarding-prover.proofed",
        outcome: verdict.outcome,
      });

      // Step 3 — post-commit setup-link delivery for a fresh
      // auto-approval (never for a replay: the link was already
      // issued the first time this dispatch committed).
      if (!replayed && output.status === "APPROVED" && output.portalAccountId !== null) {
        await deliverPortalSetupLink({
          deps,
          app,
          portalAccountId: output.portalAccountId,
          log,
        });
      }
      return "proofed";
    } catch (cause) {
      if (
        cause instanceof errors.PharmaxError &&
        cause.code === PROVIDER_ONBOARDING_INVALID_STATE
      ) {
        // Lost a benign race: a sibling pod proofed it, or a
        // reviewer decided in the window.
        log.info("provider-onboarding-prover.skipped_state_race", {
          event: "provider-onboarding-prover.skipped_state_race",
        });
        return "skipped";
      }
      log.error("provider-onboarding-prover.dispatch_failed", {
        event: "provider-onboarding-prover.dispatch_failed",
        code: cause instanceof errors.PharmaxError ? cause.code : "UNKNOWN",
        error: cause,
      });
      return "failed";
    }
  });
}

async function dispatchProofing(input: {
  readonly app: ClaimedApplication;
  readonly verdict: {
    readonly outcome:
      | "PASS"
      | "NOT_FOUND"
      | "NOT_INDIVIDUAL"
      | "DEACTIVATED"
      | "NAME_MISMATCH"
      | "REGISTRY_UNAVAILABLE";
    readonly snapshot: Record<string, unknown> | null;
  };
}): Promise<{
  readonly output: RecordProviderOnboardingProofingOutput;
  readonly replayed: boolean;
}> {
  // The attempts counter at claim time keys the dispatch: distinct
  // proofing passes (after deferred registry retries) get distinct
  // idempotency keys, while a straight retry of the SAME pass
  // replays cleanly. `replayed` gates the setup-link delivery.
  return await executeCommandDetailed(
    RecordProviderOnboardingProofing,
    {
      applicationId: input.app.id,
      outcome: input.verdict.outcome,
      ...(input.verdict.snapshot === null ? {} : { snapshot: input.verdict.snapshot }),
    },
    {
      idempotencyKey: `provider-onboarding-proofing:${input.app.id}:${input.app.proofingAttempts}`,
    }
  );
}

/**
 * Best-effort post-commit delivery: mint the one-time setup token
 * (its own system command — audit-logged, raw token redacted) and
 * hand it to the mailer port. Failures are logged WITHOUT the token
 * and never fail the tick — an ops resend can recover.
 */
async function deliverPortalSetupLink(args: {
  readonly deps: ProviderOnboardingProverDeps;
  readonly app: ClaimedApplication;
  readonly portalAccountId: string;
  readonly log: Logger;
}): Promise<void> {
  const mailer = args.deps.portalSetupMailer ?? NOOP_PORTAL_SETUP_MAILER;
  try {
    const issued = await issuePortalSetupToken({
      portalAccountId: args.portalAccountId,
      organizationId: args.app.organizationId,
    });
    const credentialSuffix = args.app.credential === null ? "" : `, ${args.app.credential}`;
    await mailer.sendPortalSetup({
      email: issued.email,
      displayName: `${args.app.firstName} ${args.app.lastName}${credentialSuffix}`,
      rawToken: issued.rawToken,
      expiresAt: issued.expiresAt,
      organizationId: args.app.organizationId,
      portalAccountId: args.portalAccountId,
    });
    args.log.info("provider-onboarding-prover.setup_link_sent", {
      event: "provider-onboarding-prover.setup_link_sent",
      portalAccountId: args.portalAccountId,
    });
  } catch (cause) {
    args.log.error("provider-onboarding-prover.setup_link_failed", {
      event: "provider-onboarding-prover.setup_link_failed",
      portalAccountId: args.portalAccountId,
      error: cause,
    });
  }
}
