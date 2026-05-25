// Anti-leak property test.
//
// This file exists as a STANDALONE security artifact. A SOC 2
// reviewer should be able to read just this file and the
// `applyTenancyExtension` source and convince themselves cross-org
// reads are impossible.
//
// We construct a tiny fake "database" of two orgs (A and B), each
// with a single Clinic. We then drive realistic query patterns
// from inside both contexts in parallel and assert no row
// from org A is ever returned to a caller in org B (and vice
// versa) — including when the caller in org B passes the exact
// id of an org A row to `findUnique`.

import { describe, expect, it } from "vitest";

import { withTenancyContext } from "./als.js";
import { buildTenancyContext, type TenancyContext } from "./context.js";
import { applyTenancyExtension } from "./prisma-extension.js";

type Row = { readonly id: string; readonly organizationId: string; readonly name: string };

const seed: ReadonlyArray<Row> = Object.freeze([
  { id: "11111111-1111-1111-1111-111111111111", organizationId: "org-A", name: "Clinic A" },
  { id: "22222222-2222-2222-2222-222222222222", organizationId: "org-B", name: "Clinic B" },
]);

function matches(row: Row, where: Record<string, unknown> | undefined): boolean {
  if (where === undefined) return true;
  for (const [key, value] of Object.entries(where)) {
    if ((row as unknown as Record<string, unknown>)[key] !== value) return false;
  }
  return true;
}

function makeFakeDatabase(): {
  client: ReturnType<typeof applyTenancyExtension>;
  simulate: (
    model: string,
    operation: string,
    args: Record<string, unknown> | undefined
  ) => Promise<Row | Row[] | null>;
} {
  let handler:
    | ((ctx: {
        model: string | undefined;
        operation: string;
        args: Record<string, unknown> | undefined;
        query: (args: Record<string, unknown> | undefined) => Promise<unknown>;
      }) => Promise<unknown>)
    | undefined;

  const fakeClient = {
    $extends(arg: {
      query?: {
        $allModels?: {
          $allOperations?: (ctx: {
            model: string | undefined;
            operation: string;
            args: Record<string, unknown> | undefined;
            query: (args: Record<string, unknown> | undefined) => Promise<unknown>;
          }) => Promise<unknown>;
        };
      };
    }) {
      handler = arg.query?.$allModels?.$allOperations;
      return fakeClient;
    },
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const extended = applyTenancyExtension(fakeClient as any);

  const simulate = async (
    model: string,
    operation: string,
    args: Record<string, unknown> | undefined
  ): Promise<Row | Row[] | null> => {
    if (handler === undefined) throw new Error("handler missing");
    const result = await handler({
      model,
      operation,
      args,
      query: async (forwardedArgs) => {
        const where = forwardedArgs?.["where"] as Record<string, unknown> | undefined;
        const filtered = seed.filter((r) => matches(r, where));
        if (operation === "findUnique" || operation === "findFirst") {
          return filtered[0] ?? null;
        }
        return filtered;
      },
    });
    return result as Row | Row[] | null;
  };

  return { client: extended, simulate };
}

function ctxFor(orgId: string): TenancyContext {
  return buildTenancyContext({
    organizationId: orgId,
    actor: { userId: "u", correlationId: "01ULID000000000000000000000" },
  });
}

describe("anti-leak: cross-org isolation", () => {
  it("findMany inside org-A returns only org-A rows", async () => {
    const { simulate } = makeFakeDatabase();
    const seenInA = (await withTenancyContext(ctxFor("org-A"), () =>
      simulate("Clinic", "findMany", {})
    )) as Row[];
    expect(seenInA.map((r) => r.organizationId)).toEqual(["org-A"]);
  });

  it("findUnique with a guessed cross-org id returns null", async () => {
    const { simulate } = makeFakeDatabase();
    // Caller in org-B guesses (or steals) the id of an org-A clinic.
    const stolenId = "11111111-1111-1111-1111-111111111111";
    const result = await withTenancyContext(ctxFor("org-B"), () =>
      simulate("Clinic", "findUnique", { where: { id: stolenId } })
    );
    expect(result).toBeNull();
  });

  it("parallel queries from two orgs never cross-contaminate", async () => {
    const { simulate } = makeFakeDatabase();
    const iterations = 50;
    const tasks: Array<Promise<unknown>> = [];

    for (let i = 0; i < iterations; i += 1) {
      tasks.push(
        withTenancyContext(ctxFor("org-A"), async () => {
          const rows = (await simulate("Clinic", "findMany", {})) as Row[];
          if (rows.some((r) => r.organizationId !== "org-A")) {
            throw new Error("LEAK: org-A saw an org-B row");
          }
        })
      );
      tasks.push(
        withTenancyContext(ctxFor("org-B"), async () => {
          const rows = (await simulate("Clinic", "findMany", {})) as Row[];
          if (rows.some((r) => r.organizationId !== "org-B")) {
            throw new Error("LEAK: org-B saw an org-A row");
          }
        })
      );
    }

    await expect(Promise.all(tasks)).resolves.toBeDefined();
  });
});
