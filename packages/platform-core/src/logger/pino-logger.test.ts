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

  it("extraRedactPaths add to the default allowlist without removing defaults", () => {
    const capture = makeCapture();
    const log = createPinoLogger({
      service: "pharmacy-test",
      destination: capture.stream,
      extraRedactPaths: ["*.last4"],
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
