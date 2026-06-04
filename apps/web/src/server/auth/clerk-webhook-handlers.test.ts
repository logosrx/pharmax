// Contract tests for the Clerk webhook dispatcher.
//
// The dispatcher's external dependencies are:
//   - Prisma `user` model (findMany / findUnique / update)
//   - `withSystemContext` from @pharmax/tenancy (passthrough in tests)
//   - The audit chain writer (`writeAuditLogInTx`) — injected as a
//     `vi.fn()` so we can assert each handler emits the right
//     audit shape per outcome.
//   - The transaction runner — injected as a passthrough so the
//     test fake satisfies it without spawning a real Postgres tx.
//
// We mock the Prisma client via a hand-rolled object. We do NOT
// mock `withSystemContext` — the real implementation just executes
// the callback inside an ALS scope, which is safe to run in tests.
//
// Test data convention: synthetic identifiers only — no real
// patient or operator data, per .cursor/rules/02-security-compliance.

import { UserStatus } from "@pharmax/database";
import { describe, expect, it, vi } from "vitest";

import {
  dispatchClerkWebhookEvent,
  type AuditEntryWriter,
  type ClerkAuditEntry,
  type ClerkWebhookEvent,
  type DispatchOptions,
  type DispatchOutcome,
  type TxRunner,
} from "./clerk-webhook-handlers.js";

// -----------------------------------------------------------------------------
// Synthetic test fixtures.
// -----------------------------------------------------------------------------

const CLERK_USER_ID = "clerk_user_2webhookTEST";
const ORG_ID = "00000000-0000-4000-8000-000000000001";
const USER_ID = "00000000-0000-4000-8000-000000000099";

interface UserRowShape {
  id: string;
  organizationId: string;
  email: string;
  displayName: string;
  status: UserStatus;
  clerkUserId: string | null;
}

// A passthrough tx-runner: the test fake's "tx" is just the same
// fake client. The handlers' transactional contract is exercised
// in @pharmax/audit's writer tests; here we test the dispatcher's
// branching shape, not the underlying tx semantics.
const passthroughTxRunner: TxRunner = async (client, body) =>
  body(client as unknown as Parameters<typeof body>[0]);

const noopApplyGuc = vi.fn(async () => {});

interface FakeClientArgs {
  findMany?: (...args: unknown[]) => Promise<unknown[]>;
  findUnique?: (...args: unknown[]) => Promise<UserRowShape | null>;
  update?: (...args: unknown[]) => Promise<UserRowShape>;
}

function fakeClient(opts: FakeClientArgs): never {
  const defaultUpdate = async (...args: unknown[]) => {
    const a = (args[0] ?? {}) as { data?: Record<string, unknown> };
    return {
      id: USER_ID,
      organizationId: ORG_ID,
      email: "operator@acme.test",
      displayName: "Op",
      status: UserStatus.ACTIVE,
      clerkUserId: CLERK_USER_ID,
      ...(a.data ?? {}),
    } as UserRowShape;
  };
  return {
    user: {
      findMany: opts.findMany ?? (async () => []),
      findUnique: opts.findUnique ?? (async () => null),
      update: opts.update ?? defaultUpdate,
    },
  } as never;
}

interface DispatchHarness {
  client: never;
  writeAudit: ReturnType<typeof vi.fn<AuditEntryWriter>>;
  options: DispatchOptions;
}

function harness(args: FakeClientArgs = {}): DispatchHarness {
  const client = fakeClient(args);
  const writeAudit = vi.fn<AuditEntryWriter>(async () => {});
  return {
    client,
    writeAudit,
    options: {
      client,
      runInTransaction: passthroughTxRunner,
      applySystemGuc: noopApplyGuc,
      writeAudit,
    },
  };
}

function userCreatedEvent(overrides: { id?: string; email?: string } = {}): ClerkWebhookEvent {
  return {
    type: "user.created",
    data: {
      id: overrides.id ?? CLERK_USER_ID,
      primary_email_address_id: "idn_primary",
      email_addresses: [
        { id: "idn_primary", email_address: overrides.email ?? "Operator@Acme.test" },
      ],
      first_name: "Op",
      last_name: "Erator",
      username: null,
    },
  };
}

