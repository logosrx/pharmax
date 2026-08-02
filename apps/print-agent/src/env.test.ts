import { describe, expect, it } from "vitest";

import { __envSchemaForTests as schema } from "./env";

/**
 * Regression cover for the 2026-08-02 production incident: the ECS task
 * definition injected none of the print-agent's identity variables, so it
 * booted against the `acme` development fixture, failed to resolve a tenant
 * that does not exist in production, and crash-looped until the deployment
 * timed out. These tests assert that the same misconfiguration is now
 * rejected at env-parse time with a message that names the cause.
 */

const PRODUCTION_BASE = {
  NODE_ENV: "production",
  DATABASE_URL: "postgresql://user:pw@db.internal:5432/pharmax",
  PRINT_AGENT_ORG_SLUG: "northwind-pharmacy",
  PRINT_AGENT_WORKSTATION_CODE: "SITE1-FILL-03",
  PRINT_AGENT_ACTOR_EMAIL: "print-agent@northwind.example.com",
  PRINT_AGENT_ZPL_MODE: "tcp",
  PRINT_AGENT_PRINTER_HOST: "10.20.30.40",
} as const;

/** Field keys carrying an issue, so assertions do not depend on wording. */
function failedFields(input: Record<string, unknown>): ReadonlyArray<string> {
  const result = schema.safeParse(input);
  if (result.success) {
    return [];
  }
  return Object.keys(result.error.flatten().fieldErrors);
}

describe("print-agent env — production boot guard", () => {
  it("accepts a fully configured production environment", () => {
    expect(schema.safeParse(PRODUCTION_BASE).success).toBe(true);
  });

  it("rejects every fixture default at once, so one boot reports all of them", () => {
    // Exactly the 2026-08-02 shape: nothing injected, all defaults applied.
    const fields = failedFields({
      NODE_ENV: "production",
      DATABASE_URL: PRODUCTION_BASE.DATABASE_URL,
    });

    expect(fields).toEqual(
      expect.arrayContaining([
        "PRINT_AGENT_ORG_SLUG",
        "PRINT_AGENT_WORKSTATION_CODE",
        "PRINT_AGENT_ACTOR_EMAIL",
        "PRINT_AGENT_ZPL_MODE",
      ])
    );
  });

  it.each([
    ["PRINT_AGENT_ORG_SLUG", "acme"],
    ["PRINT_AGENT_WORKSTATION_CODE", "WS-01"],
    ["PRINT_AGENT_ACTOR_EMAIL", "print-agent@acme.test"],
  ])("rejects the fixture value for %s", (key, fixture) => {
    expect(failedFields({ ...PRODUCTION_BASE, [key]: fixture })).toContain(key);
  });

  it("rejects any .test actor address, not just the seeded one", () => {
    expect(
      failedFields({ ...PRODUCTION_BASE, PRINT_AGENT_ACTOR_EMAIL: "ops@somewhere.test" })
    ).toContain("PRINT_AGENT_ACTOR_EMAIL");
  });

  it("rejects file ZPL mode, which would record labels that never printed", () => {
    expect(failedFields({ ...PRODUCTION_BASE, PRINT_AGENT_ZPL_MODE: "file" })).toContain(
      "PRINT_AGENT_ZPL_MODE"
    );
  });

  it("rejects a loopback printer host in tcp mode", () => {
    expect(failedFields({ ...PRODUCTION_BASE, PRINT_AGENT_PRINTER_HOST: "127.0.0.1" })).toContain(
      "PRINT_AGENT_PRINTER_HOST"
    );
  });

  it("explains the cause rather than only naming the field", () => {
    const result = schema.safeParse({
      NODE_ENV: "production",
      DATABASE_URL: PRODUCTION_BASE.DATABASE_URL,
    });
    expect(result.success).toBe(false);
    if (result.success) {
      return;
    }
    const message = result.error.flatten().fieldErrors["PRINT_AGENT_ORG_SLUG"]?.[0] ?? "";
    expect(message).toContain("Refusing to boot");
    expect(message).toContain("crash-loops");
  });
});

describe("print-agent env — non-production", () => {
  // The defaults exist so `pnpm dev` needs no configuration; the guard must
  // not take that away.
  it.each(["development", "test"])("leaves %s defaults usable", (nodeEnv) => {
    const result = schema.safeParse({
      NODE_ENV: nodeEnv,
      DATABASE_URL: "postgresql://user:pw@localhost:5432/pharmax",
    });
    expect(result.success).toBe(true);
    if (!result.success) {
      return;
    }
    expect(result.data.PRINT_AGENT_ORG_SLUG).toBe("acme");
    expect(result.data.PRINT_AGENT_ZPL_MODE).toBe("file");
  });
});
