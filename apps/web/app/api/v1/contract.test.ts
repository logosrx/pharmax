// WIRE-CONTRACT tests for the whole /api/v1 partner surface.
//
// `docs/api/openapi-v1.yaml` is the committed contract every clinic
// integration is built against (ADR-0032; ADR-0040 made this surface
// the PERMANENT eRx intake path). The per-route `route.test.ts`
// suites pin behavior; THIS suite pins the wire shapes: every
// response body is replayed against the spec with unknown-key
// detection in BOTH directions —
//
//   - a response field the spec does not document fails (a partner
//     could start depending on an accident), and
//   - a documented field the response does not carry fails (the spec
//     would be promising a phantom).
//
// Also locked here: the uniform `{ error: { code, message } }`
// envelope across every route and gate, the 401/403 auth envelopes,
// the 429 split (RATE_LIMITED vs QUOTA_EXCEEDED) with its
// `Retry-After` header, the Idempotency-Key header requirement on
// every mutation, and the replay wire contract (200 +
// `meta.idempotentReplay` + one-time secrets nulled). Idempotency
// INTERNALS (hashing, storage, races) are covered by the command-bus
// unit tests and packages/integration-tests — here we only lock what
// a partner can observe on the wire.
//
// Path/method parity between the route tree and the spec is enforced
// separately by scripts/check-partner-contract.ts (the
// `check:partner-contract` drift gate) and its whole-repo sentinel
// test.
//
// All fixture data is SYNTHETIC (fixed fake UUIDs, fake tracking
// numbers). No PHI travels through this suite: v1 order surfaces are
// PHI-free by construction and the prescription-intake fixtures use
// placeholder clinical text only.

import { readFileSync } from "node:fs";

import { beforeEach, describe, expect, it, vi } from "vitest";
import { parse as parseYaml } from "yaml";

const resolveApiKeyMock = vi.hoisted(() => vi.fn());
const rateLimitHitMock = vi.hoisted(() => vi.fn());
const readInOrgScopeMock = vi.hoisted(() => vi.fn());
const executeCommandMock = vi.hoisted(() => vi.fn());
const executeCommandDetailedMock = vi.hoisted(() => vi.fn());

const TEST_WEBHOOK_SECRET = "pxw_synthetic-secret-for-contract-tests-0000";

vi.mock("@pharmax/partner-api", () => ({
  resolveApiKey: resolveApiKeyMock,
  getApiKeyQuota: () => ({
    tier: "STANDARD",
    burst: { limit: 120, windowMs: 60_000 },
    daily: { limit: 50_000, windowMs: 86_400_000 },
  }),
  CreateWebhookSubscription: { name: "CreateWebhookSubscription" },
  RevokeWebhookSubscription: { name: "RevokeWebhookSubscription" },
  RotateWebhookSubscriptionSecret: { name: "RotateWebhookSubscriptionSecret" },
  generateWebhookSecret: () => TEST_WEBHOOK_SECRET,
  listWebhookEligibleEventTypes: () => ["order.status.changed", "shipment.shipped"],
}));

vi.mock("@pharmax/composition", () => ({
  createRateLimiterFromEnv: () => ({ rateLimiter: { hit: rateLimitHitMock } }),
}));

vi.mock("@pharmax/database", () => ({
  prisma: {},
  readInOrgScope: readInOrgScopeMock,
  OrderStatus: { RECEIVED: "RECEIVED", SHIPPED: "SHIPPED", CANCELLED: "CANCELLED" },
  IntakeSourceKind: { API: "API" },
  WebhookDeliveryStatus: { PENDING: "PENDING", SENT: "SENT", FAILED: "FAILED", DEAD: "DEAD" },
}));

vi.mock("@pharmax/rbac", () => ({
  PERMISSIONS: {
    ORDERS_READ: "orders.read",
    ORDERS_CREATE: "orders.create",
    PRESCRIPTIONS_CREATE: "prescriptions.create",
    WEBHOOKS_MANAGE: "webhooks.manage",
  },
}));

vi.mock("@pharmax/tenancy", () => ({
  buildTenancyContext: (input: unknown) => input,
  withTenancyContext: (_ctx: unknown, fn: () => unknown) => fn(),
}));

// Commands are dispatched through the bus; mocking both keeps the
// heavy transitive domain graph out of this route-layer suite, same
// as the per-route tests.
vi.mock("@pharmax/command-bus", () => ({
  executeCommand: executeCommandMock,
  executeCommandDetailed: executeCommandDetailedMock,
}));
vi.mock("@pharmax/orders", () => ({
  CreateOrder: { name: "CreateOrder" },
  CreatePrescription: { name: "CreatePrescription" },
}));

vi.mock("@/server/env", () => ({ env: { REDIS_URL: undefined } }));

vi.mock("@/server/logger", () => {
  const noop = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() };
  noop.child.mockReturnValue(noop);
  return { logger: noop };
});

import { errors } from "@pharmax/platform-core";

import * as orderDetailRoute from "./orders/[orderId]/route.js";
import * as ordersRoute from "./orders/route.js";
import * as prescriptionsRoute from "./prescriptions/route.js";
import * as webhookDeliveriesRoute from "./webhook-deliveries/route.js";
import * as rotateSecretRoute from "./webhook-subscriptions/[subscriptionId]/rotate-secret/route.js";
import * as webhookSubDetailRoute from "./webhook-subscriptions/[subscriptionId]/route.js";
import * as webhookSubsRoute from "./webhook-subscriptions/route.js";

// ---------------------------------------------------------------------------
// Spec loading + shape validation
// ---------------------------------------------------------------------------

type SpecNode = Record<string, unknown>;

