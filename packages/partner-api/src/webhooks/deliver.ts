// Single webhook delivery attempt (ADR-0032).
//
// Given a decrypted signing secret and a delivery row's fields, POST
// the signed envelope to the partner endpoint and classify the
// outcome. Retry/backoff/DEAD bookkeeping belongs to the worker
// drain, not here.
//
// Envelope shape (documented in openapi-v1.yaml):
//
//   {
//     "id":         "<webhook_delivery id>",   // partner-side dedupe key
//     "type":       "order.shipped.v1",
//     "occurredAt": "<ISO-8601>",
//     "data":       { ...registry-validated payload }
//   }
//
// THIS IS ALSO THE SSRF ENFORCEMENT POINT (risk R-024)
//
// `CreateWebhookSubscription` screens the URL when it is stored, but
// that check is lexical and cannot see through a hostname. This is
// the last code that runs before a socket opens, so it re-checks the
// destination for real:
//
//   1. Re-run the shared lexical guard on the stored URL. Cheap, and
//      it covers rows written before that guard existed — a legacy
//      `http://` or `:8080` endpoint is refused here even though
//      nothing refused it at write time.
//   2. Resolve the hostname ONCE, validate EVERY address it returns
//      against the same tables, and pin the connection to exactly
//      those addresses (`net.resolvePinnedAddresses`). The pin is a
//      `lookup` that performs no DNS, so the socket layer cannot
//      re-resolve and there is no rebinding window. See
//      platform-core `net/pinned-resolution.ts` for why the naive
//      resolve-then-fetch shape is TOCTOU-vulnerable.
//
// `redirect: "error"` stays, and matters more now than it did: a
// followed redirect would open a SECOND connection, to a host the pin
// never validated. The pin covers the connection we make; refusing
// redirects is what stops a different one being made for us.
//
// The pin needs a custom `lookup` on the connector, which Node's
// global `fetch` will not accept from a separate undici instance
// (`UND_ERR_INVALID_ARG`), so this module calls undici's `fetch`
// directly. Tracing is unaffected: `@opentelemetry/instrumentation-
// undici` hooks the global `undici:request:*` diagnostics channels,
// which the standalone package publishes under the same names, so the
// client span and the outbound `traceparent` are still produced.
//
// WHAT A REFUSAL LOOKS LIKE TO AN OPERATOR
//
// A refused destination is NOT an ordinary network error and must not
// read like one in `webhook_delivery.lastError`. Both refusal shapes
// keep `responseStatus: null` — no HTTP exchange happened, and
// inventing a status would put a lie in the delivery record — and
// carry a stable prefix instead:
//
//   "Destination refused: ..."      the endpoint points somewhere we
//                                   will not dial
//   "Destination unresolvable: ..." the name did not resolve at all
//
// against an ordinary failure's "TypeError: fetch failed",
// "Timed out after 10000ms", or "Endpoint responded 503".
//
// Both refusals are RETRYABLE, on purpose. Refusing costs no egress
// (we never opened a socket), each retry re-resolves from scratch, so
// a partner who corrects a bad DNS record self-heals without operator
// action, and the delivery still DEADs after the drain's normal
// attempt ceiling like any other persistent failure. Terminating on
// the first refusal would instead discard a real delivery over one
// bad answer from a resolver.
//
// PHI: payloads are phi-safe by construction; errors captured here
// include the HTTP status and a short message, never response bodies
// (a partner's error page could echo anything). Refusal details name
// the address CLASS or the resolver's error CODE — never the
// hostname, the URL, or the resolved address.

import { net } from "@pharmax/platform-core";
import { Agent, fetch as undiciFetch, type Dispatcher } from "undici";

import { signWebhookPayload, WEBHOOK_SIGNATURE_HEADER } from "./signature.js";

export const WEBHOOK_DELIVERY_TIMEOUT_MS = 10_000;
export const WEBHOOK_USER_AGENT = "Pharmax-Webhooks/1.0";

/** Stable, greppable marker: we will not dial this destination. */
export const WEBHOOK_DESTINATION_REFUSED_PREFIX = "Destination refused";
/** Stable, greppable marker: the endpoint's name did not resolve. */
export const WEBHOOK_DESTINATION_UNRESOLVABLE_PREFIX = "Destination unresolvable";

