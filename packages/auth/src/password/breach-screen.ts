// The PRE-TRANSACTION password breach screen.
//
// Why this module exists at all: the breach check is a call to a
// third-party corpus, and it used to run from inside `applyNewPassword`
// — which receives the command's `tx`. Every password change and reset
// therefore made an outbound network call with a Postgres transaction
// open. A clean failure would only have aborted the command; a HANG,
// which is what a degrading third party actually does, pins a pooled
// connection and whatever locks the transaction already took for as
// long as the provider takes to answer, and concurrent credential
// operations queue up behind the pool.
//
// The command bus opens the transaction before it calls `handle`, so a
// handler cannot get the call out of the transaction by reordering its
// own steps. The screen has to happen BEFORE the command is dispatched.
// That is what `withScreenedPassword` is: the caller screens the
// plaintext (no `tx` needed — the checker wants the plaintext and the
// policy, nothing else), then runs the command inside an ALS frame
// carrying the verdict. The handler reads the verdict with
// `requireBreachScreen` and merges it into the structural policy
// evaluation, which stays inside the transaction because it is pure,
// synchronous, and depends on the user row the token resolves to.
//
// ALS rather than a command input field: the verdict is an
// infrastructure fact, not something a client may assert. Threading it
// through `inputSchema` would put a security decision in the request
// body, and `command_log.requestPayload` would then record a
// caller-supplied claim about a check the caller did not run.
//
// FAIL CLOSED on a missing frame. Dispatching one of these commands
// without screening first is a programming error, and the failure mode
// of guessing is a password path that quietly never consults the breach
// corpus. `requireBreachScreen` throws `InternalError` instead — loud
// in the first test run, paged in production.

import { AsyncLocalStorage } from "node:async_hooks";

import { runtime, type logger } from "@pharmax/platform-core";

import { getAuthConfiguration } from "../configure.js";
import { passwordBreachScreenMissingError } from "../errors.js";
import { checkNotBreached, type BreachScreenOutcome } from "./policy.js";

/**
 * A completed breach screen, bound to the plaintext it judged.
 *
 * `plaintext` is the binding, not a payload: it lets the in-transaction
 * step prove the verdict belongs to the password it is about to store,
 * so a misordered or reused frame cannot certify a different one. It
 * lives only as long as the request that is already holding the same
 * string in the command input, and is never logged or persisted.
 */
export interface BreachScreen {
  readonly plaintext: string;
  readonly outcome: BreachScreenOutcome;
  /** Non-sensitive violation text to merge with the structural evaluation. */
  readonly violations: ReadonlyArray<string>;
}

// globalThis-backed for the same reason as the tenancy ALS: Next.js
// gives each route bundle its own copy of this module, and the frame is
// entered by an orchestration function that may be compiled into a
// different bundle from the command handler that reads it.
const storage = runtime.globalSingleton(
  "pharmax:auth:breach-screen",
  () => new AsyncLocalStorage<BreachScreen>()
);

/**
 * Screen `plaintext` against the configured breach corpus, then run
 * `fn` with the verdict available to `requireBreachScreen`.
 *
 * Call this OUTSIDE the command transaction — i.e. wrapping the
 * `executeCommand` / `executeSystemCommand` call, which is what the
 * `resetPassword` / `acceptInvite` orchestration functions do.
 *
 * The screen never throws on a breached password: it records the
 * violation and lets the command reject it from inside its own
 * transaction, so the attempt still lands in `command_log` as a FAILED
 * row with a reason. Rejecting out here would delete that evidence.
 */
export async function withScreenedPassword<T>(
  plaintext: string,
  fn: () => PromiseLike<T> | T
): Promise<T> {
  const { password } = getAuthConfiguration();
  // The screen runs before the token/actor checks the command performs,
  // so a request that was going to be refused anyway still costs one
  // corpus lookup. Accepted deliberately: the alternative is either the
  // in-transaction network call this module exists to remove, or a
  // second copy of the policy out here deciding what is worth checking.
  // Public credential-setting endpoints should be rate-limited for this
  // reason among others.
  const result = await checkNotBreached({ plaintext, policy: password });
  const screen: BreachScreen = Object.freeze({
    plaintext,
    outcome: result.outcome,
    violations: result.violations,
  });
  // Await inside the frame (not merely return through it) so lazy
  // thenables begin executing in-frame — see @pharmax/tenancy's als.ts.
  return storage.run(screen, async () => await fn());
}

/** The active screen, or `null` outside a `withScreenedPassword` frame. */
export function getBreachScreen(): BreachScreen | null {
  return storage.getStore() ?? null;
}

/**
 * The active screen for `plaintext`. Throws
 * `InternalError(PASSWORD_BREACH_SCREEN_MISSING)` when there is no
 * frame, or when the frame judged a different password — either way the
 * caller has no evidence about THIS password and must not proceed as
 * though it were screened.
 */
export function requireBreachScreen(plaintext: string): BreachScreen {
  const screen = storage.getStore();
  if (screen === undefined) {
    throw passwordBreachScreenMissingError("no_active_screen");
  }
  if (screen.plaintext !== plaintext) {
    throw passwordBreachScreenMissingError("screen_password_mismatch");
  }
  return screen;
}

/** True when the corpus was not actually consulted for this password. */
export function isBreachScreenBypassed(screen: BreachScreen): boolean {
  return screen.outcome === "bypassed_error" || screen.outcome === "bypassed_timeout";
}

/**
 * Warn when a password was accepted without the breach corpus having
 * answered. Paired with the `breachScreen` field every caller puts in
 * its audit metadata: the audit row is the durable per-credential
 * record, this is the signal an operator can alert on. A control that
 * fails open without saying so has stopped existing.
 *
 * `context` must carry ids and counts only — never the plaintext, and
 * never PHI.
 */
export function logBreachScreenBypass(
  log: logger.Logger,
  screen: BreachScreen,
  context: logger.LogContext
): void {
  if (!isBreachScreenBypassed(screen)) return;
  log.warn("password breach screen bypassed; password accepted unscreened", {
    ...context,
    breachScreen: screen.outcome,
  });
}