function lastAuditCall(
  fn: ReturnType<typeof vi.fn<AuditEntryWriter>>
): ClerkAuditEntry | undefined {
  const call = fn.mock.calls.at(-1);
  return call?.[1];
}

// -----------------------------------------------------------------------------
// user.created
// -----------------------------------------------------------------------------

describe("dispatchClerkWebhookEvent — user.created", () => {
  it("links a single matching INVITED row, flips ACTIVE, emits a chain-linked audit", async () => {
    const update = vi.fn(async (...args: unknown[]) => {
      const a = args[0] as { where: { id: string }; data: Record<string, unknown> };
      expect(a.where.id).toBe(USER_ID);
      expect(a.data.clerkUserId).toBe(CLERK_USER_ID);
      expect(a.data.status).toBe(UserStatus.ACTIVE);
      return {
        id: USER_ID,
        organizationId: ORG_ID,
        email: "operator@acme.test",
        displayName: "Op Erator",
        status: UserStatus.ACTIVE,
        clerkUserId: CLERK_USER_ID,
      };
    });
    const h = harness({
      findMany: async () => [
        {
          id: USER_ID,
          organizationId: ORG_ID,
          email: "operator@acme.test",
          clerkUserId: null,
        },
      ],
      update,
    });

    const outcome = await dispatchClerkWebhookEvent(userCreatedEvent(), h.options);
    expect(outcome).toBe<DispatchOutcome>("applied");
    expect(update).toHaveBeenCalledTimes(1);
    expect(h.writeAudit).toHaveBeenCalledTimes(1);

    const audit = lastAuditCall(h.writeAudit);
    expect(audit?.organizationId).toBe(ORG_ID);
    expect(audit?.action).toBe("auth.clerk.user_linked");
    expect(audit?.resourceType).toBe("User");
    expect(audit?.resourceId).toBe(USER_ID);
    expect(audit?.actorUserId).toBeNull();
    expect((audit?.metadata as Record<string, unknown>).clerkUserId).toBe(CLERK_USER_ID);
    expect((audit?.metadata as Record<string, unknown>).email).toBe("operator@acme.test");
  });

  it("normalizes email casing AND trims whitespace before matching", async () => {
    const findMany = vi.fn(async (...args: unknown[]) => {
      const a = args[0] as { where: { email: string } };
      expect(a.where.email).toBe("operator@acme.test");
      return [
        {
          id: USER_ID,
          organizationId: ORG_ID,
          email: "operator@acme.test",
          clerkUserId: null,
        },
      ];
    });
    const h = harness({ findMany, update: async () => ({}) as UserRowShape });
    await dispatchClerkWebhookEvent(
      userCreatedEvent({ email: "  Operator@Acme.Test  " }),
      h.options
    );
    expect(findMany).toHaveBeenCalled();
  });

  it("refuses to guess when multiple INVITED rows share the email", async () => {
    const update = vi.fn();
    const h = harness({
      findMany: async () => [
        { id: "a", organizationId: ORG_ID, email: "x@y.test", clerkUserId: null },
        { id: "b", organizationId: ORG_ID, email: "x@y.test", clerkUserId: null },
      ],
      update,
    });
    const outcome = await dispatchClerkWebhookEvent(
      userCreatedEvent({ email: "x@y.test" }),
      h.options
    );
    expect(outcome).toBe<DispatchOutcome>("noop_no_invited_row");
    expect(update).not.toHaveBeenCalled();
    expect(h.writeAudit).not.toHaveBeenCalled();
  });

  it("audits a refused relink and returns noop_link_refused", async () => {
    const update = vi.fn();
    const h = harness({
      findMany: async () => [
        {
          id: USER_ID,
          organizationId: ORG_ID,
          email: "x@y.test",
          clerkUserId: "clerk_user_someoneELSE",
        },
      ],
      update,
    });
    const outcome = await dispatchClerkWebhookEvent(
      userCreatedEvent({ email: "x@y.test" }),
      h.options
    );
    expect(outcome).toBe<DispatchOutcome>("noop_link_refused");
    expect(update).not.toHaveBeenCalled();
    // The refusal IS a security event; it MUST be audited.
    expect(h.writeAudit).toHaveBeenCalledTimes(1);
    const audit = lastAuditCall(h.writeAudit);
    expect(audit?.action).toBe("auth.clerk.user_link_refused");
    expect(audit?.organizationId).toBe(ORG_ID);
    expect((audit?.metadata as Record<string, unknown>).existingClerkUserId).toBe(
      "clerk_user_someoneELSE"
    );
    expect((audit?.metadata as Record<string, unknown>).incomingClerkUserId).toBe(CLERK_USER_ID);
  });

  it("is a noop when no INVITED row exists (Pharmax is invitation-only)", async () => {
    const update = vi.fn();
    const h = harness({ findMany: async () => [], update });
    const outcome = await dispatchClerkWebhookEvent(userCreatedEvent(), h.options);
    expect(outcome).toBe<DispatchOutcome>("noop_no_invited_row");
    expect(update).not.toHaveBeenCalled();
    expect(h.writeAudit).not.toHaveBeenCalled();
  });

  it("is a noop with no audit when the payload has no primary email", async () => {
    const h = harness({});
    const outcome = await dispatchClerkWebhookEvent(
      {
        type: "user.created",
        data: {
          id: CLERK_USER_ID,
          primary_email_address_id: null,
          email_addresses: [],
          first_name: null,
          last_name: null,
          username: null,
        },
      },
      h.options
    );
    expect(outcome).toBe<DispatchOutcome>("noop_no_invited_row");
    expect(h.writeAudit).not.toHaveBeenCalled();
  });
});

