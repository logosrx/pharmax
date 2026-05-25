// Generic env loader for Pharmax apps and workers.
//
// Inline copies of this pattern existed in apps/web/src/server/env.ts
// and apps/worker/src/env.ts before this module. Generalizing it gives
// us:
//
//   - One source of truth for "what does a failed env validation look
//     like" (matters for ops runbooks).
//   - Guaranteed redaction of env values in error messages — Zod's
//     default error format CAN echo invalid input under certain
//     refinement combinators. We strip values defensively.
//   - A frozen result so consumers can't mutate config at runtime,
//     which would defeat the fail-fast guarantee.
//
// Usage:
//
//   const schema = z.object({
//     DATABASE_URL: z.string().url(),
//     LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
//   });
//   export const env = defineEnv(schema);
//
// Module-load-time validation is intentional: a misconfigured worker
// should fail at boot, not at the first request three days in when
// nobody is watching logs.

import type { ZodTypeAny, z } from "zod";

export interface DefineEnvOptions {
  /**
   * Defaults to `process.env`. Tests may inject a custom map to
   * exercise validation branches without polluting global state.
   */
  readonly source?: Record<string, string | undefined>;

  /**
   * Defaults to `"environment"`. Surfaces in the thrown error message
   * — useful when multiple env contexts coexist (e.g. server vs worker
   * in the same process for integration tests).
   */
  readonly contextLabel?: string;
}

export class EnvValidationError extends Error {
  public readonly fieldErrors: Readonly<Record<string, ReadonlyArray<string>>>;
  public readonly contextLabel: string;

  public constructor(contextLabel: string, fieldErrors: Record<string, ReadonlyArray<string>>) {
    const summary = Object.entries(fieldErrors)
      .map(([key, messages]) => `  ${key}: ${messages.join(", ")}`)
      .join("\n");
    super(`Invalid ${contextLabel}:\n${summary}`);
    this.name = "EnvValidationError";
    this.contextLabel = contextLabel;
    this.fieldErrors = Object.freeze(
      Object.fromEntries(
        Object.entries(fieldErrors).map(([key, messages]) => [key, Object.freeze([...messages])])
      )
    );
  }
}

export function defineEnv<TSchema extends ZodTypeAny>(
  schema: TSchema,
  options: DefineEnvOptions = {}
): Readonly<z.infer<TSchema>> {
  const source = options.source ?? process.env;
  const contextLabel = options.contextLabel ?? "environment";

  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const fieldErrors = redactZodFieldErrors(parsed.error.flatten().fieldErrors);
    throw new EnvValidationError(contextLabel, fieldErrors);
  }

  // Freeze so callers can't mutate config at runtime.
  return Object.freeze(parsed.data) as Readonly<z.infer<TSchema>>;
}

/**
 * Zod's default `flatten()` returns `Record<string, string[] | undefined>`.
 * The messages MAY include refinement-emitted strings that echo input
 * (e.g. `z.string().refine(s => s.startsWith("sk_"), "must start with sk_ — got 'bad'")`).
 * We do not parse those for safety, but we DO ensure the structure
 * itself is normalized (no undefined values, no raw input echoed by
 * us). Callers writing refinements with custom messages are
 * responsible for not embedding the value.
 */
function redactZodFieldErrors(
  raw: Record<string, string[] | undefined>
): Record<string, ReadonlyArray<string>> {
  const result: Record<string, ReadonlyArray<string>> = {};
  for (const [key, messages] of Object.entries(raw)) {
    if (messages === undefined || messages.length === 0) {
      continue;
    }
    result[key] = Object.freeze([...messages]);
  }
  return result;
}
