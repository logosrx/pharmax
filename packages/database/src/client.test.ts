// Smoke test only — does NOT connect to a database. Verifies the package
// surface exists, the singleton is reused, and `$disconnect` is callable
// on a never-connected client.

import process from "node:process";

import { describe, expect, it, beforeAll, afterAll } from "vitest";

beforeAll(() => {
  process.env["DATABASE_URL"] ??= "postgresql://test:test@localhost:5432/test";
  process.env["DIRECT_URL"] ??= "postgresql://test:test@localhost:5432/test";
});

afterAll(async () => {
  const { prisma } = await import("./index.js");
  await prisma.$disconnect();
});

describe("@pharmax/database", () => {
  it("exposes a PrismaClient singleton", async () => {
    const mod = await import("./index.js");
    expect(mod.prisma).toBeDefined();
    expect(typeof mod.prisma.$disconnect).toBe("function");
  });

  it("returns the same instance on repeated import", async () => {
    const a = await import("./index.js");
    const b = await import("./index.js");
    expect(a.prisma).toBe(b.prisma);
  });
});
