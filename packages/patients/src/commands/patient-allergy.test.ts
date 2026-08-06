// Contract tests for the three allergy commands.
//
// Follows the `RegisterPatient` harness: Prisma is faked so the tests
// stay DB-free, but crypto is REAL (`LocalKmsAdapter`), so the envelope
// and AAD-binding paths execute rather than being asserted against a
// mock that would agree with anything.
//
// What is pinned here, in order of how badly it would hurt to get wrong:
//
//   - The PHI split. Narrative encrypted with the right AAD binding;
//     coded values plaintext; nothing narrative in `command_log`, the
//     audit metadata, or the outbox payload.
//   - Screenability. Reported on the output and the event, computed by
//     the SAME predicate the PV1 screening layer uses — because the two
//     disagreeing in the optimistic direction is a clean allergy screen
//     that compared nothing.
//   - Retraction without deletion, with a mandatory reason code.
//   - The negative assertion, including that UNABLE_TO_ASSESS does not
//     satisfy the screening axis.
//   - Idempotency and tenancy, which are the bus's job but are worth
//     proving at least once per command family.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  configureCommandBus,
  executeCommand,
  resetCommandBusConfigurationForTests,
} from "@pharmax/command-bus";
import {
  configureCrypto,
  decryptField,
  LocalKmsAdapter,
  resetCryptoConfigurationForTests,
} from "@pharmax/crypto";
import { RoleScope } from "@pharmax/database";
import { clock, logger } from "@pharmax/platform-core";
import {
  configureRbac,
  InMemoryPermissionLoader,
  PERMISSIONS,
  resetRbacConfigurationForTests,
  type ResolvedGrant,
} from "@pharmax/rbac";
import { buildTenancyContext, withTenancyContext } from "@pharmax/tenancy";

import { ALLERGY_STATUS_CHANGE_REASONS } from "../allergies.js";
import { AmendPatientAllergyStatus } from "./amend-patient-allergy-status.js";
import { AssertPatientAllergyHistory } from "./assert-patient-allergy-history.js";
import { RecordPatientAllergy } from "./record-patient-allergy.js";

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_ORG_ID = "1111111a-1111-4111-8111-111111111111";
const CLINIC_ID = "22222222-2222-4222-8222-222222222222";
const USER_ID = "33333333-3333-4333-8333-333333333333";
const PATIENT_ID = "44444444-4444-4444-8444-444444444444";
const ALLERGY_ID = "55555555-5555-4555-8555-555555555555";

const NOW = new Date("2026-06-01T12:00:00.000Z");

function grantsFor(
  permissions: ReadonlyArray<(typeof PERMISSIONS)[keyof typeof PERMISSIONS]>
): ReadonlyArray<ResolvedGrant> {
  return [
    {
      roleScope: RoleScope.ORGANIZATION,
      grantScope: { siteId: null, clinicId: null, teamId: null },
      permissions: new Set(permissions),
    },
  ];
}

const recordGrants = grantsFor([
  PERMISSIONS.PATIENTS_ALLERGIES_RECORD,
  PERMISSIONS.PATIENTS_ALLERGIES_READ,
]);
const amendGrants = grantsFor([PERMISSIONS.PATIENTS_ALLERGIES_AMEND_STATUS]);
const readOnlyGrants = grantsFor([PERMISSIONS.PATIENTS_ALLERGIES_READ]);

function ctx(organizationId = ORG_ID) {
  return buildTenancyContext({
    organizationId,
    actor: { userId: USER_ID, correlationId: "01CORRELATION0000000000000" },
  });
}

interface FakeCall {
  table: string;
  op: string;
  args: unknown;
}

interface FakeOptions {
  /** When false, `patient.findUnique` returns null. */
  readonly patientExists?: boolean;
  readonly patientShreddedAt?: Date | null;
  /** Existing allergy row for the amend command; null → not found. */
  readonly existingAllergy?: Record<string, unknown> | null;
  /**
   * When true, the fake REMEMBERS created idempotency keys and serves
   * them back on later lookups, so a retry replays for real instead of
   * against a hand-built cache row that could agree with a broken
   * implementation.
   */
  readonly persistIdempotency?: boolean;
}

