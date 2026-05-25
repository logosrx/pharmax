// `buildSearchWhere` contract tests.
//
// `searchPatients` itself talks to Prisma — covered by integration
// tests with a real database. What we pin here is the where-clause
// builder: it normalizes inputs, derives blind-index hashes, and
// composes a Prisma `where` shape that exploits the existing
// `(organizationId, *Bi)` btree indexes.
//
// Crypto is configured with a local KMS seed so the blind-index
// hashes are deterministic across the suite.

import { configureCrypto, LocalKmsAdapter } from "@pharmax/crypto";
import { beforeAll, describe, expect, it } from "vitest";

import { buildSearchWhere } from "./search-patients.js";

const TENANT = "11111111-1111-1111-1111-111111111111";
const CLINIC = "22222222-2222-2222-2222-222222222222";

beforeAll(() => {
  configureCrypto({ kms: new LocalKmsAdapter({ seed: "search-patients-test-seed" }) });
});

describe("buildSearchWhere", () => {
  it("returns null when no query fields are set", async () => {
    const where = await buildSearchWhere({
      tenantId: TENANT,
      query: {},
      includeNonActive: false,
    });
    expect(where).toBeNull();
  });

  it("returns null when every field normalizes to empty", async () => {
    // Whitespace-only names normalize to empty inside the crypto
    // layer; an empty normalized input yields a null blind index,
    // which the builder skips. With no usable fields, the result
    // is null overall (no unbounded scan).
    const where = await buildSearchWhere({
      tenantId: TENANT,
      query: { firstName: "  ", lastName: "" },
      includeNonActive: false,
    });
    expect(where).toBeNull();
  });

  it("builds an AND of equality conditions on the *Bi columns", async () => {
    const where = await buildSearchWhere({
      tenantId: TENANT,
      query: { lastName: "Doe", firstName: "Jane" },
      includeNonActive: false,
    });
    expect(where).not.toBeNull();
    expect(where?.status).toBe("ACTIVE");
    const conds = where?.AND;
    expect(Array.isArray(conds)).toBe(true);
    const arr = conds as Array<Record<string, unknown>>;
    expect(arr).toHaveLength(2);
    const cols = arr.map((c) => Object.keys(c)[0]).sort();
    expect(cols).toEqual(["firstNameBi", "lastNameBi"]);
  });

  it("normalizes the DOB before hashing", async () => {
    // Bad shape ⇒ skipped; result should not contain a `dobBi` cond.
    const where = await buildSearchWhere({
      tenantId: TENANT,
      query: { dateOfBirth: "1990/04/15", lastName: "Doe" },
      includeNonActive: false,
    });
    expect(where).not.toBeNull();
    const conds = where?.AND as Array<Record<string, unknown>>;
    const cols = conds.map((c) => Object.keys(c)[0]);
    expect(cols).not.toContain("dobBi");
    expect(cols).toContain("lastNameBi");
  });

  it("includes the dobBi condition for a well-formed YYYY-MM-DD", async () => {
    const where = await buildSearchWhere({
      tenantId: TENANT,
      query: { dateOfBirth: "1990-04-15" },
      includeNonActive: false,
    });
    const conds = where?.AND as Array<Record<string, unknown>>;
    expect(conds).toHaveLength(1);
    expect(Object.keys(conds[0]!)).toEqual(["dobBi"]);
    expect(typeof (conds[0]! as Record<string, unknown>)["dobBi"]).toBe("string");
  });

  it("uses the phone-last-10 normalizer (digits only)", async () => {
    const a = await buildSearchWhere({
      tenantId: TENANT,
      query: { phone: "(415) 555-0100" },
      includeNonActive: false,
    });
    const b = await buildSearchWhere({
      tenantId: TENANT,
      query: { phone: "4155550100" },
      includeNonActive: false,
    });
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    // Same digits → same hash.
    expect((a?.AND as Array<Record<string, string>>)[0]!["phoneLast10Bi"]).toBe(
      (b?.AND as Array<Record<string, string>>)[0]!["phoneLast10Bi"]
    );
  });

  it("adds the clinicId filter when provided", async () => {
    const where = await buildSearchWhere({
      tenantId: TENANT,
      query: { lastName: "Doe" },
      clinicId: CLINIC,
      includeNonActive: false,
    });
    expect(where?.clinicId).toBe(CLINIC);
  });

  it("includeNonActive=true drops the ACTIVE status filter", async () => {
    const where = await buildSearchWhere({
      tenantId: TENANT,
      query: { lastName: "Doe" },
      includeNonActive: true,
    });
    expect(where?.status).toBeUndefined();
  });

  it("produces tenant-specific hashes — same plaintext, different tenants ⇒ different hashes", async () => {
    const a = await buildSearchWhere({
      tenantId: TENANT,
      query: { lastName: "Doe" },
      includeNonActive: false,
    });
    const otherTenant = "33333333-3333-3333-3333-333333333333";
    const b = await buildSearchWhere({
      tenantId: otherTenant,
      query: { lastName: "Doe" },
      includeNonActive: false,
    });
    const hashA = (a?.AND as Array<Record<string, string>>)[0]!["lastNameBi"];
    const hashB = (b?.AND as Array<Record<string, string>>)[0]!["lastNameBi"];
    expect(hashA).not.toBe(hashB);
  });

  it("hash is deterministic across calls in the same tenant", async () => {
    const a = await buildSearchWhere({
      tenantId: TENANT,
      query: { lastName: "Doe" },
      includeNonActive: false,
    });
    const b = await buildSearchWhere({
      tenantId: TENANT,
      query: { lastName: "Doe" },
      includeNonActive: false,
    });
    const hashA = (a?.AND as Array<Record<string, string>>)[0]!["lastNameBi"];
    const hashB = (b?.AND as Array<Record<string, string>>)[0]!["lastNameBi"];
    expect(hashA).toBe(hashB);
  });
});
