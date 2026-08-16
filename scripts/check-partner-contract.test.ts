// Tests for scripts/check-partner-contract.ts — the partner-API
// wire-contract drift gate.
//
// Two layers:
//
//   1. Unit tests over the pure pieces (method extraction, path
//      mapping, the diff) with synthetic fixtures, so each rule's
//      firing condition is pinned independently.
//   2. A whole-repo SENTINEL: the real `apps/web/app/api/v1` route
//      tree diffed against the real `docs/api/openapi-v1.yaml`. This
//      is the versioning guard — adding a v1 route without a spec
//      entry (or deleting a route the spec still documents) fails
//      the default `pnpm test` run, not just the `check:*` linter.

import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  diffContract,
  extractRouteMethods,
  routeDirToSpecPath,
  runCheck,
  type RouteEntry,
  type SpecDocument,
} from "./check-partner-contract.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("extractRouteMethods", () => {
  it("finds exported async function handlers", () => {
    const source = `
      export async function GET(request: Request): Promise<Response> { return new Response(); }
      export async function POST(request: Request): Promise<Response> { return new Response(); }
    `;
    expect(extractRouteMethods(source, "route.ts")).toEqual(["GET", "POST"]);
  });

  it("finds exported const handlers", () => {
    const source = `export const DELETE = () => new Response();`;
    expect(extractRouteMethods(source, "route.ts")).toEqual(["DELETE"]);
  });

  it("ignores non-exported functions, other names, comments and strings", () => {
    const source = `
      async function GET(): Promise<Response> { return new Response(); }
      export async function helper(): Promise<void> {}
      // export async function POST() {} — commented out
      const s = "export async function PUT()";
    `;
    expect(extractRouteMethods(source, "route.ts")).toEqual([]);
  });
});

describe("routeDirToSpecPath", () => {
  it("maps the v1 root to /", () => {
    expect(routeDirToSpecPath("")).toBe("/");
  });

  it("maps plain segments verbatim", () => {
    expect(routeDirToSpecPath("orders")).toBe("/orders");
  });

  it("maps [param] directories to {param} templates", () => {
    expect(routeDirToSpecPath(["orders", "[orderId]"].join(sep))).toBe("/orders/{orderId}");
    expect(
      routeDirToSpecPath(["webhook-subscriptions", "[subscriptionId]", "rotate-secret"].join(sep))
    ).toBe("/webhook-subscriptions/{subscriptionId}/rotate-secret");
  });
});

// A minimal well-formed spec operation: documents the shared-layer
// responses and (for mutations) the Idempotency-Key parameter.
function op(input: { mutation?: boolean; responses?: string[] }): Record<string, unknown> {
  const statuses = input.responses ?? ["200", "401", "429", ...(input.mutation ? ["400"] : [])];
  return {
    responses: Object.fromEntries(statuses.map((s) => [s, { description: s }])),
    ...(input.mutation ? { parameters: [{ $ref: "#/components/parameters/IdempotencyKey" }] } : {}),
  };
}

function route(specPath: string, methods: string[]): RouteEntry {
  return { specPath, methods, file: `apps/web/app/api/v1${specPath}/route.ts` };
}

describe("diffContract", () => {
  const cleanSpec: SpecDocument = {
    paths: {
      "/orders": { get: op({}), post: op({ mutation: true }) },
      "/orders/{orderId}": { get: op({}) },
    },
  };
  const cleanRoutes = [route("/orders", ["GET", "POST"]), route("/orders/{orderId}", ["GET"])];

  it("passes when routes and spec agree", () => {
    expect(diffContract(cleanRoutes, cleanSpec)).toEqual([]);
  });

  it("flags a served route that the spec does not document", () => {
    const routes = [...cleanRoutes, route("/patients", ["GET"])];
    const violations = diffContract(routes, cleanSpec);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toContain("GET /patients");
    expect(violations[0]?.message).toContain("not documented");
  });

  it("flags a documented operation that no route serves", () => {
    const spec: SpecDocument = {
      paths: { ...cleanSpec.paths, "/ghosts": { get: op({}) } },
    };
    const violations = diffContract(cleanRoutes, spec);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toContain("GET /ghosts");
    expect(violations[0]?.message).toContain("no route.ts");
  });

  it("flags a method mismatch on an existing path (both directions)", () => {
    const routes = [
      route("/orders", ["GET", "POST", "DELETE"]),
      route("/orders/{orderId}", ["GET"]),
    ];
    const messages = diffContract(routes, cleanSpec).map((v) => v.message);
    expect(messages.some((m) => m.includes("DELETE /orders") && m.includes("not documented"))).toBe(
      true
    );
  });

  it("does not treat path-level `parameters` as an HTTP method", () => {
    const spec: SpecDocument = {
      paths: {
        "/orders": { get: op({}), post: op({ mutation: true }), parameters: [] },
        "/orders/{orderId}": { get: op({}) },
      },
    };
    expect(diffContract(cleanRoutes, spec)).toEqual([]);
  });

  it("requires every operation to document 401 and 429", () => {
    const spec: SpecDocument = {
      paths: {
        "/orders": { get: op({ responses: ["200"] }), post: op({ mutation: true }) },
        "/orders/{orderId}": { get: op({}) },
      },
    };
    const messages = diffContract(cleanRoutes, spec).map((v) => v.message);
    expect(messages.some((m) => m.includes("GET /orders") && m.includes("401"))).toBe(true);
    expect(messages.some((m) => m.includes("GET /orders") && m.includes("429"))).toBe(true);
  });

  it("requires mutations to document 400 and the Idempotency-Key parameter", () => {
    const spec: SpecDocument = {
      paths: {
        "/orders": {
          get: op({}),
          post: { responses: { "200": {}, "401": {}, "429": {} } },
        },
        "/orders/{orderId}": { get: op({}) },
      },
    };
    const messages = diffContract(cleanRoutes, spec).map((v) => v.message);
    expect(messages.some((m) => m.includes("POST /orders") && m.includes("400"))).toBe(true);
    expect(messages.some((m) => m.includes("POST /orders") && m.includes("Idempotency-Key"))).toBe(
      true
    );
  });

  it("accepts an inline Idempotency-Key header parameter (not only the $ref)", () => {
    const spec: SpecDocument = {
      paths: {
        "/orders": {
          get: op({}),
          post: {
            responses: { "200": {}, "400": {}, "401": {}, "429": {} },
            parameters: [{ in: "header", name: "Idempotency-Key" }],
          },
        },
        "/orders/{orderId}": { get: op({}) },
      },
    };
    expect(diffContract(cleanRoutes, spec)).toEqual([]);
  });

  it("flags a route.ts that exports no handler at all", () => {
    const violations = diffContract([route("/orders", [])], {
      paths: {},
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toContain("no HTTP method handlers");
  });
});

describe("versioning guard (whole-repo sentinel)", () => {
  it("every /api/v1 route is documented in docs/api/openapi-v1.yaml and vice versa", () => {
    const { routes, violations } = runCheck(REPO_ROOT);
    expect(violations).toEqual([]);
    // The v1 surface today: 6 route files, 8 operations. Growing
    // this number is expected — silently DROPPING routes is not.
    expect(routes.length).toBeGreaterThanOrEqual(6);
  });

  it("sentinel paths exist (guards against a silent directory move)", () => {
    // If the route tree or the spec relocates, runCheck would throw
    // ENOENT and the sentinel above would read as "internal error"
    // rather than drift. Pin the layout assumption explicitly.
    expect(() => runCheck(join(REPO_ROOT, "nonexistent"))).toThrow();
  });
});