function buildFakePrisma(opts: FakeOptions = {}): { client: unknown; calls: FakeCall[] } {
  const calls: FakeCall[] = [];
  const push = (table: string, op: string, args: unknown): void => {
    calls.push({ table, op, args });
  };
  // Keyed the way the real unique constraint is —
  // (organizationId, commandName, key) — so a key reused across two
  // different commands does not collide in the fake when it would not
  // collide in Postgres.
  const idempotencyStore = new Map<string, Record<string, unknown>>();
  const idempotencyId = (organizationId: unknown, commandName: unknown, key: unknown): string =>
    `${String(organizationId)}\u0000${String(commandName)}\u0000${String(key)}`;
  const idempotencyLookup = (args: unknown): Record<string, unknown> | null => {
    if (opts.persistIdempotency !== true) return null;
    const where = (args as { where?: Record<string, unknown> }).where ?? {};
    const composite =
      (where["organizationId_commandName_key"] as Record<string, unknown> | undefined) ?? where;
    return (
      idempotencyStore.get(
        idempotencyId(composite["organizationId"], composite["commandName"], composite["key"])
      ) ?? null
    );
  };

  const tx = {
    patient: {
      findUnique: vi.fn(async (args: unknown) => {
        push("patient", "findUnique", args);
        if (opts.patientExists === false) return null;
        return {
          id: PATIENT_ID,
          clinicId: CLINIC_ID,
          cryptoShreddedAt: opts.patientShreddedAt ?? null,
        };
      }),
    },
    patientAllergy: {
      create: vi.fn(async (args: unknown) => {
        push("patientAllergy", "create", args);
        return (args as { data: { id: string } }).data;
      }),
      findUnique: vi.fn(async (args: unknown) => {
        push("patientAllergy", "findUnique", args);
        if (opts.existingAllergy === null) return null;
        return (
          opts.existingAllergy ?? {
            id: ALLERGY_ID,
            patientId: PATIENT_ID,
            clinicId: CLINIC_ID,
            category: "MEDICATION",
            clinicalStatus: "ACTIVE",
            verificationStatus: "UNCONFIRMED",
            substanceCodeSystem: "RXNORM",
          }
        );
      }),
      update: vi.fn(async (args: unknown) => {
        push("patientAllergy", "update", args);
        return { id: ALLERGY_ID };
      }),
    },
    patientAllergyHistoryAssertion: {
      create: vi.fn(async (args: unknown) => {
        push("patientAllergyHistoryAssertion", "create", args);
        return (args as { data: { id: string } }).data;
      }),
    },
    commandLog: {
      create: vi.fn(async (args: unknown) => {
        push("commandLog", "create", args);
        return { id: "cmd-log-1" };
      }),
      update: vi.fn(async (args: unknown) => {
        push("commandLog", "update", args);
        return { ok: true };
      }),
      findUnique: vi.fn(async (args: unknown) => {
        push("commandLog", "findUnique", args);
        return null;
      }),
    },
    auditLog: {
      create: vi.fn(async (args: unknown) => {
        push("auditLog", "create", args);
        return { id: "audit-1" };
      }),
    },
    auditChainState: {
      findUnique: vi.fn(async (args: unknown) => {
        push("auditChainState", "findUnique", args);
        return null;
      }),
      upsert: vi.fn(async (args: unknown) => {
        push("auditChainState", "upsert", args);
        const data = args as {
          where: { organizationId: string };
          create: { latestHash: Buffer; latestSeq: bigint };
        };
        return {
          organizationId: data.where.organizationId,
          latestHash: data.create.latestHash,
          latestSeq: data.create.latestSeq,
        };
      }),
    },
    eventOutbox: {
      createMany: vi.fn(async (args: unknown) => {
        push("eventOutbox", "createMany", args);
        return { count: (args as { data: unknown[] }).data.length };
      }),
    },
    idempotencyKey: {
      create: vi.fn(async (args: unknown) => {
        push("idempotencyKey", "create", args);
        const data = (args as { data: Record<string, unknown> }).data;
        idempotencyStore.set(
          idempotencyId(data["organizationId"], data["commandName"], data["key"]),
          { id: "idem-1", requestHash: null, responsePayload: null, ...data }
        );
        return { id: "idem-1" };
      }),
      findUnique: vi.fn(async (args: unknown) => {
        push("idempotencyKey", "findUnique", args);
        return idempotencyLookup(args);
      }),
    },
    $executeRaw: vi.fn(
      async (template: TemplateStringsArray, ...values: ReadonlyArray<unknown>) => {
        const joined = template.join("?");
        push("$executeRaw", /set_config/i.test(joined) ? "set_config" : "raw", {
          sql: joined,
          values: [...values],
        });
        return 0;
      }
    ),
  };

  const client = {
    commandLog: {
      create: vi.fn(async (args: unknown) => {
        push("commandLog", "create", args);
        return { id: "cmd-log-pretx" };
      }),
      update: vi.fn(async (args: unknown) => {
        push("commandLog", "update", args);
        return { id: "cmd-log-pretx" };
      }),
    },
    idempotencyKey: {
      findUnique: vi.fn(async (args: unknown) => {
        push("idempotencyKey", "findUnique", args);
        return idempotencyLookup(args);
      }),
    },
    $transaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
  };

  return { client, calls };
}

function callsOf(calls: FakeCall[], table: string, op: string): FakeCall[] {
  return calls.filter((c) => c.table === table && c.op === op);
}

function onlyCall(calls: FakeCall[], table: string, op: string): FakeCall {
  const matches = callsOf(calls, table, op);
  if (matches.length !== 1) {
    throw new Error(`Expected exactly one ${table}.${op}, got ${matches.length}`);
  }
  return matches[0] as FakeCall;
}

function dataOf(call: FakeCall): Record<string, unknown> {
  return (call.args as { data: Record<string, unknown> }).data;
}

/**
 * `JSON.stringify` with a BigInt escape hatch.
 *
 * The audit chain carries a `bigint` sequence number, which plain
 * `JSON.stringify` refuses. The PHI assertions below work by searching a
 * serialized blob for strings that must not appear, so the serializer
 * has to survive whatever the row contains — otherwise the test fails
 * for a reason that has nothing to do with PHI.
 */
function serialize(value: unknown): string {
  return JSON.stringify(value, (_key, v) => (typeof v === "bigint" ? v.toString() : v));
}

function wire(client: unknown, grants: ReadonlyArray<ResolvedGrant> = recordGrants): void {
  configureCommandBus({
    prisma: client as unknown as Parameters<typeof configureCommandBus>[0]["prisma"],
    clock: clock.createFrozenClock(NOW),
    logger: logger.noopLogger,
  });
  configureRbac({
    loader: new InMemoryPermissionLoader([{ organizationId: ORG_ID, userId: USER_ID, grants }]),
  });
}