// -----------------------------------------------------------------------------
// user.updated
// -----------------------------------------------------------------------------

describe("dispatchClerkWebhookEvent — user.updated", () => {
  it("syncs email + displayName and emits an audit", async () => {
    const update = vi.fn(async (...args: unknown[]) => {
      const a = args[0] as { data: Record<string, unknown> };
      expect(a.data.email).toBe("new@acme.test");
      expect(a.data.displayName).toBe("New Name");
      return {} as UserRowShape;
    });
    const h = harness({
      findUnique: async () => ({
        id: USER_ID,
        organizationId: ORG_ID,
        email: "old@acme.test",
        displayName: "Old Name",
        status: UserStatus.ACTIVE,
        clerkUserId: CLERK_USER_ID,
      }),
      update,
    });
    const outcome = await dispatchClerkWebhookEvent(
      {
        type: "user.updated",
        data: {
          id: CLERK_USER_ID,
          primary_email_address_id: "idn",
          email_addresses: [{ id: "idn", email_address: "new@acme.test" }],
          first_name: "New",
          last_name: "Name",
          username: null,
        },
      },
      h.options
    );
    expect(outcome).toBe<DispatchOutcome>("applied");
    expect(update).toHaveBeenCalledTimes(1);
    expect(h.writeAudit).toHaveBeenCalledTimes(1);
    const audit = lastAuditCall(h.writeAudit);
    expect(audit?.action).toBe("auth.clerk.user_synced");
    const md = audit?.metadata as Record<string, unknown>;
    expect(md.changedFields).toEqual(["email", "displayName"]);
  });

  it("noops without audit when no fields changed", async () => {
    const update = vi.fn();
    const h = harness({
      findUnique: async () => ({
        id: USER_ID,
        organizationId: ORG_ID,
        email: "same@acme.test",
        displayName: "Same Name",
        status: UserStatus.ACTIVE,
        clerkUserId: CLERK_USER_ID,
      }),
      update,
    });
    const outcome = await dispatchClerkWebhookEvent(
      {
        type: "user.updated",
        data: {
          id: CLERK_USER_ID,
          primary_email_address_id: "idn",
          email_addresses: [{ id: "idn", email_address: "same@acme.test" }],
          first_name: "Same",
          last_name: "Name",
          username: null,
        },
      },
      h.options
    );
    expect(outcome).toBe<DispatchOutcome>("noop_no_link");
    expect(update).not.toHaveBeenCalled();
    expect(h.writeAudit).not.toHaveBeenCalled();
  });

  it("noops without audit when no Pharmax row links to the Clerk id", async () => {
    const h = harness({ findUnique: async () => null });
    const outcome = await dispatchClerkWebhookEvent(
      {
        type: "user.updated",
        data: {
          id: "clerk_user_orphan",
          primary_email_address_id: null,
          email_addresses: [],
          first_name: null,
          last_name: null,
          username: null,
        },
      },
      h.options
    );
    expect(outcome).toBe<DispatchOutcome>("noop_no_link");
    expect(h.writeAudit).not.toHaveBeenCalled();
  });
});

