import { describe, expect, it } from "vitest";
import { z } from "zod";

import { defineEnv, EnvValidationError } from "./define-env.js";

describe("defineEnv", () => {
  const schema = z.object({
    DATABASE_URL: z.string().url(),
    LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
    BATCH_SIZE: z.coerce.number().int().positive().default(10),
  });

  it("returns the parsed config when the source is valid", () => {
    const env = defineEnv(schema, {
      source: {
        DATABASE_URL: "postgresql://app:pass@db:5432/app",
        LOG_LEVEL: "debug",
        BATCH_SIZE: "25",
      },
    });
    expect(env.DATABASE_URL).toBe("postgresql://app:pass@db:5432/app");
    expect(env.LOG_LEVEL).toBe("debug");
    expect(env.BATCH_SIZE).toBe(25);
  });

  it("applies schema defaults for missing optional fields", () => {
    const env = defineEnv(schema, {
      source: { DATABASE_URL: "postgresql://app:pass@db:5432/app" },
    });
    expect(env.LOG_LEVEL).toBe("info");
    expect(env.BATCH_SIZE).toBe(10);
  });

  it("freezes the returned config so consumers cannot mutate runtime settings", () => {
    const env = defineEnv(schema, {
      source: { DATABASE_URL: "postgresql://app:pass@db:5432/app" },
    });
    expect(Object.isFrozen(env)).toBe(true);
    expect(() => {
      (env as { LOG_LEVEL: string }).LOG_LEVEL = "warn";
    }).toThrowError(TypeError);
  });

  it("throws EnvValidationError listing each failing field", () => {
    let caught: unknown = null;
    try {
      defineEnv(schema, {
        source: { LOG_LEVEL: "verbose" },
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(EnvValidationError);
    const err = caught as EnvValidationError;
    expect(Object.keys(err.fieldErrors)).toContain("DATABASE_URL");
    expect(Object.keys(err.fieldErrors)).toContain("LOG_LEVEL");
  });

  it("error message does NOT echo raw input values from the env source", () => {
    const SECRET_VALUE = "sk_oops_too_short";
    let caught: unknown = null;
    try {
      defineEnv(
        z.object({
          // Force a failure that COULD plausibly echo the value if Zod
          // emitted a "received X" message — we want to confirm our
          // summary format never does.
          API_KEY: z.string().min(50),
        }),
        {
          source: { API_KEY: SECRET_VALUE },
        }
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(EnvValidationError);
    const message = (caught as Error).message;
    // The summary should mention the FIELD name but never the raw VALUE.
    expect(message).toContain("API_KEY");
    expect(message).not.toContain(SECRET_VALUE);
  });

  it("contextLabel surfaces in the thrown error", () => {
    let caught: unknown = null;
    try {
      defineEnv(schema, {
        source: {},
        contextLabel: "worker environment",
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(EnvValidationError);
    expect((caught as EnvValidationError).contextLabel).toBe("worker environment");
    expect((caught as Error).message).toContain("worker environment");
  });

  it("freezes the fieldErrors map and its inner arrays", () => {
    let caught: unknown = null;
    try {
      defineEnv(schema, { source: {} });
    } catch (err) {
      caught = err;
    }
    const err = caught as EnvValidationError;
    expect(Object.isFrozen(err.fieldErrors)).toBe(true);
    const dbUrlErrors = err.fieldErrors["DATABASE_URL"];
    expect(dbUrlErrors).toBeDefined();
    expect(Object.isFrozen(dbUrlErrors)).toBe(true);
  });
});