beforeEach(() => {
  configureCrypto({ kms: new LocalKmsAdapter({ seed: "patient-allergy-test-seed" }) });
});

afterEach(() => {
  resetCommandBusConfigurationForTests();
  resetRbacConfigurationForTests();
  resetCryptoConfigurationForTests();
});

const codedAllergyInput = {
  patientId: PATIENT_ID,
  substanceCodeSystem: "RXNORM" as const,
  substanceCode: "TEST-INGREDIENT-1",
  category: "MEDICATION" as const,
  type: "ALLERGY" as const,
  criticality: "HIGH" as const,
};

// ---------------------------------------------------------------------
// RecordPatientAllergy
// ---------------------------------------------------------------------

describe("RecordPatientAllergy — storage shape", () => {
  it("writes coded values in plaintext and encrypts only the narrative", async () => {
    // THE PHI SPLIT, pinned. Coded values must stay comparable inside
    // the PV1 transaction; narrative must not be readable without the
    // tenant key. Getting this backwards either breaks screening or
    // leaks a reaction description.
    const fake = buildFakePrisma();
    wire(fake.client);

    const out = await withTenancyContext(ctx(), () =>
      executeCommand(
        RecordPatientAllergy,
        {
          ...codedAllergyInput,
          substanceLabel: "Penicillin (as the patient said it)",
          reactionManifestations: ["ANAPHYLAXIS", "ANGIOEDEMA"],
          reactionSeverity: "SEVERE",
          reactionNote: "Airway involvement, treated in ED.",
          onsetDate: "2015-07-04",
          verificationStatus: "CONFIRMED",
        },
        { idempotencyKey: "rec-1" }
      )
    );

    const row = dataOf(onlyCall(fake.calls, "patientAllergy", "create"));

    // Plaintext, indexable, comparable.
    expect(row["substanceCode"]).toBe("TEST-INGREDIENT-1");
    expect(row["substanceCodeSystem"]).toBe("RXNORM");
    expect(row["category"]).toBe("MEDICATION");
    expect(row["type"]).toBe("ALLERGY");
    expect(row["criticality"]).toBe("HIGH");
    expect(row["clinicalStatus"]).toBe("ACTIVE");
    expect(row["verificationStatus"]).toBe("CONFIRMED");
    expect(row["reactionManifestations"]).toEqual(["ANAPHYLAXIS", "ANGIOEDEMA"]);
    expect(row["reactionSeverity"]).toBe("SEVERE");

    // Encrypted envelopes, not strings.
    expect(typeof row["substanceLabelEnc"]).toBe("object");
    expect(typeof row["reactionNoteEnc"]).toBe("object");
    expect(JSON.stringify(row["substanceLabelEnc"])).not.toContain("Penicillin");
    expect(JSON.stringify(row["reactionNoteEnc"])).not.toContain("Airway");

    // Stamped, scoped, and clinic taken from the PATIENT rather than the
    // caller — a request must not be able to file an allergy under a
    // clinic the patient is not in.
    expect(row["organizationId"]).toBe(ORG_ID);
    expect(row["clinicId"]).toBe(CLINIC_ID);
    expect(row["recordedByUserId"]).toBe(USER_ID);
    expect(row["recordedAt"]).toEqual(NOW);
    expect(row["onsetDate"]).toEqual(new Date("2015-07-04T00:00:00.000Z"));

    expect(out.allergyId).toBe(row["id"]);
    expect(out.screenable).toBe(true);
  });

  it("binds the narrative envelope to (tenant, table, column, recordId)", async () => {
    // The AAD binding is what stops a ciphertext being moved between
    // rows or tenants. Proven by decrypting with the right binding and
    // failing with a wrong recordId.
    const fake = buildFakePrisma();
    wire(fake.client);

    await withTenancyContext(ctx(), () =>
      executeCommand(
        RecordPatientAllergy,
        { ...codedAllergyInput, reactionNote: "Hives within an hour." },
        { idempotencyKey: "rec-aad" }
      )
    );

    const row = dataOf(onlyCall(fake.calls, "patientAllergy", "create"));
    const recordId = row["id"] as string;

    await expect(
      decryptField({
        envelope: row["reactionNoteEnc"],
        binding: {
          tenantId: ORG_ID,
          table: "patient_allergy",
          column: "reactionNote",
          recordId,
        },
      })
    ).resolves.toBe("Hives within an hour.");

    await expect(
      decryptField({
        envelope: row["reactionNoteEnc"],
        binding: {
          tenantId: ORG_ID,
          table: "patient_allergy",
          column: "reactionNote",
          recordId: ALLERGY_ID,
        },
      })
    ).rejects.toMatchObject({ code: "AAD_MISMATCH" });
  });

  it("omits envelope columns entirely when no narrative was supplied", async () => {
    const fake = buildFakePrisma();
    wire(fake.client);

    await withTenancyContext(ctx(), () =>
      executeCommand(RecordPatientAllergy, codedAllergyInput, { idempotencyKey: "rec-bare" })
    );

    const row = dataOf(onlyCall(fake.calls, "patientAllergy", "create"));
    expect(row).not.toHaveProperty("substanceLabelEnc");
    expect(row).not.toHaveProperty("reactionNoteEnc");
    expect(row["reactionManifestations"]).toEqual([]);
  });

  it("defaults verificationStatus to UNCONFIRMED, and never accepts a clinicalStatus", async () => {
    // A newly recorded allergy is ACTIVE and unconfirmed — an intake
    // self-report. Accepting a clinicalStatus here would let a record
    // land already retired, which never screens and which nobody
    // decided to retire.
    const fake = buildFakePrisma();
    wire(fake.client);

    await withTenancyContext(ctx(), () =>
      executeCommand(RecordPatientAllergy, codedAllergyInput, { idempotencyKey: "rec-default" })
    );
    expect(dataOf(onlyCall(fake.calls, "patientAllergy", "create"))["verificationStatus"]).toBe(
      "UNCONFIRMED"
    );

    await expect(
      withTenancyContext(ctx(), () =>
        executeCommand(
          RecordPatientAllergy,
          { ...codedAllergyInput, clinicalStatus: "RESOLVED" } as never,
          { idempotencyKey: "rec-status" }
        )
      )
    ).rejects.toMatchObject({ code: "COMMAND_INPUT_INVALID" });
  });
});