// -----------------------------------------------------------------------------
// user.deleted
// -----------------------------------------------------------------------------

describe("dispatchClerkWebhookEvent — user.deleted", () => {
  it("flips a linked row to TERMINATED, clears clerkUserId, audits the termination", async () => {
    const update = vi.fn(async (...args: unknown[]) => {
      const a = args[0] as { data: Record<string, unknown> };
      expect(a.data.status).toBe(UserStatus.TERMINATED);
      expect(a.data.clerkUserId).toBeNull();
      return {} as UserRowShape;
    });
    const h = harness({
      findUnique: async () => ({
        id: USER_ID,
        organizationId: ORG_ID,
        email: "operator@acme.test",
        displayName: "Op",
        status: UserStatus.ACTIVE,
        clerkUserId: CLERK_USER_ID,
      }),
      update,
    });
    const outcome = await dispatchClerkWebhookEvent(
      { type: "user.deleted", data: { id: CLERK_USER_ID } },
      h.options
    );
    expect(outcome).toBe<DispatchOutcome>("applied");
    expect(update).toHaveBeenCalledTimes(1);
    expect(h.writeAudit).toHaveBeenCalledTimes(1);
    const audit = lastAuditCall(h.writeAudit);
    expect(audit?.action).toBe("auth.clerk.user_terminated");
    expect((audit?.metadata as Record<string, unknown>).previousStatus).toBe(UserStatus.ACTIVE);
  });

  it("is idempotent: re-delivery on an already-TERMINATED row clears clerkUserId without re-auditing", async () => {
    const update = vi.fn(async () => ({}) as UserRowShape);
    const h = harness({
      findUnique: async () => ({
        id: USER_ID,
        organizationId: ORG_ID,
        email: "operator@acme.test",
        displayName: "Op",
        status: UserStatus.TERMINATED,
        clerkUserId: CLERK_USER_ID,
      }),
      update,
    });
    const outcome = await dispatchClerkWebhookEvent(
      { type: "user.deleted", data: { id: CLERK_USER_ID } },
      h.options
    );
    expect(outcome).toBe<DispatchOutcome>("applied");
    expect(update).toHaveBeenCalledTimes(1);
    // No second audit row — chain growth must be proportional to
    // real lifecycle events, not Svix retry storms.
    expect(h.writeAudit).not.toHaveBeenCalled();
  });

  it("noops with no mutation and no audit when no Pharmax row links to the Clerk id", async () => {
    const update = vi.fn();
    const h = harness({ findUnique: async () => null, update });
    const outcome = await dispatchClerkWebhookEvent(
      { type: "user.deleted", data: { id: "clerk_user_unknown" } },
      h.options
    );
    expect(outcome).toBe<DispatchOutcome>("noop_no_link");
    expect(update).not.toHaveBeenCalled();
    expect(h.writeAudit).not.toHaveBeenCalled();
  });
});

// -----------------------------------------------------------------------------
// session.created
// -----------------------------------------------------------------------------