/**
 * The init this transport sends.
 *
 * `dispatcher` is deliberately ABSENT from this type even though
 * every request carries one. It is undici's runtime extension to
 * `fetch`'s init, and this file is typechecked under two lib
 * configurations that disagree about it: the Node config's
 * `RequestInit` declares it against the second, older copy of
 * undici's types that `@types/node` bundles (not assignable to the
 * real one), while apps/web's DOM config does not declare it at all.
 * Naming it here breaks one or the other. Leaving it off keeps the
 * global `fetch` assignable to `WebhookFetch` under both, so an
 * injected fake typed as `typeof fetch` still compiles. The value is
 * attached at the call site, where exactly one copy exists at
 * runtime.
 */
export interface WebhookFetchInit {
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: string;
  readonly signal: AbortSignal;
  readonly redirect: "error";
}

/**
 * The slice of `fetch` this transport uses. Deliberately narrower
 * than `typeof fetch` on the argument side and wider on the
 * dispatcher side; the global `fetch` remains assignable to it, so
 * existing injected fakes keep working.
 */
export type WebhookFetch = (
  url: string,
  init: WebhookFetchInit
) => Promise<{ readonly status: number }>;

export interface AttemptWebhookDeliveryInput {
  readonly url: string;
  /** Decrypted `pxw_` signing secret. */
  readonly secret: string;
  readonly deliveryId: string;
  readonly eventType: string;
  readonly payload: unknown;
  /** When the source event was recorded (outbox createdAt). */
  readonly occurredAt: Date;
  /** Injectable for tests. Defaults to undici's fetch. */
  readonly fetchImpl?: WebhookFetch;
  /**
   * Injectable resolver. Defaults to the system resolver; tests pass
   * a stub so the suite never touches real DNS.
   */
  readonly resolveAddresses?: net.AddressResolver;
  /**
   * Injectable pin construction, so a test can assert WHICH addresses
   * the connection was pinned to. Defaults to
   * `createPinnedWebhookDispatcher`.
   */
  readonly createDispatcher?: (lookup: net.PinnedResolutionAccepted["lookup"]) => Dispatcher;
  readonly timeoutMs?: number;
  /** Injectable clock (unix ms) for deterministic signatures in tests. */
  readonly nowMs?: number;
}

export type AttemptWebhookDeliveryResult =
  | { readonly ok: true; readonly responseStatus: number }
  | { readonly ok: false; readonly responseStatus: number | null; readonly error: string };

/**
 * A dispatcher that can only reach the addresses the pin was built
 * from.
 *
 * One per attempt, destroyed when the attempt ends. A pooled,
 * process-wide agent would keep a validated connection alive across
 * retries and quietly reintroduce the staleness the re-resolve exists
 * to remove.
 */
export function createPinnedWebhookDispatcher(
  lookup: net.PinnedResolutionAccepted["lookup"]
): Dispatcher {
  return new Agent({ connect: { lookup } });
}

/** Sentinel for "the attempt deadline fired before this settled". */
const TIMED_OUT = Symbol("timed-out");

/**
 * Bound `work` by the attempt's existing deadline. Resolution runs
 * inside the SAME budget as the request, so adding it did not make an
 * attempt take longer than `timeoutMs` — which matters because the
 * drain walks its claimed rows serially and a black-holed resolver
 * would otherwise stall the whole tick.
 */
