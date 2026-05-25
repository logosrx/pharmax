// Unit tests for the command-file linter scanner.
//
// Tests work on synthetic source strings — no filesystem access
// required. Each pattern (defineCommand call, Command typed
// declaration, SystemCommand typed declaration) gets a green
// case and a red case so the rule's boundary is pinned.

import { describe, expect, it } from "vitest";

import { scanCommandFile } from "./check-command-files.js";

describe("scanCommandFile — accepting patterns", () => {
  it("accepts a defineCommand() factory call", () => {
    const src = `
import { defineCommand } from "@pharmax/command-bus";
export const StartTyping = defineCommand<Input, Output>({
  name: "StartTyping",
  inputSchema: someSchema,
  handle: async () => ({ output: {}, audit: {} } as any),
});
`;
    expect(scanCommandFile(src, "start-typing.ts").ok).toBe(true);
  });

  it("accepts a defineCommand call wrapped in `satisfies`", () => {
    const src = `
import { defineCommand } from "@pharmax/command-bus";
export const X = defineCommand<I, O>({ name: "X" }) satisfies SomeShape;
`;
    expect(scanCommandFile(src, "x.ts").ok).toBe(true);
  });

  it("accepts a defineCommand call wrapped in `as const`", () => {
    const src = `
import { defineCommand } from "@pharmax/command-bus";
export const X = defineCommand<I, O>({ name: "X" }) as const;
`;
    expect(scanCommandFile(src, "x.ts").ok).toBe(true);
  });

  it("accepts a Command<I, O> typed declaration", () => {
    const src = `
import type { Command } from "@pharmax/command-bus";
export const RegisterPatient: Command<Input, Output> = {
  name: "RegisterPatient",
  inputSchema: someSchema,
  permission: "patients.create",
  async handle() { return {} as any; },
};
`;
    expect(scanCommandFile(src, "register-patient.ts").ok).toBe(true);
  });

  it("accepts a SystemCommand<I, O> typed declaration", () => {
    const src = `
import type { SystemCommand } from "@pharmax/command-bus";
export const CreateOrganization: SystemCommand<Input, Output> = {
  name: "CreateOrganization",
  inputSchema: someSchema,
  async handle() { return {} as any; },
};
`;
    expect(scanCommandFile(src, "create-organization.ts").ok).toBe(true);
  });
});

describe("scanCommandFile — rejecting patterns", () => {
  it("rejects a file with no exports", () => {
    const src = `
const private_helper = 1;
function nothingExported() { return 2; }
`;
    const result = scanCommandFile(src, "x.ts");
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/no `export const`/);
  });

  it("rejects an exported plain async function (the regression we want to catch)", () => {
    const src = `
import { prisma } from "@pharmax/database";
export async function doSomething(input: unknown) {
  return prisma.order.update({ where: { id: "x" }, data: { status: "x" } });
}
`;
    const result = scanCommandFile(src, "do-something.ts");
    expect(result.ok).toBe(false);
    // The function is exported but it's NOT an `export const`,
    // so the linter falls through to the "no export const" branch.
    expect(result.reason).toMatch(/no `export const`/);
  });

  it("rejects an exported const that's neither a defineCommand call nor a typed Command", () => {
    const src = `
export const someConfig = { name: "x", inputSchema: {} };
`;
    const result = scanCommandFile(src, "x.ts");
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/no `defineCommand/);
  });

  it("rejects an exported const annotated with an unrelated type", () => {
    const src = `
type SomeConfig<I, O> = { name: string };
export const X: SomeConfig<I, O> = { name: "x" };
`;
    const result = scanCommandFile(src, "x.ts");
    expect(result.ok).toBe(false);
  });

  it("rejects a different factory call (not defineCommand)", () => {
    const src = `
export const X = makeSomething<I, O>({ name: "x" });
`;
    expect(scanCommandFile(src, "x.ts").ok).toBe(false);
  });
});

describe("scanCommandFile — edge cases", () => {
  it("accepts a file with both: defineCommand call AND another unrelated export", () => {
    const src = `
import { defineCommand } from "@pharmax/command-bus";
export const PV1_REJECTION_REASONS = ["A", "B"] as const;
export const RejectPV1 = defineCommand<I, O>({ name: "RejectPV1" });
`;
    expect(scanCommandFile(src, "reject-pv1.ts").ok).toBe(true);
  });

  it("accepts a file with both: Command typed declaration AND a helper const", () => {
    const src = `
import type { Command } from "@pharmax/command-bus";
export const RX_NUMBER_LIMIT = 50;
export const RegisterPatient: Command<I, O> = { name: "RegisterPatient" } as any;
`;
    expect(scanCommandFile(src, "register-patient.ts").ok).toBe(true);
  });

  it("does NOT accept a file where the typed export uses a wrong type name", () => {
    const src = `
export const X: Handler<I, O> = { name: "X" } as any;
`;
    expect(scanCommandFile(src, "x.ts").ok).toBe(false);
  });
});