describe("dispatchClerkWebhookEvent — session.created", () => {
  it("emits an audit signal and does not mutate the user row", async () => {
    const update = vi.fn();
    const h = harness({
      findUnique: async () => ({
        id: USER_ID,
        organizationId: ORG_ID,
        email: "operator@acme.test",
        displayName: "Op",
        status: UserStatus.ACTIVE,
        clerkUserId: CLERK_USER_ID,
      }),
      update,
    });
    const outcome = await dispatchClerkWebhookEvent(
      {
        type: "session.created",
        data: { id: "clerk_sess_1", user_id: CLERK_USER_ID, status: "active" },
      },
      h.options
    );
    expect(outcome).toBe<DispatchOutcome>("noop_session_signal_only");
    expect(update).not.toHaveBeenCalled();
    expect(h.writeAudit).toHaveBeenCalledTimes(1);
    const audit = lastAuditCall(h.writeAudit);
    expect(audit?.action).toBe("auth.clerk.session_created");
    expect(audit?.resourceType).toBe("ClerkSession");
    expect(audit?.resourceId).toBe("clerk_sess_1");
    expect(audit?.actorUserId).toBe(USER_ID);
  });

  it("noops without audit when the session user is not linked to a Pharmax row", async () => {
    const h = harness({ findUnique: async () => null });
    const outcome = await dispatchClerkWebhookEvent(
      {
        type: "session.created",
        data: { id: "clerk_sess_orphan", user_id: "clerk_user_orphan", status: "active" },
      },
      h.options
    );
    expect(outcome).toBe<DispatchOutcome>("noop_session_signal_only");
    expect(h.writeAudit).not.toHaveBeenCalled();
  });
});

// -----------------------------------------------------------------------------
// Unknown event types
// -----------------------------------------------------------------------------

describe("dispatchClerkWebhookEvent — unknown event types", () => {
  it("ignores unknown event types and does not audit", async () => {
    const h = harness();
    const outcome = await dispatchClerkWebhookEvent(
      { type: "organization.created", data: {} },
      h.options
    );
    expect(outcome).toBe<DispatchOutcome>("noop_unknown_event");
    expect(h.writeAudit).not.toHaveBeenCalled();
  });
});

// -----------------------------------------------------------------------------
// Operator-identity cache invalidation
// -----------------------------------------------------------------------------

describe("dispatchClerkWebhookEvent — operator-identity cache invalidation", () => {
  function deletedEvent(id: string = CLERK_USER_ID): ClerkWebhookEvent {
    return { type: "user.deleted", data: { id } };
  }

  function updatedEvent(email: string): ClerkWebhookEvent {
    return {
      type: "user.updated",
      data: {
        id: CLERK_USER_ID,
        primary_email_address_id: "idn_primary",
        email_addresses: [{ id: "idn_primary", email_address: email }],
        first_name: "New",
        last_name: "Name",
        username: null,
      },
    };
  }

  it("invalidates the identity cache after an applied user.deleted (off-boarding)", async () => {
    const invalidate = vi.fn(async () => {});
    const h = harness({
      findUnique: async () => ({
        id: USER_ID,
        organizationId: ORG_ID,
        email: "operator@acme.test",
        displayName: "Op",
        status: UserStatus.ACTIVE,
        clerkUserId: CLERK_USER_ID,
      }),
    });

    const outcome = await dispatchClerkWebhookEvent(deletedEvent(), {
      ...h.options,
      invalidateIdentityCache: invalidate,
    });

    expect(outcome).toBe<DispatchOutcome>("applied");
    expect(invalidate).toHaveBeenCalledWith(CLERK_USER_ID);
  });

  it("invalidates after an applied user.updated", async () => {
    const invalidate = vi.fn(async () => {});
    const h = harness({
      findUnique: async () => ({
        id: USER_ID,
        organizationId: ORG_ID,
        email: "old@acme.test",
        displayName: "Old Name",
        status: UserStatus.ACTIVE,
        clerkUserId: CLERK_USER_ID,
      }),
      update: async () => ({}) as UserRowShape,
    });

    const outcome = await dispatchClerkWebhookEvent(updatedEvent("new@acme.test"), {
      ...h.options,
      invalidateIdentityCache: invalidate,
    });

    expect(outcome).toBe<DispatchOutcome>("applied");
    expect(invalidate).toHaveBeenCalledWith(CLERK_USER_ID);
  });

  it("does NOT invalidate when the event is a no-op (no linked row)", async () => {
    const invalidate = vi.fn(async () => {});
    const h = harness({ findUnique: async () => null });

    const outcome = await dispatchClerkWebhookEvent(deletedEvent(), {
      ...h.options,
      invalidateIdentityCache: invalidate,
    });

    expect(outcome).toBe<DispatchOutcome>("noop_no_link");
    expect(invalidate).not.toHaveBeenCalled();
  });
});
