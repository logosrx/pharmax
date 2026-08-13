// Pino logger tests use an in-memory stream destination so the test
// reads exactly what would have gone to stdout. Each line is one
// log event in JSON.

import { describe, expect, it } from "vitest";

import { createPinoLogger } from "./pino-logger.js";

interface CapturedLog {
  readonly level: number;
  readonly time: string;
  readonly service: string;
  readonly message: string;
  readonly [key: string]: unknown;
}

interface Capture {
  readonly stream: { write(s: string): void };
  readonly lines: () => CapturedLog[];
}

function makeCapture(): Capture {
  const chunks: string[] = [];
  return {
    stream: {
      write(s: string): void {
        chunks.push(s);
      },
    },
    lines(): CapturedLog[] {
      return chunks
        .join("")
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as CapturedLog);
    },
  };
}

describe("createPinoLogger", () => {
  it("stamps every line with the configured service", () => {
    const capture = makeCapture();
    const log = createPinoLogger({
      service: "pharmacy-test",
      destination: capture.stream,
    });

    log.info("hello");
    log.error("oops");

    const lines = capture.lines();
    expect(lines).toHaveLength(2);
    expect(lines.every((l) => l.service === "pharmacy-test")).toBe(true);
    expect(lines.map((l) => l.message)).toEqual(["hello", "oops"]);
  });

  it("filters by configured level", () => {
    const capture = makeCapture();
    const log = createPinoLogger({
      service: "pharmacy-test",
      level: "warn",
      destination: capture.stream,
    });

    log.debug("d");
    log.info("i");
    log.warn("w");
    log.error("e");

    const lines = capture.lines();
    expect(lines.map((l) => l.message)).toEqual(["w", "e"]);
  });

  it("child() bindings appear in every subsequent line and stack", () => {
    const capture = makeCapture();
    const root = createPinoLogger({
      service: "pharmacy-test",
      destination: capture.stream,
    });

    const ctx = root.child({ component: "stripe.webhook" });
    const stripeEvtCtx = ctx.child({ stripeEventId: "evt_123" });

    ctx.info("ctx-line");
    stripeEvtCtx.warn("evt-line");

    const lines = capture.lines();
    expect(lines[0]?.["component"]).toBe("stripe.webhook");
    expect(lines[1]?.["component"]).toBe("stripe.webhook");
    expect(lines[1]?.["stripeEventId"]).toBe("evt_123");
  });

  it("merges per-call context with bindings (per-call wins on conflict)", () => {
    const capture = makeCapture();
    const log = createPinoLogger({
      service: "pharmacy-test",
      destination: capture.stream,
    }).child({ component: "base", attempt: 1 });

    log.info("overridden", { attempt: 2 });

    const line = capture.lines()[0];
    expect(line?.["component"]).toBe("base");
    expect(line?.["attempt"]).toBe(2);
  });

  it("redacts default sensitive fields (password / token / authorization header / patient PII)", () => {
    const capture = makeCapture();
    const log = createPinoLogger({
      service: "pharmacy-test",
      destination: capture.stream,
    });

    log.info("login.attempt", {
      user: {
        email: "ops@example.com",
        password: "hunter2",
        token: "secret-jwt",
      },
      headers: {
        authorization: "Bearer secret-jwt",
        "stripe-signature": "t=123,v1=abc",
      },
      patient: {
        firstName: "Alice",
        lastName: "Anderson",
        dateOfBirth: "1990-01-01",
        mrn: "MRN-12345",
      },
    });

    const line = capture.lines()[0];
    const user = line?.["user"] as Record<string, unknown> | undefined;
    expect(user?.["password"]).toBe("[Redacted]");
    expect(user?.["token"]).toBe("[Redacted]");
    expect(user?.["email"]).toBe("[Redacted]");

    const headers = line?.["headers"] as Record<string, unknown> | undefined;
    expect(headers?.["authorization"]).toBe("[Redacted]");
    expect(headers?.["stripe-signature"]).toBe("[Redacted]");

    const patient = line?.["patient"] as Record<string, unknown> | undefined;
    expect(patient?.["firstName"]).toBe("[Redacted]");
    expect(patient?.["lastName"]).toBe("[Redacted]");
    expect(patient?.["dateOfBirth"]).toBe("[Redacted]");
    expect(patient?.["mrn"]).toBe("[Redacted]");
  });

  it("redacts sensitive fields at the TOP level of the context, not just nested", () => {
    // Regression: `*.field` patterns only match nested objects, so
    // `logger.error("x", { firstName })` used to emit the raw value.
    const capture = makeCapture();
    const log = createPinoLogger({
      service: "pharmacy-test",
      destination: capture.stream,
    });

    log.error("patient.decrypt_failed", {
      firstName: "Alice",
      dateOfBirth: "1990-01-01",
      token: "secret-jwt",
      phone: "555-0100",
    });

    const line = capture.lines()[0];
    expect(line?.["firstName"]).toBe("[Redacted]");
    expect(line?.["dateOfBirth"]).toBe("[Redacted]");
    expect(line?.["token"]).toBe("[Redacted]");
    expect(line?.["phone"]).toBe("[Redacted]");
  });

  it("does not redact safe metadata fields", () => {
    const capture = makeCapture();
    const log = createPinoLogger({
      service: "pharmacy-test",
      destination: capture.stream,
    });

    log.info("order.created", {
      order: {
        id: "00000000-0000-0000-0000-0000000000aa",
        status: "RECEIVED",
        attempts: 0,
      },
      durationMs: 42,
    });

    const line = capture.lines()[0];
    const order = line?.["order"] as Record<string, unknown> | undefined;
    expect(order?.["id"]).toBe("00000000-0000-0000-0000-0000000000aa");
    expect(order?.["status"]).toBe("RECEIVED");
    expect(order?.["attempts"]).toBe(0);
    expect(line?.["durationMs"]).toBe(42);
  });

  it("extraSensitiveFields add to the defaults without removing them", () => {
    const capture = makeCapture();
    const log = createPinoLogger({
      service: "pharmacy-test",
      destination: capture.stream,
      extraSensitiveFields: ["last4"],
    });

    log.info("payment.captured", {
      card: { last4: "4242", brand: "visa" },
      user: { password: "still-redacted" },
    });

    const line = capture.lines()[0];
    const card = line?.["card"] as Record<string, unknown> | undefined;
    expect(card?.["last4"]).toBe("[Redacted]");
    expect(card?.["brand"]).toBe("visa");

    const user = line?.["user"] as Record<string, unknown> | undefined;
    expect(user?.["password"]).toBe("[Redacted]");
  });

  it("redacts sensitive fields at ANY depth, not just one level down", () => {
    // Regression: path-based redaction only reached the depths it
    // enumerated, so a context nested one level deeper than the path
    // list leaked in full.
    const capture = makeCapture();
    const log = createPinoLogger({
      service: "pharmacy-test",
      destination: capture.stream,
    });

    log.error("command.failed", {
      command: {
        input: {
          patient: {
            demographics: { firstName: "Alice", mrn: "MRN-12345" },
          },
        },
      },
    });

    const line = JSON.stringify(capture.lines()[0]);
    expect(line).not.toContain("Alice");
    expect(line).not.toContain("MRN-12345");
    expect(line).toContain("[Redacted]");
  });

  it("redacts sensitive fields inside arrays, at any nesting", () => {
    const capture = makeCapture();
    const log = createPinoLogger({
      service: "pharmacy-test",
      destination: capture.stream,
    });

    log.info("batch.processed", {
      orders: [
        { id: "ord_1", patient: { lastName: "Anderson" } },
        { id: "ord_2", contacts: [{ phone: "555-0100" }] },
      ],
    });

    const line = JSON.stringify(capture.lines()[0]);
    expect(line).not.toContain("Anderson");
    expect(line).not.toContain("555-0100");
    // Safe identifiers in the same array survive.
    expect(line).toContain("ord_1");
    expect(line).toContain("ord_2");
  });

  it("matches field names case-insensitively", () => {
    const capture = makeCapture();
    const log = createPinoLogger({
      service: "pharmacy-test",
      destination: capture.stream,
    });

    log.info("odd.casing", { FirstName: "Alice", MRN: "MRN-1", Authorization: "Bearer x" });

    const line = capture.lines()[0];
    expect(line?.["FirstName"]).toBe("[Redacted]");
    expect(line?.["MRN"]).toBe("[Redacted]");
    expect(line?.["Authorization"]).toBe("[Redacted]");
  });

  it("does not mutate the caller's context object", () => {
    // Domain code often logs an object it is still using. A redactor
    // with side effects would corrupt the in-flight request.
    const capture = makeCapture();
    const log = createPinoLogger({
      service: "pharmacy-test",
      destination: capture.stream,
    });

    const context = { patient: { firstName: "Alice" }, orderId: "ord_1" };
    log.info("order.created", context);

    expect(context.patient.firstName).toBe("Alice");
    const line = capture.lines()[0];
    expect((line?.["patient"] as Record<string, unknown>)["firstName"]).toBe("[Redacted]");
  });

  it("survives circular references", () => {
    const capture = makeCapture();
    const log = createPinoLogger({
      service: "pharmacy-test",
      destination: capture.stream,
    });

    const node: Record<string, unknown> = { orderId: "ord_1", mrn: "MRN-1" };
    node["self"] = node;

    expect(() => log.info("cycle", { node })).not.toThrow();
    const line = JSON.stringify(capture.lines()[0]);
    expect(line).not.toContain("MRN-1");
    expect(line).toContain("ord_1");
  });

  it("passes Error objects through so Pino can serialize the stack", () => {
    // The redactor must not rebuild an Error into a plain object —
    // that would strip the stack before Pino's `err` serializer runs.
    const capture = makeCapture();
    const log = createPinoLogger({
      service: "pharmacy-test",
      destination: capture.stream,
    });

    log.error("dispatch.failed", { err: new Error("upstream timeout"), orderId: "ord_1" });

    const line = capture.lines()[0];
    const err = line?.["err"] as Record<string, unknown> | undefined;
    expect(err?.["message"]).toBe("upstream timeout");
    expect(typeof err?.["stack"]).toBe("string");
    expect(line?.["orderId"]).toBe("ord_1");
  });

  it("still scrubs a plain object logged under an error-ish key", () => {
    const capture = makeCapture();
    const log = createPinoLogger({
      service: "pharmacy-test",
      destination: capture.stream,
    });

    log.error("dispatch.failed", { error: { code: "TIMEOUT", firstName: "Alice" } });

    const error = capture.lines()[0]?.["error"] as Record<string, unknown> | undefined;
    expect(error?.["code"]).toBe("TIMEOUT");
    expect(error?.["firstName"]).toBe("[Redacted]");
  });

  it("redacts sensitive bindings on child loggers", () => {
    const capture = makeCapture();
    const log = createPinoLogger({
      service: "pharmacy-test",
      destination: capture.stream,
    }).child({ component: "intake", patient: { mrn: "MRN-1" } });

    log.info("bound");

    const line = JSON.stringify(capture.lines()[0]);
    expect(line).not.toContain("MRN-1");
    expect(line).toContain("intake");
  });

  it("timestamps are ISO 8601 strings (lexically-sortable)", () => {
    const capture = makeCapture();
    const log = createPinoLogger({
      service: "pharmacy-test",
      destination: capture.stream,
    });

    log.info("t1");
    log.info("t2");

    const lines = capture.lines();
    expect(lines[0]?.time).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(lines[1]?.time).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });
});