const SPEC = parseYaml(
  readFileSync(new URL("../../../../../docs/api/openapi-v1.yaml", import.meta.url), "utf8")
) as SpecNode;

/** Follow a `#/components/...` JSON pointer inside the spec. */
function resolveRef(ref: string): SpecNode {
  if (!ref.startsWith("#/")) throw new Error(`unsupported $ref: ${ref}`);
  let node: unknown = SPEC;
  for (const segment of ref.slice(2).split("/")) {
    node = (node as SpecNode)[segment];
    if (node === undefined) throw new Error(`dangling $ref: ${ref}`);
  }
  return node as SpecNode;
}

/** Dereference `$ref` and flatten `allOf` into a single object schema. */
function deref(schema: SpecNode): SpecNode {
  if (typeof schema["$ref"] === "string") return deref(resolveRef(schema["$ref"]));
  if (Array.isArray(schema["allOf"])) {
    const merged: Record<string, unknown> = {};
    for (const part of schema["allOf"] as SpecNode[]) {
      const flat = deref(part);
      Object.assign(merged, (flat["properties"] as SpecNode | undefined) ?? {});
    }
    return { type: "object", properties: merged };
  }
  return schema;
}

/**
 * Look up the documented JSON body schema for (path, method, status).
 * Throws when the spec does not document the combination — a test
 * exercising an undocumented status is itself a contract violation.
 */
function responseSchema(specPath: string, method: string, status: number): SpecNode {
  const pathItem = (SPEC["paths"] as SpecNode)[specPath] as SpecNode | undefined;
  const operation = pathItem?.[method.toLowerCase()] as SpecNode | undefined;
  const responses = operation?.["responses"] as SpecNode | undefined;
  let response = responses?.[String(status)] as SpecNode | undefined;
  if (response === undefined) {
    throw new Error(`spec does not document ${method} ${specPath} → ${status}`);
  }
  if (typeof response["$ref"] === "string") response = resolveRef(response["$ref"]);
  const content = response["content"] as SpecNode | undefined;
  const media = content?.["application/json"] as SpecNode | undefined;
  const schema = media?.["schema"] as SpecNode | undefined;
  if (schema === undefined) {
    throw new Error(`spec documents no JSON schema for ${method} ${specPath} → ${status}`);
  }
  return schema;
}

function schemaTypes(schema: SpecNode): ReadonlyArray<string> | undefined {
  const t = schema["type"];
  if (t === undefined) return undefined;
  return Array.isArray(t) ? (t as string[]) : [t as string];
}

/**
 * Structural validator for the subset of JSON Schema this spec uses
 * (type / type arrays, object properties, array items, enum). The
 * load-bearing rule: OBJECT KEYS MUST MATCH THE DOCUMENTED
 * PROPERTIES EXACTLY, both directions. Formats are not re-validated
 * (format drift is not shape drift).
 */
function collectShapeProblems(
  value: unknown,
  rawSchema: SpecNode,
  pointer: string,
  problems: string[]
): void {
  const schema = deref(rawSchema);
  const types = schemaTypes(schema);

  if (Array.isArray(schema["oneOf"])) {
    const branchProblems = (schema["oneOf"] as SpecNode[]).map((branch) => {
      const collected: string[] = [];
      collectShapeProblems(value, branch, pointer, collected);
      return collected;
    });
    if (!branchProblems.some((collected) => collected.length === 0)) {
      problems.push(
        `${pointer}: matches no oneOf branch — ` +
          branchProblems.map((collected, i) => `[branch ${i}: ${collected.join("; ")}]`).join(" ")
      );
    }
    return;
  }

  if (Array.isArray(schema["enum"]) && !(schema["enum"] as unknown[]).includes(value)) {
    problems.push(`${pointer}: value ${JSON.stringify(value)} not in documented enum`);
    return;
  }

  if (value === null) {
    if (types !== undefined && !types.includes("null")) {
      problems.push(`${pointer}: null but spec documents type ${types.join("|")}`);
    }
    return;
  }

  if (Array.isArray(value)) {
    if (types !== undefined && !types.includes("array")) {
      problems.push(`${pointer}: array but spec documents type ${types.join("|")}`);
      return;
    }
    const items = schema["items"] as SpecNode | undefined;
    if (items !== undefined) {
      value.forEach((element, index) =>
        collectShapeProblems(element, items, `${pointer}[${index}]`, problems)
      );
    }
    return;
  }

  if (typeof value === "object") {
    if (types !== undefined && !types.includes("object")) {
      problems.push(`${pointer}: object but spec documents type ${types.join("|")}`);
      return;
    }
    const properties = (schema["properties"] as Record<string, SpecNode> | undefined) ?? {};
    const actualKeys = Object.keys(value as Record<string, unknown>);
    for (const key of actualKeys) {
      if (!(key in properties)) {
        problems.push(`${pointer}.${key}: present on the wire but NOT documented in the spec`);
      }
    }
    for (const key of Object.keys(properties)) {
      if (!actualKeys.includes(key)) {
        problems.push(`${pointer}.${key}: documented in the spec but ABSENT from the response`);
      }
    }
    for (const key of actualKeys) {
      const propSchema = properties[key];
      if (propSchema !== undefined) {
        collectShapeProblems(
          (value as Record<string, unknown>)[key],
          propSchema,
          `${pointer}.${key}`,
          problems
        );
      }
    }
    return;
  }

  if (types === undefined) return;
  const primitive =
    typeof value === "number"
      ? Number.isInteger(value)
        ? ["integer", "number"]
        : ["number"]
      : [typeof value];
  if (!primitive.some((p) => types.includes(p))) {
    problems.push(
      `${pointer}: ${typeof value} ${JSON.stringify(value)} but spec documents type ${types.join("|")}`
    );
  }
}

