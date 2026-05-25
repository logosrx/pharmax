import { describe, it, expect, beforeEach } from "vitest";

import { buildTenancyContext, type TenancyContext } from "./context.js";
import {
  applyTenancySessionGuc,
  applySystemSessionGuc,
  clearSessionGuc,
  type SessionGucExecutor,
} from "./session-guc.js";

// Captures the args passed to $executeRaw for assertions. Mirrors
// Prisma's tagged-template signature shape.
interface RecordedCall {
  readonly strings: ReadonlyArray<string>;
  readonly values: ReadonlyArray<unknown>;
}

class FakeTx implements SessionGucExecutor {
  public readonly calls: RecordedCall[] = [];

  $executeRaw(template: TemplateStringsArray, ...values: ReadonlyArray<unknown>): Promise<number> {
    this.calls.push({ strings: [...template], values });
    return Promise.resolve(0);
  }

  /** Render a recorded call as a single string for substring matching. */
  rendered(idx: number): string {
    const c = this.calls[idx];
    if (c === undefined) throw new Error(`no call at index ${idx}`);
    let out = "";
    c.strings.forEach((s, i) => {
      out += s;
      if (i < c.values.length) out += `<<${String(c.values[i])}>>`;
    });
    return out;
  }
}

function ctx(overrides: Partial<TenancyContext> = {}): TenancyContext {
  const base = {
    organizationId: "11111111-1111-7111-a111-111111111111",
    actor: {
      userId: "22222222-2222-7222-a222-222222222222",
      correlationId: "33333333-3333-7333-a333-333333333333",
    },
    ...overrides,
  };
  return buildTenancyContext(base as unknown as Parameters<typeof buildTenancyContext>[0]);
}

let tx: FakeTx;

beforeEach(() => {
  tx = new FakeTx();
});

describe("applyTenancySessionGuc — happy path", () => {
  it("sets pharmax.organization_id to the active tenant", async () => {
    await applyTenancySessionGuc(tx, ctx());
    expect(tx.calls.length).toBe(2);
    expect(tx.rendered(0)).toContain("pharmax.organization_id");
    expect(tx.calls[0]?.values).toContain("11111111-1111-7111-a111-111111111111");
  });

  it("also defensively clears pharmax.system_context", async () => {
    await applyTenancySessionGuc(tx, ctx());
    expect(tx.rendered(1)).toContain("pharmax.system_context");
    // Cleared to empty string, NOT 'on'.
    expect(tx.calls[1]?.values).toContain("");
  });

  it("uses set_config with is_local=true (tx-scoped, not connection-scoped)", async () => {
    await applyTenancySessionGuc(tx, ctx());
    for (const call of tx.calls) {
      const joined = call.strings.join("");
      expect(joined).toMatch(/set_config/);
      expect(joined).toMatch(/,\s*true\s*\)/);
    }
  });

  it("does not log the organization id as a string literal (passes it as a bound parameter)", async () => {
    const orgId = "44444444-4444-7444-a444-444444444444";
    await applyTenancySessionGuc(tx, ctx({ organizationId: orgId }));
    // The org id must NOT appear inside the template strings — it
    // must be a bound value. This is the injection-safety contract.
    for (const call of tx.calls) {
      for (const s of call.strings) {
        expect(s).not.toContain(orgId);
      }
    }
    expect(tx.calls[0]?.values).toContain(orgId);
  });
});

describe("applyTenancySessionGuc — validation", () => {
  it("throws when organizationId is empty string", async () => {
    await expect(applyTenancySessionGuc(tx, ctx({ organizationId: "" }))).rejects.toThrow(
      /organizationId is required/
    );
    expect(tx.calls.length).toBe(0);
  });

  it("does not throw on legitimately uuid-shaped values", async () => {
    await expect(
      applyTenancySessionGuc(tx, ctx({ organizationId: "55555555-5555-7555-a555-555555555555" }))
    ).resolves.toBeUndefined();
  });
});

describe("applySystemSessionGuc — happy path", () => {
  it("clears organization_id, sets system_context='on', records the reason", async () => {
    await applySystemSessionGuc(tx, "CreateOrganization bootstrap");
    expect(tx.calls.length).toBe(3);
    // First call: clear org id.
    expect(tx.rendered(0)).toContain("pharmax.organization_id");
    expect(tx.calls[0]?.values).toContain("");
    // Second call: set system_context='on'.
    expect(tx.rendered(1)).toContain("pharmax.system_context");
    expect(tx.calls[1]?.values).toContain("on");
    // Third call: record the reason for audit.
    expect(tx.rendered(2)).toContain("pharmax.system_context_reason");
    expect(tx.calls[2]?.values).toContain("CreateOrganization bootstrap");
  });

  it("passes the reason as a bound parameter (audit message not a SQL literal)", async () => {
    const reason = "RotateKeyMaterialJob";
    await applySystemSessionGuc(tx, reason);
    // Reason MUST NOT appear in template text.
    for (const call of tx.calls) {
      for (const s of call.strings) {
        expect(s).not.toContain(reason);
      }
    }
    expect(tx.calls[2]?.values).toContain(reason);
  });
});

describe("applySystemSessionGuc — validation", () => {
  it("throws when reason is an empty string", async () => {
    await expect(applySystemSessionGuc(tx, "")).rejects.toThrow(/reason is required/);
    expect(tx.calls.length).toBe(0);
  });
});

describe("clearSessionGuc", () => {
  it("issues three clearing set_config calls", async () => {
    await clearSessionGuc(tx);
    expect(tx.calls.length).toBe(3);
    for (const call of tx.calls) {
      expect(call.strings.join("")).toMatch(/set_config/);
      expect(call.values).toContain("");
    }
  });
});

describe("integration shape — tenancy then system bypass", () => {
  it("a subsequent applySystemSessionGuc clears the prior tenant pin", async () => {
    await applyTenancySessionGuc(tx, ctx());
    const tenancyCalls = tx.calls.length;
    await applySystemSessionGuc(tx, "supervisor");
    const systemCalls = tx.calls.length - tenancyCalls;
    // The system path issues 3 calls including the org_id clear.
    expect(systemCalls).toBe(3);
    const firstSystemCall = tx.calls[tenancyCalls];
    expect(firstSystemCall?.strings.join("")).toContain("pharmax.organization_id");
    expect(firstSystemCall?.values).toContain("");
  });
});
