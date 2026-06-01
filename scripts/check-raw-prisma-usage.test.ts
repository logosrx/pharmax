// Unit tests for the raw-client (`systemPrisma`) import guard.
//
// Exercises the pure `importsRawClient` scanner against the import
// shapes that matter: named import, aliased import, mixed imports,
// the safe `prisma` import (must NOT trip), and imports from other
// modules (must NOT trip).

import { describe, expect, it } from "vitest";

import { importsRawClient } from "./check-raw-prisma-usage.js";

describe("importsRawClient", () => {
  it("flags a direct named import of systemPrisma", () => {
    const src = `import { systemPrisma } from "@pharmax/database";\nexport const x = systemPrisma;`;
    expect(importsRawClient(src, "f.ts")).toBe(true);
  });

  it("flags systemPrisma mixed with other named imports", () => {
    const src = `import { prisma, systemPrisma, type Order } from "@pharmax/database";`;
    expect(importsRawClient(src, "f.ts")).toBe(true);
  });

  it("flags an aliased systemPrisma import", () => {
    const src = `import { systemPrisma as raw } from "@pharmax/database";`;
    expect(importsRawClient(src, "f.ts")).toBe(true);
  });

  it("does NOT flag the tenancy-enforced prisma import", () => {
    const src = `import { prisma, readInOrgScope, type OrderStatus } from "@pharmax/database";`;
    expect(importsRawClient(src, "f.ts")).toBe(false);
  });

  it("does NOT flag a systemPrisma import from a different module", () => {
    const src = `import { systemPrisma } from "./local-fake.js";`;
    expect(importsRawClient(src, "f.ts")).toBe(false);
  });

  it("does NOT flag a local identifier named systemPrisma", () => {
    const src = `const systemPrisma = makeFake();\nexport { systemPrisma };`;
    expect(importsRawClient(src, "f.ts")).toBe(false);
  });

  it("does NOT flag files with no @pharmax/database import at all", () => {
    const src = `import { z } from "zod";\nexport const schema = z.object({});`;
    expect(importsRawClient(src, "f.ts")).toBe(false);
  });
});