/** Assert a real response body matches the documented schema exactly. */
async function expectContract(
  res: Response,
  specPath: string,
  method: string,
  status: number
): Promise<Record<string, unknown>> {
  expect(res.status).toBe(status);
  const body = (await res.json()) as Record<string, unknown>;
  const problems: string[] = [];
  collectShapeProblems(body, responseSchema(specPath, method, status), "$", problems);
  expect(problems).toEqual([]);
  return body;
}

// ---------------------------------------------------------------------------
// Fixtures — ALL SYNTHETIC. Fixed fake UUIDs; no real identifiers.
// ---------------------------------------------------------------------------

const UUID = {
  clinic: "aaaaaaaa-bbbb-4ccc-addd-eeeeeeee0001",
  site: "aaaaaaaa-bbbb-4ccc-addd-eeeeeeee0002",
  patient: "aaaaaaaa-bbbb-4ccc-addd-eeeeeeee0003",
  prescription: "aaaaaaaa-bbbb-4ccc-addd-eeeeeeee0004",
  provider: "aaaaaaaa-bbbb-4ccc-addd-eeeeeeee0005",
  order: "aaaaaaaa-bbbb-4ccc-addd-eeeeeeee0006",
  orderLine: "aaaaaaaa-bbbb-4ccc-addd-eeeeeeee0007",
  shipment: "aaaaaaaa-bbbb-4ccc-addd-eeeeeeee0008",
  subscription: "aaaaaaaa-bbbb-4ccc-addd-eeeeeeee0009",
  delivery: "aaaaaaaa-bbbb-4ccc-addd-eeeeeeee000a",
} as const;

const ISO = "2026-08-01T12:00:00.000Z";

const ALL_SCOPES = ["orders.read", "orders.create", "prescriptions.create", "webhooks.manage"];

const RESOLVED_KEY = {
  apiKeyId: "key-1",
  organizationId: "org-1",
  name: "Test Clinic integration",
  tokenPrefix: "pxk_test",
  scopes: ALL_SCOPES,
  quotaTier: "STANDARD",
  createdByUserId: "user-1",
} as const;

const ORDER_SUMMARY_ROW = {
  id: UUID.order,
  externalOrderNumber: "CL-1001",
  clinicId: UUID.clinic,
  siteId: UUID.site,
  patientId: UUID.patient,
  currentStatus: "RECEIVED",
  priority: "NORMAL",
  version: 2,
  slaDeadlineAt: ISO,
  receivedAt: ISO,
  shippedAt: null,
  createdAt: ISO,
  updatedAt: ISO,
} as const;

const ORDER_DETAIL_ROW = {
  ...ORDER_SUMMARY_ROW,
  orderLines: [
    {
      id: UUID.orderLine,
      prescriptionId: UUID.prescription,
      quantityToFill: "30",
      daysSupplyToFill: 30,
      lineStatus: "PENDING",
    },
  ],
  shipments: [
    {
      id: UUID.shipment,
      carrier: "UPS",
      serviceLevel: "GROUND",
      trackingNumber: "1ZTEST0000000000",
      status: "IN_TRANSIT",
      createdAt: ISO,
    },
  ],
} as const;

const ORDER_CREATED_OUTPUT = {
  orderId: UUID.order,
  orderLineIds: [UUID.orderLine],
  currentStatus: "RECEIVED",
  version: 0,
} as const;

const PRESCRIPTION_CREATED_OUTPUT = {
  prescriptionId: UUID.prescription,
  rxNumber: "RX-1000001",
  controlledSubstanceSchedule: "NON_CONTROLLED",
  expiresAt: "2027-08-01",
} as const;

const SUBSCRIPTION_ROW = {
  id: UUID.subscription,
  url: "https://partner.example/webhooks",
  eventTypes: ["order.status.changed"],
  description: null,
  status: "ACTIVE",
  disabledAt: null,
  createdAt: ISO,
} as const;

const SUBSCRIPTION_CREATED_OUTPUT = {
  subscriptionId: UUID.subscription,
  url: "https://partner.example/webhooks",
  eventTypes: ["order.status.changed"],
  status: "ACTIVE",
} as const;

const DELIVERY_ROW = {
  id: UUID.delivery,
  subscriptionId: UUID.subscription,
  eventType: "order.status.changed",
  status: "SENT",
  attempts: 1,
  lastError: null,
  responseStatus: 200,
  nextAttemptAt: null,
  deliveredAt: ISO,
  createdAt: ISO,
} as const;

const ORDER_INTAKE_BODY = {
  clinicId: UUID.clinic,
  siteId: UUID.site,
  patientId: UUID.patient,
  lines: [{ prescriptionId: UUID.prescription, quantityToFill: 30, daysSupplyToFill: 30 }],
} as const;

// Synthetic transcription — placeholder clinical text, not PHI.
const PRESCRIPTION_INTAKE_BODY = {
  clinicId: UUID.clinic,
  patientId: UUID.patient,
  providerId: UUID.provider,
  drugNdc: "00000-0000-00",
  drugName: "Test Drug 10mg Tablet",
  quantityAuthorized: "30",
  daysSupply: 30,
  refillsAuthorized: 0,
  originalDateWritten: "2026-08-01",
  sig: "Take one tablet by mouth daily (synthetic test sig).",
} as const;

// ---------------------------------------------------------------------------
// Handler invocation plumbing
// ---------------------------------------------------------------------------

interface RequestOverrides {
  readonly auth?: string | null;
  readonly idempotencyKey?: string;
  readonly body?: unknown;
  readonly rawBody?: string;
}