describe("RecordPatientAllergy — the substance code rules", () => {
  it("rejects a coded system with no code", async () => {
    const fake = buildFakePrisma();
    wire(fake.client);
    await expect(
      withTenancyContext(ctx(), () =>
        executeCommand(
          RecordPatientAllergy,
          { ...codedAllergyInput, substanceCode: undefined } as never,
          { idempotencyKey: "rec-nocode" }
        )
      )
    ).rejects.toMatchObject({ code: "COMMAND_INPUT_INVALID" });
    expect(callsOf(fake.calls, "patientAllergy", "create")).toHaveLength(0);
  });

  it("rejects UNCODED with a code, and UNCODED with no label", async () => {
    const fake = buildFakePrisma();
    wire(fake.client);

    await expect(
      withTenancyContext(ctx(), () =>
        executeCommand(
          RecordPatientAllergy,
          { ...codedAllergyInput, substanceCodeSystem: "UNCODED" },
          { idempotencyKey: "rec-uncoded-with-code" }
        )
      )
    ).rejects.toMatchObject({ code: "COMMAND_INPUT_INVALID" });

    await expect(
      withTenancyContext(ctx(), () =>
        executeCommand(
          RecordPatientAllergy,
          {
            ...codedAllergyInput,
            substanceCodeSystem: "UNCODED",
            substanceCode: undefined,
          } as never,
          { idempotencyKey: "rec-uncoded-no-label" }
        )
      )
    ).rejects.toMatchObject({ code: "COMMAND_INPUT_INVALID" });
  });

  it("accepts an UNCODED record with a label, and reports it as NOT screenable", async () => {
    // The honest outcome for "the patient said sulfa and nobody could
    // code it": stored, shown to a human, and explicitly flagged as
    // something the engine cannot compare. Reporting it as screenable
    // would be a clean allergy screen that matched nothing.
    const fake = buildFakePrisma();
    wire(fake.client);

    const out = await withTenancyContext(ctx(), () =>
      executeCommand(
        RecordPatientAllergy,
        {
          ...codedAllergyInput,
          substanceCodeSystem: "UNCODED",
          substanceCode: undefined,
          substanceLabel: "sulfa drugs",
        } as never,
        { idempotencyKey: "rec-uncoded-ok" }
      )
    );

    expect(out.screenable).toBe(false);
    const row = dataOf(onlyCall(fake.calls, "patientAllergy", "create"));
    expect(row).not.toHaveProperty("substanceCode");
    expect(row["substanceCodeSystem"]).toBe("UNCODED");
  });

  it("reports a FOOD allergy as not screenable, but still stores it", async () => {
    // Intake staff take a whole history. A drug knowledge base cannot
    // answer food, so the record is kept and excluded from screening
    // rather than gapped on every prescription forever.
    const fake = buildFakePrisma();
    wire(fake.client);

    const out = await withTenancyContext(ctx(), () =>
      executeCommand(
        RecordPatientAllergy,
        { ...codedAllergyInput, category: "FOOD" },
        { idempotencyKey: "rec-food" }
      )
    );

    expect(out.screenable).toBe(false);
    expect(callsOf(fake.calls, "patientAllergy", "create")).toHaveLength(1);
  });
});

describe("RecordPatientAllergy — PHI containment", () => {
  it("redacts the narrative from command_log.requestPayload", async () => {
    const fake = buildFakePrisma();
    wire(fake.client);

    await withTenancyContext(ctx(), () =>
      executeCommand(
        RecordPatientAllergy,
        {
          ...codedAllergyInput,
          substanceLabel: "Penicillin (as the patient said it)",
          reactionNote: "Airway involvement, treated in ED.",
        },
        { idempotencyKey: "rec-redact" }
      )
    );

    const serialized = serialize(callsOf(fake.calls, "commandLog", "create").map((c) => c.args));
    expect(serialized).not.toContain("Penicillin");
    expect(serialized).not.toContain("Airway");
    // The coded values ARE in the payload, on purpose: they are what a
    // replay needs, and they are the same class of value
    // `prescription.drugNdc` already is.
    expect(serialized).toContain("TEST-INGREDIENT-1");
  });

  it("keeps the substance out of the audit metadata and the event payload", async () => {
    // A substance code is a code, and codes are allowed in findings.
    // Pairing it with `patientId` in a payload that fans out to every
    // webhook subscriber is a different matter: that says which allergen
    // a named patient reacts to, to consumers that never asked.
    const fake = buildFakePrisma();
    wire(fake.client);

    await withTenancyContext(ctx(), () =>
      executeCommand(
        RecordPatientAllergy,
        { ...codedAllergyInput, substanceLabel: "Penicillin", reactionNote: "Hives" },
        { idempotencyKey: "rec-audit" }
      )
    );

    const audit = dataOf(onlyCall(fake.calls, "auditLog", "create"));
    const auditSerialized = serialize(audit);
    expect(auditSerialized).not.toContain("TEST-INGREDIENT-1");
    expect(auditSerialized).not.toContain("Penicillin");
    expect(auditSerialized).not.toContain("Hives");
    expect(audit["action"]).toBe("patient.allergy.recorded");

    const outbox = (
      onlyCall(fake.calls, "eventOutbox", "createMany").args as {
        data: Array<Record<string, unknown>>;
      }
    ).data;
    const payload = outbox[0]?.["payload"] as Record<string, unknown>;
    expect(payload["substanceCodeSystem"]).toBe("RXNORM");
    expect(payload).not.toHaveProperty("substanceCode");
    expect(payload).not.toHaveProperty("substanceLabel");
    expect(payload["screenable"]).toBe(true);
    expect(JSON.stringify(payload)).not.toContain("Penicillin");
  });
});