async function withDeadline<T>(
  signal: AbortSignal,
  work: Promise<T>
): Promise<T | typeof TIMED_OUT> {
  if (signal.aborted) {
    return TIMED_OUT;
  }
  let onAbort: (() => void) | undefined;
  const deadline = new Promise<typeof TIMED_OUT>((resolve) => {
    onAbort = (): void => resolve(TIMED_OUT);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    if (onAbort !== undefined) {
      signal.removeEventListener("abort", onAbort);
    }
  }
}

function refused(error: string): AttemptWebhookDeliveryResult {
  return Object.freeze({ ok: false as const, responseStatus: null, error });
}

export async function attemptWebhookDelivery(
  input: AttemptWebhookDeliveryInput
): Promise<AttemptWebhookDeliveryResult> {
  // Same two-copies-of-undici-types crossing as WebhookDispatcher.
  const fetchImpl = input.fetchImpl ?? (undiciFetch as unknown as WebhookFetch);
  const timeoutMs = input.timeoutMs ?? WEBHOOK_DELIVERY_TIMEOUT_MS;
  const nowMs = input.nowMs ?? Date.now();
  const createDispatcher = input.createDispatcher ?? createPinnedWebhookDispatcher;

  // Step 1: the stored URL must still pass the lexical guard.
  const endpoint = net.classifyOutboundUrl(input.url);
  if (!endpoint.ok) {
    return refused(`${WEBHOOK_DESTINATION_REFUSED_PREFIX}: ${endpoint.detail}`);
  }

  const body = JSON.stringify({
    id: input.deliveryId,
    type: input.eventType,
    occurredAt: input.occurredAt.toISOString(),
    data: input.payload,
  });

  const signature = signWebhookPayload({
    secret: input.secret,
    timestamp: Math.floor(nowMs / 1000),
    body,
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let dispatcher: Dispatcher | undefined;
  try {
    // Step 2: one resolution, every address validated, then pinned.
    const resolution = await withDeadline(
      controller.signal,
      net.resolvePinnedAddresses(endpoint.url.hostname, input.resolveAddresses)
    );
    if (resolution === TIMED_OUT) {
      return refused(
        `${WEBHOOK_DESTINATION_UNRESOLVABLE_PREFIX}: Resolver did not answer within ${timeoutMs}ms.`
      );
    }
    if (!resolution.ok) {
      const prefix =
        resolution.reason === "resolution_failed"
          ? WEBHOOK_DESTINATION_UNRESOLVABLE_PREFIX
          : WEBHOOK_DESTINATION_REFUSED_PREFIX;
      return refused(`${prefix}: ${resolution.detail}`);
    }

    dispatcher = createDispatcher(resolution.lookup);
    // Widened rather than inlined so `dispatcher` rides along without
    // being named on WebhookFetchInit — see the note on that type.
    const init: WebhookFetchInit & { readonly dispatcher: Dispatcher } = {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": WEBHOOK_USER_AGENT,
        [WEBHOOK_SIGNATURE_HEADER]: signature,
        "pharmax-event-type": input.eventType,
        "pharmax-delivery-id": input.deliveryId,
      },
      body,
      signal: controller.signal,
      // A redirect would open a connection the pin never validated.
      redirect: "error",
      dispatcher,
    };
    const response = await fetchImpl(input.url, init);

    if (response.status >= 200 && response.status < 300) {
      return Object.freeze({ ok: true, responseStatus: response.status });
    }
    return Object.freeze({
      ok: false,
      responseStatus: response.status,
      error: `Endpoint responded ${response.status}`,
    });
  } catch (cause) {
    const message =
      cause instanceof Error && cause.name === "AbortError"
        ? `Timed out after ${timeoutMs}ms`
        : cause instanceof Error
          ? `${cause.name}: ${cause.message}`
          : "Unknown transport error";
    return Object.freeze({ ok: false, responseStatus: null, error: message });
  } finally {
    clearTimeout(timer);
    // Tear the socket down with the attempt. The response body is
    // never read, so `destroy` (not `close`, which waits on it) is
    // the terminating call.
    await dispatcher?.destroy();
  }
}

/**
 * Decrypt binding for a subscription's signing secret — kept next to
 * the transport so the worker and any future rotation command agree
 * on the AAD tuple by importing ONE constant.
 */
export function webhookSecretBinding(input: {
  readonly organizationId: string;
  readonly subscriptionId: string;
}): {
  readonly tenantId: string;
  readonly table: "webhook_subscription";
  readonly column: "secret";
  readonly recordId: string;
} {
  return Object.freeze({
    tenantId: input.organizationId,
    table: "webhook_subscription" as const,
    column: "secret" as const,
    recordId: input.subscriptionId,
  });
}