interface OperationCase {
  /** Spec path template, e.g. `/orders/{orderId}`. */
  readonly specPath: string;
  readonly method: "GET" | "POST" | "DELETE";
  /** Concrete request URL for the template. */
  readonly url: string;
  readonly mutation: boolean;
  /** Scope the operation requires (for the 403 case). */
  readonly scope: string;
  readonly invoke: (req: Request) => Promise<Response>;
  /** Arrange mocks so the operation would succeed past the gates. */
  readonly arrangeSuccess: () => void;
}

function buildRequest(op: OperationCase, overrides: RequestOverrides = {}): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (overrides.auth !== null) headers["authorization"] = overrides.auth ?? "Bearer pxk_test";
  if (overrides.idempotencyKey !== undefined) {
    headers["idempotency-key"] = overrides.idempotencyKey;
  }
  const init: RequestInit = { method: op.method, headers };
  if (op.method !== "GET") {
    init.body = overrides.rawBody ?? JSON.stringify(overrides.body ?? {});
  }
  return new Request(op.url, init);
}

function stubOrgReads(tables: Record<string, unknown>): void {
  readInOrgScopeMock.mockImplementation(
    async (_org: string, fn: (tx: unknown) => Promise<unknown>) => fn(tables)
  );
}

const withParams =
  <K extends string>(key: K, value: string) =>
  (handler: (req: Request, ctx: { params: Promise<Record<K, string>> }) => Promise<Response>) =>
  (req: Request) =>
    handler(req, { params: Promise.resolve({ [key]: value } as Record<K, string>) });

const OPERATIONS: ReadonlyArray<OperationCase> = [
  {
    specPath: "/orders",
    method: "GET",
    url: "http://localhost/api/v1/orders",
    mutation: false,
    scope: "orders.read",
    invoke: (req) => ordersRoute.GET(req),
    arrangeSuccess: () => stubOrgReads({ order: { findMany: vi.fn().mockResolvedValue([]) } }),
  },
  {
    specPath: "/orders",
    method: "POST",
    url: "http://localhost/api/v1/orders",
    mutation: true,
    scope: "orders.create",
    invoke: (req) => ordersRoute.POST(req),
    arrangeSuccess: () =>
      executeCommandDetailedMock.mockResolvedValue({
        output: ORDER_CREATED_OUTPUT,
        replayed: false,
      }),
  },
  {
    specPath: "/orders/{orderId}",
    method: "GET",
    url: `http://localhost/api/v1/orders/${UUID.order}`,
    mutation: false,
    scope: "orders.read",
    invoke: withParams("orderId", UUID.order)(orderDetailRoute.GET),
    arrangeSuccess: () =>
      stubOrgReads({ order: { findFirst: vi.fn().mockResolvedValue(ORDER_DETAIL_ROW) } }),
  },
  {
    specPath: "/prescriptions",
    method: "POST",
    url: "http://localhost/api/v1/prescriptions",
    mutation: true,
    scope: "prescriptions.create",
    invoke: (req) => prescriptionsRoute.POST(req),
    arrangeSuccess: () =>
      executeCommandDetailedMock.mockResolvedValue({
        output: PRESCRIPTION_CREATED_OUTPUT,
        replayed: false,
      }),
  },
  {
    specPath: "/webhook-subscriptions",
    method: "GET",
    url: "http://localhost/api/v1/webhook-subscriptions",
    mutation: false,
    scope: "webhooks.manage",
    invoke: (req) => webhookSubsRoute.GET(req),
    arrangeSuccess: () =>
      stubOrgReads({ webhookSubscription: { findMany: vi.fn().mockResolvedValue([]) } }),
  },
  {
    specPath: "/webhook-subscriptions",
    method: "POST",
    url: "http://localhost/api/v1/webhook-subscriptions",
    mutation: true,
    scope: "webhooks.manage",
    invoke: (req) => webhookSubsRoute.POST(req),
    arrangeSuccess: () =>
      executeCommandDetailedMock.mockResolvedValue({
        output: SUBSCRIPTION_CREATED_OUTPUT,
        replayed: false,
      }),
  },
  {
    specPath: "/webhook-subscriptions/{subscriptionId}",
    method: "DELETE",
    url: `http://localhost/api/v1/webhook-subscriptions/${UUID.subscription}`,
    mutation: true,
    scope: "webhooks.manage",
    invoke: withParams("subscriptionId", UUID.subscription)(webhookSubDetailRoute.DELETE),
    arrangeSuccess: () =>
      executeCommandMock.mockResolvedValue({
        subscriptionId: UUID.subscription,
        url: SUBSCRIPTION_ROW.url,
        disabledAt: ISO,
      }),
  },
  {
    specPath: "/webhook-subscriptions/{subscriptionId}/rotate-secret",
    method: "POST",
    url: `http://localhost/api/v1/webhook-subscriptions/${UUID.subscription}/rotate-secret`,
    mutation: true,
    scope: "webhooks.manage",
    invoke: withParams("subscriptionId", UUID.subscription)(rotateSecretRoute.POST),
    arrangeSuccess: () =>
      executeCommandDetailedMock.mockResolvedValue({
        output: { subscriptionId: UUID.subscription, url: SUBSCRIPTION_ROW.url, rotatedAt: ISO },
        replayed: false,
      }),
  },
  {
    specPath: "/webhook-deliveries",
    method: "GET",
    url: "http://localhost/api/v1/webhook-deliveries",
    mutation: false,
    scope: "webhooks.manage",
    invoke: (req) => webhookDeliveriesRoute.GET(req),
    arrangeSuccess: () =>
      stubOrgReads({ webhookDelivery: { findMany: vi.fn().mockResolvedValue([]) } }),
  },
];