describe("RecordPatientAllergy — guards", () => {
  it("refuses an unknown or cross-tenant patient", async () => {
    const fake = buildFakePrisma({ patientExists: false });
    wire(fake.client);

    await expect(
      withTenancyContext(ctx(), () =>
        executeCommand(RecordPatientAllergy, codedAllergyInput, { idempotencyKey: "rec-nopat" })
      )
    ).rejects.toMatchObject({ code: "ALLERGY_PATIENT_NOT_FOUND" });

    expect(callsOf(fake.calls, "patientAllergy", "create")).toHaveLength(0);
    expect(callsOf(fake.calls, "auditLog", "create")).toHaveLength(0);
    expect(callsOf(fake.calls, "eventOutbox", "createMany")).toHaveLength(0);
  });

  it("refuses to write new PHI against a crypto-shredded patient", async () => {
    // Writing here would quietly undo a right-to-be-forgotten erasure,
    // and the new envelope columns would be unshreddable because the
    // shred already ran.
    const fake = buildFakePrisma({ patientShreddedAt: new Date("2026-01-01T00:00:00.000Z") });
    wire(fake.client);

    await expect(
      withTenancyContext(ctx(), () =>
        executeCommand(
          RecordPatientAllergy,
          { ...codedAllergyInput, reactionNote: "would be unshreddable" },
          { idempotencyKey: "rec-shredded" }
        )
      )
    ).rejects.toMatchObject({ code: "ALLERGY_PATIENT_SHREDDED" });
    expect(callsOf(fake.calls, "patientAllergy", "create")).toHaveLength(0);
  });

  it("denies the write without patients.allergies.record", async () => {
    const fake = buildFakePrisma();
    wire(fake.client, readOnlyGrants);

    await expect(
      withTenancyContext(ctx(), () =>
        executeCommand(RecordPatientAllergy, codedAllergyInput, { idempotencyKey: "rec-perm" })
      )
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    expect(callsOf(fake.calls, "patientAllergy", "create")).toHaveLength(0);
  });

  it("does not run at all without a tenancy context", async () => {
    const fake = buildFakePrisma();
    wire(fake.client);

    await expect(
      executeCommand(RecordPatientAllergy, codedAllergyInput, { idempotencyKey: "rec-notenant" })
    ).rejects.toMatchObject({ code: "TENANCY_NO_CONTEXT" });
    expect(callsOf(fake.calls, "patientAllergy", "create")).toHaveLength(0);
  });

  it("replays a retried request instead of recording a second allergy", async () => {
    // The bus owns idempotency, but an allergy recorded twice by a
    // retried request is a duplicate clinical record that then needs
    // retracting — and retraction is a pharmacist-level grant. Worth one
    // real round-trip per command family rather than a hand-built cache
    // row that could agree with a broken implementation.
    const fake = buildFakePrisma({ persistIdempotency: true });
    wire(fake.client);

    const first = await withTenancyContext(ctx(), () =>
      executeCommand(RecordPatientAllergy, codedAllergyInput, { idempotencyKey: "rec-replay" })
    );
    const second = await withTenancyContext(ctx(), () =>
      executeCommand(RecordPatientAllergy, codedAllergyInput, { idempotencyKey: "rec-replay" })
    );

    expect(second).toEqual(first);
    expect(callsOf(fake.calls, "patientAllergy", "create")).toHaveLength(1);
    expect(callsOf(fake.calls, "eventOutbox", "createMany")).toHaveLength(1);
  });

  it("refuses a reused key carrying a DIFFERENT allergy", async () => {
    // The other half of idempotency, and the one that matters clinically:
    // a client that reuses a key for a different substance must not have
    // the first response replayed back as though the second allergy had
    // been recorded.
    const fake = buildFakePrisma({ persistIdempotency: true });
    wire(fake.client);

    await withTenancyContext(ctx(), () =>
      executeCommand(RecordPatientAllergy, codedAllergyInput, { idempotencyKey: "rec-clash" })
    );

    await expect(
      withTenancyContext(ctx(), () =>
        executeCommand(
          RecordPatientAllergy,
          { ...codedAllergyInput, substanceCode: "TEST-INGREDIENT-2" },
          { idempotencyKey: "rec-clash" }
        )
      )
    ).rejects.toMatchObject({ code: "COMMAND_IDEMPOTENCY_PAYLOAD_MISMATCH" });
    expect(callsOf(fake.calls, "patientAllergy", "create")).toHaveLength(1);
  });

  it("rejects unknown input fields", async () => {
    const fake = buildFakePrisma();
    wire(fake.client);
    await expect(
      withTenancyContext(ctx(), () =>
        executeCommand(RecordPatientAllergy, { ...codedAllergyInput, notAField: true } as never, {
          idempotencyKey: "rec-strict",
        })
      )
    ).rejects.toMatchObject({ code: "COMMAND_INPUT_INVALID" });
  });
});

// ---------------------------------------------------------------------
// AmendPatientAllergyStatus
// ---------------------------------------------------------------------

describe("AmendPatientAllergyStatus — retraction without deletion", () => {
  it("marks a record entered-in-error with a reason, user and time — and never deletes", async () => {
    const fake = buildFakePrisma();
    wire(fake.client, amendGrants);

    const out = await withTenancyContext(ctx(), () =>
      executeCommand(
        AmendPatientAllergyStatus,
        {
          allergyId: ALLERGY_ID,
          verificationStatus: "ENTERED_IN_ERROR",
          reasonCode: ALLERGY_STATUS_CHANGE_REASONS.ENTERED_IN_ERROR_WRONG_PATIENT,
        },
        { idempotencyKey: "amend-1" }
      )
    );

    const update = onlyCall(fake.calls, "patientAllergy", "update");
    expect(dataOf(update)).toEqual({
      // Untouched: the caller only amended verification.
      clinicalStatus: "ACTIVE",
      verificationStatus: "ENTERED_IN_ERROR",
      statusChangedByUserId: USER_ID,
      statusChangedAt: NOW,
      statusChangeReason: "entered-in-error-wrong-patient",
    });

    // The record stops driving the screen without leaving the record.
    expect(out.screenable).toBe(false);
    expect(callsOf(fake.calls, "patientAllergy", "delete")).toHaveLength(0);
    expect(callsOf(fake.calls, "patientAllergy", "deleteMany")).toHaveLength(0);
  });

  it("carries the PREVIOUS and new statuses on the audit trail and the event", async () => {
    // "This allergy is now refuted" is much less useful later than "it
    // went from CONFIRMED to REFUTED", and a consumer that joined the
    // stream late cannot reconstruct the former.
    const fake = buildFakePrisma({
      existingAllergy: {
        id: ALLERGY_ID,
        patientId: PATIENT_ID,
        clinicId: CLINIC_ID,
        category: "MEDICATION",
        clinicalStatus: "ACTIVE",
        verificationStatus: "CONFIRMED",
        substanceCodeSystem: "RXNORM",
      },
    });
    wire(fake.client, amendGrants);

    await withTenancyContext(ctx(), () =>
      executeCommand(
        AmendPatientAllergyStatus,
        {
          allergyId: ALLERGY_ID,
          verificationStatus: "REFUTED",
          reasonCode: ALLERGY_STATUS_CHANGE_REASONS.REFUTED_BY_ALLERGY_TESTING,
        },
        { idempotencyKey: "amend-prev" }
      )
    );

    const audit = dataOf(onlyCall(fake.calls, "auditLog", "create"));
    expect(audit["metadata"]).toMatchObject({
      previousVerificationStatus: "CONFIRMED",
      verificationStatus: "REFUTED",
      reasonCode: "refuted-by-allergy-testing",
      screenable: false,
    });

    const payload = (
      onlyCall(fake.calls, "eventOutbox", "createMany").args as {
        data: Array<Record<string, unknown>>;
      }
    ).data[0]?.["payload"] as Record<string, unknown>;
    expect(payload).toMatchObject({
      previousClinicalStatus: "ACTIVE",
      clinicalStatus: "ACTIVE",
      previousVerificationStatus: "CONFIRMED",
      verificationStatus: "REFUTED",
      screenable: false,
    });
    // Still no substance anywhere.
    expect(payload).not.toHaveProperty("substanceCode");
  });

  it("reports screenable again when a retired record is reactivated", async () => {
    const fake = buildFakePrisma({
      existingAllergy: {
        id: ALLERGY_ID,
        patientId: PATIENT_ID,
        clinicId: CLINIC_ID,
        category: "MEDICATION",
        clinicalStatus: "RESOLVED",
        verificationStatus: "CONFIRMED",
        substanceCodeSystem: "RXNORM",
      },
    });
    wire(fake.client, amendGrants);

    const out = await withTenancyContext(ctx(), () =>
      executeCommand(
        AmendPatientAllergyStatus,
        {
          allergyId: ALLERGY_ID,
          clinicalStatus: "ACTIVE",
          reasonCode: ALLERGY_STATUS_CHANGE_REASONS.REACTIVATED_RECURRENCE,
        },
        { idempotencyKey: "amend-reactivate" }
      )
    );

    expect(out.screenable).toBe(true);
  });

  it("requires a reason code", async () => {
    const fake = buildFakePrisma();
    wire(fake.client, amendGrants);

    await expect(
      withTenancyContext(ctx(), () =>
        executeCommand(
          AmendPatientAllergyStatus,
          { allergyId: ALLERGY_ID, verificationStatus: "REFUTED" } as never,
          { idempotencyKey: "amend-noreason" }
        )
      )
    ).rejects.toMatchObject({ code: "COMMAND_INPUT_INVALID" });
    expect(callsOf(fake.calls, "patientAllergy", "update")).toHaveLength(0);
  });

  it("rejects a free-text reason that is not in the closed list", async () => {
    const fake = buildFakePrisma();
    wire(fake.client, amendGrants);

    await expect(
      withTenancyContext(ctx(), () =>
        executeCommand(
          AmendPatientAllergyStatus,
          {
            allergyId: ALLERGY_ID,
            verificationStatus: "REFUTED",
            reasonCode: "the patient told me it was fine",
          } as never,
          { idempotencyKey: "amend-freetext" }
        )
      )
    ).rejects.toMatchObject({ code: "COMMAND_INPUT_INVALID" });
  });

  it("refuses an amendment that changes nothing", async () => {
    // Accepting it would stamp a status change and a reason code onto a
    // record whose status did not change, which reads in the audit trail
    // as a clinical decision nobody made.
    const fake = buildFakePrisma();
    wire(fake.client, amendGrants);

    await expect(
      withTenancyContext(ctx(), () =>
        executeCommand(
          AmendPatientAllergyStatus,
          {
            allergyId: ALLERGY_ID,
            clinicalStatus: "ACTIVE",
            verificationStatus: "UNCONFIRMED",
            reasonCode: ALLERGY_STATUS_CHANGE_REASONS.CONFIRMED_BY_PRESCRIBER,
          },
          { idempotencyKey: "amend-noop" }
        )
      )
    ).rejects.toMatchObject({ code: "ALLERGY_STATUS_UNCHANGED" });
    expect(callsOf(fake.calls, "patientAllergy", "update")).toHaveLength(0);
  });

  it("requires at least one status to be supplied", async () => {
    const fake = buildFakePrisma();
    wire(fake.client, amendGrants);

    await expect(
      withTenancyContext(ctx(), () =>
        executeCommand(
          AmendPatientAllergyStatus,
          {
            allergyId: ALLERGY_ID,
            reasonCode: ALLERGY_STATUS_CHANGE_REASONS.RESOLVED_OUTGROWN,
          },
          { idempotencyKey: "amend-nostatus" }
        )
      )
    ).rejects.toMatchObject({ code: "COMMAND_INPUT_INVALID" });
  });

  it("refuses an unknown or cross-tenant allergy", async () => {
    const fake = buildFakePrisma({ existingAllergy: null });
    wire(fake.client, amendGrants);

    await expect(
      withTenancyContext(ctx(), () =>
        executeCommand(
          AmendPatientAllergyStatus,
          {
            allergyId: ALLERGY_ID,
            verificationStatus: "REFUTED",
            reasonCode: ALLERGY_STATUS_CHANGE_REASONS.REFUTED_PATIENT_CORRECTION,
          },
          { idempotencyKey: "amend-missing" }
        )
      )
    ).rejects.toMatchObject({ code: "ALLERGY_NOT_FOUND" });
  });

  it("is not granted by patients.allergies.record alone", async () => {
    // The permission split that matters: recording an allergy adds a
    // safety check, amending one can remove it. A technician who can do
    // the first must not be able to do the second by default.
    const fake = buildFakePrisma();
    wire(fake.client, recordGrants);

    await expect(
      withTenancyContext(ctx(), () =>
        executeCommand(
          AmendPatientAllergyStatus,
          {
            allergyId: ALLERGY_ID,
            verificationStatus: "REFUTED",
            reasonCode: ALLERGY_STATUS_CHANGE_REASONS.REFUTED_PATIENT_CORRECTION,
          },
          { idempotencyKey: "amend-wrongperm" }
        )
      )
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    expect(callsOf(fake.calls, "patientAllergy", "update")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------
// AssertPatientAllergyHistory
// ---------------------------------------------------------------------

describe("AssertPatientAllergyHistory — the negative assertion", () => {
  it("records NO_KNOWN_ALLERGIES with an asserter and a time", async () => {
    const fake = buildFakePrisma();
    wire(fake.client);

    const out = await withTenancyContext(ctx(), () =>
      executeCommand(
        AssertPatientAllergyHistory,
        { patientId: PATIENT_ID, status: "NO_KNOWN_ALLERGIES" },
        { idempotencyKey: "assert-1" }
      )
    );

    const row = dataOf(onlyCall(fake.calls, "patientAllergyHistoryAssertion", "create"));
    expect(row).toMatchObject({
      organizationId: ORG_ID,
      clinicId: CLINIC_ID,
      patientId: PATIENT_ID,
      status: "NO_KNOWN_ALLERGIES",
      assertedByUserId: USER_ID,
      assertedAt: NOW,
    });
    expect(out.satisfiesAllergyScreening).toBe(true);
  });

  it("reports UNABLE_TO_ASSESS as NOT satisfying the screening axis", async () => {
    // The most dangerous confusion this feature could contain, surfaced
    // on the command's own output so a console can tell the operator the
    // gap is still open.
    const fake = buildFakePrisma();
    wire(fake.client);

    const out = await withTenancyContext(ctx(), () =>
      executeCommand(
        AssertPatientAllergyHistory,
        { patientId: PATIENT_ID, status: "UNABLE_TO_ASSESS" },
        { idempotencyKey: "assert-unable" }
      )
    );

    expect(out.satisfiesAllergyScreening).toBe(false);
    expect(dataOf(onlyCall(fake.calls, "auditLog", "create"))["metadata"]).toMatchObject({
      status: "UNABLE_TO_ASSESS",
      satisfiesAllergyScreening: false,
    });
  });

  it("appends rather than updating, so a superseded assertion survives", async () => {
    const fake = buildFakePrisma();
    wire(fake.client);

    await withTenancyContext(ctx(), () =>
      executeCommand(
        AssertPatientAllergyHistory,
        { patientId: PATIENT_ID, status: "NO_KNOWN_ALLERGIES" },
        { idempotencyKey: "assert-append" }
      )
    );

    expect(callsOf(fake.calls, "patientAllergyHistoryAssertion", "create")).toHaveLength(1);
    expect(callsOf(fake.calls, "patientAllergyHistoryAssertion", "update")).toHaveLength(0);
    expect(callsOf(fake.calls, "patientAllergyHistoryAssertion", "upsert")).toHaveLength(0);
  });

  it("accepts a recent backfilled clinical time", async () => {
    const fake = buildFakePrisma();
    wire(fake.client);

    await withTenancyContext(ctx(), () =>
      executeCommand(
        AssertPatientAllergyHistory,
        {
          patientId: PATIENT_ID,
          status: "NO_KNOWN_ALLERGIES",
          assertedAt: "2026-05-20T09:00:00.000Z",
        },
        { idempotencyKey: "assert-backfill" }
      )
    );

    expect(
      dataOf(onlyCall(fake.calls, "patientAllergyHistoryAssertion", "create"))["assertedAt"]
    ).toEqual(new Date("2026-05-20T09:00:00.000Z"));
  });

  it("refuses a future assertion", async () => {
    // The latest assertion wins, so a future-dated one would pin the
    // patient's allergy state until real time caught up — outranking
    // every correct assertion made in between.
    const fake = buildFakePrisma();
    wire(fake.client);

    await expect(
      withTenancyContext(ctx(), () =>
        executeCommand(
          AssertPatientAllergyHistory,
          {
            patientId: PATIENT_ID,
            status: "NO_KNOWN_ALLERGIES",
            assertedAt: "2027-01-01T00:00:00.000Z",
          },
          { idempotencyKey: "assert-future" }
        )
      )
    ).rejects.toMatchObject({ code: "ALLERGY_HISTORY_ASSERTED_IN_FUTURE" });
    expect(callsOf(fake.calls, "patientAllergyHistoryAssertion", "create")).toHaveLength(0);
  });

  it("refuses a stale backfill beyond the window", async () => {
    // This assertion is what lets allergy screening report clear, so it
    // has to reflect a history somebody took recently.
    const fake = buildFakePrisma();
    wire(fake.client);

    await expect(
      withTenancyContext(ctx(), () =>
        executeCommand(
          AssertPatientAllergyHistory,
          {
            patientId: PATIENT_ID,
            status: "NO_KNOWN_ALLERGIES",
            assertedAt: "2020-01-01T00:00:00.000Z",
          },
          { idempotencyKey: "assert-stale" }
        )
      )
    ).rejects.toMatchObject({ code: "ALLERGY_HISTORY_ASSERTED_TOO_LONG_AGO" });
  });

  it("refuses an unknown or cross-tenant patient", async () => {
    const fake = buildFakePrisma({ patientExists: false });
    wire(fake.client);

    await expect(
      withTenancyContext(ctx(), () =>
        executeCommand(
          AssertPatientAllergyHistory,
          { patientId: PATIENT_ID, status: "NO_KNOWN_ALLERGIES" },
          { idempotencyKey: "assert-nopat" }
        )
      )
    ).rejects.toMatchObject({ code: "ALLERGY_HISTORY_PATIENT_NOT_FOUND" });
  });

  it("carries no PHI beyond ids, one enum and timestamps", async () => {
    const fake = buildFakePrisma();
    wire(fake.client);

    await withTenancyContext(ctx(), () =>
      executeCommand(
        AssertPatientAllergyHistory,
        { patientId: PATIENT_ID, status: "NO_KNOWN_ALLERGIES" },
        { idempotencyKey: "assert-phi" }
      )
    );

    const payload = (
      onlyCall(fake.calls, "eventOutbox", "createMany").args as {
        data: Array<Record<string, unknown>>;
      }
    ).data[0]?.["payload"] as Record<string, unknown>;

    expect(Object.keys(payload).sort()).toEqual([
      "assertedAt",
      "assertionId",
      "clinicId",
      "occurredAt",
      "organizationId",
      "patientId",
      "status",
    ]);
  });

  it("shares the record grant with RecordPatientAllergy", async () => {
    // One grant on purpose: split them and the predictable outcome is
    // staff who can add allergies but cannot record their absence, so
    // nobody records the absence and the screening gap never closes for
    // a genuinely allergy-free patient.
    const fake = buildFakePrisma();
    wire(fake.client, grantsFor([PERMISSIONS.PATIENTS_ALLERGIES_RECORD]));

    await expect(
      withTenancyContext(ctx(), () =>
        executeCommand(
          AssertPatientAllergyHistory,
          { patientId: PATIENT_ID, status: "NO_KNOWN_ALLERGIES" },
          { idempotencyKey: "assert-grant" }
        )
      )
    ).resolves.toMatchObject({ satisfiesAllergyScreening: true });
  });

  it("denies a caller in another tenant", async () => {
    // The grants are loaded for (ORG_ID, USER_ID); a context in another
    // organization resolves no permissions at all.
    const fake = buildFakePrisma();
    wire(fake.client);

    await expect(
      withTenancyContext(ctx(OTHER_ORG_ID), () =>
        executeCommand(
          AssertPatientAllergyHistory,
          { patientId: PATIENT_ID, status: "NO_KNOWN_ALLERGIES" },
          { idempotencyKey: "assert-othertenant" }
        )
      )
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    expect(callsOf(fake.calls, "patientAllergyHistoryAssertion", "create")).toHaveLength(0);
  });
});