beforeEach(() => {
  resolveApiKeyMock.mockReset().mockResolvedValue({ ok: true, key: RESOLVED_KEY });
  rateLimitHitMock.mockReset().mockResolvedValue({ allowed: true });
  readInOrgScopeMock.mockReset();
  executeCommandMock.mockReset();
  executeCommandDetailedMock.mockReset();
});

// ---------------------------------------------------------------------------
// Harness self-test: prove the shape checker actually bites.
// ---------------------------------------------------------------------------

describe("contract harness", () => {
  const errorSchema = { $ref: "#/components/schemas/Error" };

  it("flags a response field the spec does not document", () => {
    const problems: string[] = [];
    collectShapeProblems(
      { error: { code: "X", message: "y", debugInfo: "leak" } },
      errorSchema,
      "$",
      problems
    );
    expect(problems.some((p) => p.includes("debugInfo") && p.includes("NOT documented"))).toBe(
      true
    );
  });

  it("flags a documented field the response does not carry", () => {
    const problems: string[] = [];
    collectShapeProblems({ error: { code: "X" } }, errorSchema, "$", problems);
    expect(problems.some((p) => p.includes("message") && p.includes("ABSENT"))).toBe(true);
  });

  it("flags a type mismatch and an enum violation", () => {
    const problems: string[] = [];
    collectShapeProblems({ error: { code: 42, message: "y" } }, errorSchema, "$", problems);
    expect(problems.length).toBeGreaterThan(0);

    const enumProblems: string[] = [];
    collectShapeProblems(
      "TELEPORTED",
      { $ref: "#/components/schemas/OrderStatus" },
      "$",
      enumProblems
    );
    expect(enumProblems.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Cross-route gate contracts: one envelope, every route.
// ---------------------------------------------------------------------------

describe.each(OPERATIONS)("$method $specPath — shared gate contract", (op) => {
  const idem = { idempotencyKey: "contract-test-key-1" };

  it("401 without a bearer token: documented envelope, code UNAUTHENTICATED", async () => {
    const res = await op.invoke(buildRequest(op, { auth: null, ...idem }));
    const body = await expectContract(res, op.specPath, op.method, 401);
    expect((body["error"] as Record<string, unknown>)["code"]).toBe("UNAUTHENTICATED");
  });

  it("401 for an unknown/revoked key: same envelope, indistinguishable", async () => {
    resolveApiKeyMock.mockResolvedValue({ ok: false });
    const res = await op.invoke(buildRequest(op, idem));
    const body = await expectContract(res, op.specPath, op.method, 401);
    expect((body["error"] as Record<string, unknown>)["code"]).toBe("UNAUTHENTICATED");
  });

  it("403 without the required scope: documented envelope, code SCOPE_DENIED", async () => {
    resolveApiKeyMock.mockResolvedValue({
      ok: true,
      key: { ...RESOLVED_KEY, scopes: ALL_SCOPES.filter((s) => s !== op.scope) },
    });
    const res = await op.invoke(buildRequest(op, idem));
    const body = await expectContract(res, op.specPath, op.method, 403);
    expect((body["error"] as Record<string, unknown>)["code"]).toBe("SCOPE_DENIED");
  });

  it("429 burst: RATE_LIMITED with an integer Retry-After header", async () => {
    rateLimitHitMock.mockResolvedValue({ allowed: false, retryAfterMs: 30_000 });
    const res = await op.invoke(buildRequest(op, idem));
    const body = await expectContract(res, op.specPath, op.method, 429);
    expect((body["error"] as Record<string, unknown>)["code"]).toBe("RATE_LIMITED");
    expect(res.headers.get("retry-after")).toBe("30");
  });

  it("429 daily quota: QUOTA_EXCEEDED with an integer Retry-After header", async () => {
    rateLimitHitMock
      .mockResolvedValueOnce({ allowed: true })
      .mockResolvedValueOnce({ allowed: false, retryAfterMs: 3_600_000 });
    const res = await op.invoke(buildRequest(op, idem));
    const body = await expectContract(res, op.specPath, op.method, 429);
    expect((body["error"] as Record<string, unknown>)["code"]).toBe("QUOTA_EXCEEDED");
    expect(res.headers.get("retry-after")).toBe("3600");
  });
});

const MUTATIONS = OPERATIONS.filter((op) => op.mutation);

describe.each(MUTATIONS)("$method $specPath — Idempotency-Key header contract", (op) => {
  it("400 IDEMPOTENCY_KEY_REQUIRED when the header is missing", async () => {
    op.arrangeSuccess();
    const res = await op.invoke(buildRequest(op));
    const body = await expectContract(res, op.specPath, op.method, 400);
    expect((body["error"] as Record<string, unknown>)["code"]).toBe("IDEMPOTENCY_KEY_REQUIRED");
    expect(executeCommandMock).not.toHaveBeenCalled();
    expect(executeCommandDetailedMock).not.toHaveBeenCalled();
  });

  it("400 IDEMPOTENCY_KEY_REQUIRED when the header is shorter than 8 chars", async () => {
    op.arrangeSuccess();
    const res = await op.invoke(buildRequest(op, { idempotencyKey: "short" }));
    const body = await expectContract(res, op.specPath, op.method, 400);
    expect((body["error"] as Record<string, unknown>)["code"]).toBe("IDEMPOTENCY_KEY_REQUIRED");
  });
});

// ---------------------------------------------------------------------------
// Route-specific success + error shapes
// ---------------------------------------------------------------------------

describe("GET /orders", () => {
  it("200: page shape with pagination (hasMore page)", async () => {
    const secondRow = { ...ORDER_SUMMARY_ROW, id: UUID.orderLine, externalOrderNumber: null };
    stubOrgReads({
      order: { findMany: vi.fn().mockResolvedValue([ORDER_SUMMARY_ROW, secondRow]) },
    });
    const res = await ordersRoute.GET(
      new Request("http://localhost/api/v1/orders?limit=1", {
        headers: { authorization: "Bearer pxk_test" },
      })
    );
    const body = await expectContract(res, "/orders", "GET", 200);
    const pagination = body["pagination"] as Record<string, unknown>;
    expect(pagination["hasMore"]).toBe(true);
    expect(pagination["nextCursor"]).toBe(UUID.order);
  });

  it("200: last page has nextCursor null (documented nullable)", async () => {
    stubOrgReads({ order: { findMany: vi.fn().mockResolvedValue([ORDER_SUMMARY_ROW]) } });
    const res = await ordersRoute.GET(
      new Request("http://localhost/api/v1/orders", {
        headers: { authorization: "Bearer pxk_test" },
      })
    );
    const body = await expectContract(res, "/orders", "GET", 200);
    expect((body["pagination"] as Record<string, unknown>)["nextCursor"]).toBeNull();
  });

  it("400: unknown status filter uses the documented error envelope", async () => {
    const res = await ordersRoute.GET(
      new Request("http://localhost/api/v1/orders?status=TELEPORTED", {
        headers: { authorization: "Bearer pxk_test" },
      })
    );
    const body = await expectContract(res, "/orders", "GET", 400);
    expect((body["error"] as Record<string, unknown>)["code"]).toBe("INVALID_STATUS");
  });
});

describe("POST /orders (intake)", () => {
  const op = OPERATIONS.find((o) => o.specPath === "/orders" && o.method === "POST")!;
  const send = (overrides: RequestOverrides = {}) =>
    op.invoke(
      buildRequest(op, { body: ORDER_INTAKE_BODY, idempotencyKey: "intake-key-1", ...overrides })
    );

  it("201: OrderCreated envelope, exact field set", async () => {
    executeCommandDetailedMock.mockResolvedValue({ output: ORDER_CREATED_OUTPUT, replayed: false });
    const body = await expectContract(await send(), "/orders", "POST", 201);
    expect(body["meta"]).toBeUndefined();
  });

  it("200 replay: same body under meta.idempotentReplay — no duplicate", async () => {
    executeCommandDetailedMock.mockResolvedValue({ output: ORDER_CREATED_OUTPUT, replayed: true });
    const body = await expectContract(await send(), "/orders", "POST", 200);
    expect(body["meta"]).toEqual({ idempotentReplay: true });
  });

  it("400 INVALID_JSON for a malformed body", async () => {
    const res = await send({ rawBody: "{nope" });
    const body = await expectContract(res, "/orders", "POST", 400);
    expect((body["error"] as Record<string, unknown>)["code"]).toBe("INVALID_JSON");
  });

  it("400 INTAKE_SOURCE_NOT_SETTABLE when the client claims intakeSourceKind", async () => {
    const res = await send({ body: { ...ORDER_INTAKE_BODY, intakeSourceKind: "MANUAL" } });
    const body = await expectContract(res, "/orders", "POST", 400);
    expect((body["error"] as Record<string, unknown>)["code"]).toBe("INTAKE_SOURCE_NOT_SETTABLE");
  });

  it("404 envelope for a missing reference (NotFoundError class)", async () => {
    executeCommandDetailedMock.mockRejectedValue(
      new errors.NotFoundError({ code: "ORDER_PATIENT_NOT_FOUND", message: "Patient not found." })
    );
    const body = await expectContract(await send(), "/orders", "POST", 404);
    expect((body["error"] as Record<string, unknown>)["code"]).toBe("ORDER_PATIENT_NOT_FOUND");
  });

  it("409 envelope for a state race (ConflictError class)", async () => {
    executeCommandDetailedMock.mockRejectedValue(
      new errors.ConflictError({ code: "COMMAND_IN_FLIGHT", message: "Still executing." })
    );
    const body = await expectContract(await send(), "/orders", "POST", 409);
    expect((body["error"] as Record<string, unknown>)["code"]).toBe("COMMAND_IN_FLIGHT");
  });

  it("409 IDEMPOTENCY WIRE CONTRACT: same key + different body is a documented conflict", async () => {
    executeCommandDetailedMock.mockRejectedValue(
      new errors.ConflictError({
        code: "COMMAND_IDEMPOTENCY_PAYLOAD_MISMATCH",
        message: "Idempotency key reused with a different payload.",
      })
    );
    const body = await expectContract(await send(), "/orders", "POST", 409);
    expect((body["error"] as Record<string, unknown>)["code"]).toBe(
      "COMMAND_IDEMPOTENCY_PAYLOAD_MISMATCH"
    );
  });

  it("422 envelope for a domain refusal (InvariantViolationError class)", async () => {
    executeCommandDetailedMock.mockRejectedValue(
      new errors.InvariantViolationError({
        code: "ORDER_PRESCRIPTION_NOT_FILLABLE",
        message: "Prescription cannot be filled.",
      })
    );
    const body = await expectContract(await send(), "/orders", "POST", 422);
    expect((body["error"] as Record<string, unknown>)["code"]).toBe(
      "ORDER_PRESCRIPTION_NOT_FILLABLE"
    );
  });

  it("500 envelope: typed code, generic message (no internal details)", async () => {
    executeCommandDetailedMock.mockRejectedValue(
      new errors.InternalError({
        code: "ORDER_INTAKE_BUCKET_NOT_CONFIGURED",
        message: "No INBOX bucket is provisioned for org org-1.",
      })
    );
    const body = await expectContract(await send(), "/orders", "POST", 500);
    const error = body["error"] as Record<string, unknown>;
    expect(error["code"]).toBe("ORDER_INTAKE_BUCKET_NOT_CONFIGURED");
    expect(error["message"]).not.toContain("org-1");
  });
});

describe("GET /orders/{orderId}", () => {
  const op = OPERATIONS.find((o) => o.specPath === "/orders/{orderId}")!;

  it("200: OrderDetail with orderLines + shipments, exact field set", async () => {
    op.arrangeSuccess();
    const res = await op.invoke(buildRequest(op));
    await expectContract(res, "/orders/{orderId}", "GET", 200);
  });

  it("400 INVALID_ORDER_ID for a non-UUID path param", async () => {
    const res = await withParams("orderId", "not-a-uuid")(orderDetailRoute.GET)(
      new Request("http://localhost/api/v1/orders/not-a-uuid", {
        headers: { authorization: "Bearer pxk_test" },
      })
    );
    const body = await expectContract(res, "/orders/{orderId}", "GET", 400);
    expect((body["error"] as Record<string, unknown>)["code"]).toBe("INVALID_ORDER_ID");
  });

  it("404 ORDER_NOT_FOUND for an order outside the key's org", async () => {
    stubOrgReads({ order: { findFirst: vi.fn().mockResolvedValue(null) } });
    const res = await op.invoke(buildRequest(op));
    const body = await expectContract(res, "/orders/{orderId}", "GET", 404);
    expect((body["error"] as Record<string, unknown>)["code"]).toBe("ORDER_NOT_FOUND");
  });
});

describe("POST /prescriptions (intake)", () => {
  const op = OPERATIONS.find((o) => o.specPath === "/prescriptions")!;
  const send = (overrides: RequestOverrides = {}) =>
    op.invoke(
      buildRequest(op, {
        body: PRESCRIPTION_INTAKE_BODY,
        idempotencyKey: "rx-key-0001",
        ...overrides,
      })
    );

  it("201: PrescriptionCreated envelope, exact field set", async () => {
    executeCommandDetailedMock.mockResolvedValue({
      output: PRESCRIPTION_CREATED_OUTPUT,
      replayed: false,
    });
    const body = await expectContract(await send(), "/prescriptions", "POST", 201);
    expect(body["meta"]).toBeUndefined();
  });

  it("200 replay: meta.idempotentReplay true", async () => {
    executeCommandDetailedMock.mockResolvedValue({
      output: PRESCRIPTION_CREATED_OUTPUT,
      replayed: true,
    });
    const body = await expectContract(await send(), "/prescriptions", "POST", 200);
    expect(body["meta"]).toEqual({ idempotentReplay: true });
  });

  it("400 INVALID_JSON for a malformed body", async () => {
    const res = await send({ rawBody: "{nope" });
    const body = await expectContract(res, "/prescriptions", "POST", 400);
    expect((body["error"] as Record<string, unknown>)["code"]).toBe("INVALID_JSON");
  });

  it("409 RX_NUMBER_COLLISION is the documented retryable conflict", async () => {
    executeCommandDetailedMock.mockRejectedValue(
      new errors.ConflictError({ code: "RX_NUMBER_COLLISION", message: "Rx number was taken." })
    );
    const body = await expectContract(await send(), "/prescriptions", "POST", 409);
    expect((body["error"] as Record<string, unknown>)["code"]).toBe("RX_NUMBER_COLLISION");
  });

  it("422 envelope for a regulatory refusal", async () => {
    executeCommandDetailedMock.mockRejectedValue(
      new errors.InvariantViolationError({
        code: "RX_REFILLS_EXCEED_SCHEDULE_LIMIT",
        message: "Schedule II authorizes no refills.",
      })
    );
    const body = await expectContract(await send(), "/prescriptions", "POST", 422);
    expect((body["error"] as Record<string, unknown>)["code"]).toBe(
      "RX_REFILLS_EXCEED_SCHEDULE_LIMIT"
    );
  });

  it("500 envelope: typed code, generic message", async () => {
    executeCommandDetailedMock.mockRejectedValue(
      new errors.InternalError({
        code: "RX_NUMBER_ALLOCATION_FAILED",
        message: "Sequence allocator raised: connection reset by peer.",
      })
    );
    const body = await expectContract(await send(), "/prescriptions", "POST", 500);
    const error = body["error"] as Record<string, unknown>;
    expect(error["code"]).toBe("RX_NUMBER_ALLOCATION_FAILED");
    expect(error["message"]).not.toContain("connection reset");
  });
});

describe("GET /webhook-subscriptions", () => {
  it("200: subscriptions + eligibleEventTypes, secret NEVER present", async () => {
    stubOrgReads({
      webhookSubscription: { findMany: vi.fn().mockResolvedValue([SUBSCRIPTION_ROW]) },
    });
    const res = await webhookSubsRoute.GET(
      new Request("http://localhost/api/v1/webhook-subscriptions", {
        headers: { authorization: "Bearer pxk_test" },
      })
    );
    const body = await expectContract(res, "/webhook-subscriptions", "GET", 200);
    const rows = body["data"] as Array<Record<string, unknown>>;
    expect(rows[0] !== undefined && "secret" in rows[0]).toBe(false);
  });
});

describe("POST /webhook-subscriptions", () => {
  const op = OPERATIONS.find(
    (o) => o.specPath === "/webhook-subscriptions" && o.method === "POST"
  )!;
  const send = () =>
    op.invoke(
      buildRequest(op, {
        body: { url: "https://partner.example/webhooks", eventTypes: ["order.status.changed"] },
        idempotencyKey: "sub-key-0001",
      })
    );

  it("201: created envelope carries the one-time secret as a string", async () => {
    executeCommandDetailedMock.mockResolvedValue({
      output: SUBSCRIPTION_CREATED_OUTPUT,
      replayed: false,
    });
    const body = await expectContract(await send(), "/webhook-subscriptions", "POST", 201);
    expect((body["data"] as Record<string, unknown>)["secret"]).toBe(TEST_WEBHOOK_SECRET);
  });

  it("200 replay: secret is null (never re-disclosed), meta flag set", async () => {
    executeCommandDetailedMock.mockResolvedValue({
      output: SUBSCRIPTION_CREATED_OUTPUT,
      replayed: true,
    });
    const body = await expectContract(await send(), "/webhook-subscriptions", "POST", 200);
    expect((body["data"] as Record<string, unknown>)["secret"]).toBeNull();
    expect(body["meta"]).toEqual({ idempotentReplay: true });
  });
});

describe("DELETE /webhook-subscriptions/{subscriptionId}", () => {
  const op = OPERATIONS.find((o) => o.specPath === "/webhook-subscriptions/{subscriptionId}")!;

  it("200: revocation envelope (subscriptionId, url, disabledAt — current wire shape)", async () => {
    op.arrangeSuccess();
    const res = await op.invoke(buildRequest(op, { idempotencyKey: "revoke-key-01" }));
    await expectContract(res, "/webhook-subscriptions/{subscriptionId}", "DELETE", 200);
  });

  it("400 INVALID_SUBSCRIPTION_ID for a non-UUID path param", async () => {
    const res = await withParams("subscriptionId", "nope")(webhookSubDetailRoute.DELETE)(
      new Request("http://localhost/api/v1/webhook-subscriptions/nope", {
        method: "DELETE",
        headers: { authorization: "Bearer pxk_test", "idempotency-key": "revoke-key-01" },
      })
    );
    const body = await expectContract(
      res,
      "/webhook-subscriptions/{subscriptionId}",
      "DELETE",
      400
    );
    expect((body["error"] as Record<string, unknown>)["code"]).toBe("INVALID_SUBSCRIPTION_ID");
  });

  it("404 envelope when the subscription does not exist in this org", async () => {
    executeCommandMock.mockRejectedValue(
      new errors.NotFoundError({
        code: "WEBHOOK_SUBSCRIPTION_NOT_FOUND",
        message: "Subscription not found.",
      })
    );
    const res = await op.invoke(buildRequest(op, { idempotencyKey: "revoke-key-01" }));
    const body = await expectContract(
      res,
      "/webhook-subscriptions/{subscriptionId}",
      "DELETE",
      404
    );
    expect((body["error"] as Record<string, unknown>)["code"]).toBe(
      "WEBHOOK_SUBSCRIPTION_NOT_FOUND"
    );
  });
});

describe("POST /webhook-subscriptions/{subscriptionId}/rotate-secret", () => {
  const op = OPERATIONS.find((o) => o.specPath.endsWith("/rotate-secret"))!;
  const SPEC_PATH = "/webhook-subscriptions/{subscriptionId}/rotate-secret";
  const send = () => op.invoke(buildRequest(op, { idempotencyKey: "rotate-key-01" }));

  it("200 first rotation: the NEW secret is a string, no replay meta", async () => {
    op.arrangeSuccess();
    const body = await expectContract(await send(), SPEC_PATH, "POST", 200);
    expect((body["data"] as Record<string, unknown>)["secret"]).toBe(TEST_WEBHOOK_SECRET);
    expect(body["meta"]).toBeUndefined();
  });

  it("200 replay: secret null (stored secret stays active), meta flag set", async () => {
    executeCommandDetailedMock.mockResolvedValue({
      output: { subscriptionId: UUID.subscription, url: SUBSCRIPTION_ROW.url, rotatedAt: ISO },
      replayed: true,
    });
    const body = await expectContract(await send(), SPEC_PATH, "POST", 200);
    expect((body["data"] as Record<string, unknown>)["secret"]).toBeNull();
    expect(body["meta"]).toEqual({ idempotentReplay: true });
  });

  it("404 envelope when the subscription does not exist", async () => {
    executeCommandDetailedMock.mockRejectedValue(
      new errors.NotFoundError({
        code: "WEBHOOK_SUBSCRIPTION_NOT_FOUND",
        message: "Subscription not found.",
      })
    );
    const body = await expectContract(await send(), SPEC_PATH, "POST", 404);
    expect((body["error"] as Record<string, unknown>)["code"]).toBe(
      "WEBHOOK_SUBSCRIPTION_NOT_FOUND"
    );
  });
});

describe("GET /webhook-deliveries", () => {
  it("200: delivery ledger page, exact field set (no payload snapshots)", async () => {
    stubOrgReads({ webhookDelivery: { findMany: vi.fn().mockResolvedValue([DELIVERY_ROW]) } });
    const res = await webhookDeliveriesRoute.GET(
      new Request("http://localhost/api/v1/webhook-deliveries", {
        headers: { authorization: "Bearer pxk_test" },
      })
    );
    const body = await expectContract(res, "/webhook-deliveries", "GET", 200);
    const rows = body["data"] as Array<Record<string, unknown>>;
    expect(rows[0] !== undefined && "payload" in rows[0]).toBe(false);
  });

  it("400 INVALID_STATUS for an unknown delivery status filter", async () => {
    const res = await webhookDeliveriesRoute.GET(
      new Request("http://localhost/api/v1/webhook-deliveries?status=LOST", {
        headers: { authorization: "Bearer pxk_test" },
      })
    );
    const body = await expectContract(res, "/webhook-deliveries", "GET", 400);
    expect((body["error"] as Record<string, unknown>)["code"]).toBe("INVALID_STATUS");
  });
});
