import type { LookupFunction } from "node:net";

import { describe, expect, it, vi } from "vitest";

import {
  attemptWebhookDelivery,
  createPinnedWebhookDispatcher,
  webhookSecretBinding,
  WEBHOOK_DESTINATION_REFUSED_PREFIX,
  WEBHOOK_DESTINATION_UNRESOLVABLE_PREFIX,
  WEBHOOK_USER_AGENT,
  type WebhookFetch,
} from "./deliver.js";
import { verifyWebhookSignature, WEBHOOK_SIGNATURE_HEADER } from "./signature.js";

const SECRET = "pxw_test-secret-for-delivery-unit-tests-0000000";

/** A globally routable address the outbound tables accept. */
const PUBLIC_V4 = { address: "8.8.8.8", family: 4 } as const;

/**
 * Every test injects a resolver. `attemptWebhookDelivery` resolves
 * the endpoint's hostname before it opens a socket, so without this
 * the suite would issue real DNS queries — slow, flaky, and a network
 * call the unit suite must not make.
 */
const publicResolver = async (): Promise<readonly (typeof PUBLIC_V4)[]> => [PUBLIC_V4];

function captureFetch(status: number): {
  fetchImpl: typeof fetch;
  calls: Array<{ url: string; init: RequestInit }>;
} {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(null, { status });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

describe("attemptWebhookDelivery", () => {
  it("POSTs a signed envelope the reference verifier accepts", async () => {
    const { fetchImpl, calls } = captureFetch(200);
    const nowMs = 1_800_000_000_000;

    const result = await attemptWebhookDelivery({
      url: "https://partner.example/hooks",
      secret: SECRET,
      deliveryId: "d-1",
      eventType: "platform.api_key.created.v1",
      payload: { hello: "world" },
      occurredAt: new Date("2026-07-24T12:00:00.000Z"),
      fetchImpl,
      resolveAddresses: publicResolver,
      nowMs,
    });

    expect(result).toEqual({ ok: true, responseStatus: 200 });
    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call).toBeDefined();
    if (call === undefined) return;

    expect(call.url).toBe("https://partner.example/hooks");
    expect(call.init.method).toBe("POST");
    expect(call.init.redirect).toBe("error");

    const headers = call.init.headers as Record<string, string>;
    expect(headers["user-agent"]).toBe(WEBHOOK_USER_AGENT);
    expect(headers["pharmax-delivery-id"]).toBe("d-1");
    expect(headers["pharmax-event-type"]).toBe("platform.api_key.created.v1");

    const body = String(call.init.body);
    const envelope = JSON.parse(body) as Record<string, unknown>;
    expect(envelope["id"]).toBe("d-1");
    expect(envelope["type"]).toBe("platform.api_key.created.v1");
    expect(envelope["occurredAt"]).toBe("2026-07-24T12:00:00.000Z");
    expect(envelope["data"]).toEqual({ hello: "world" });

    // The signature over the EXACT body must verify with our own
    // reference verifier — this is the contract partners code to.
    expect(
      verifyWebhookSignature({
        secret: SECRET,
        header: headers[WEBHOOK_SIGNATURE_HEADER] ?? "",
        body,
        nowSeconds: Math.floor(nowMs / 1000),
      })
    ).toBe(true);
  });

  it("classifies non-2xx responses as failures with the status", async () => {
    const { fetchImpl } = captureFetch(503);
    const result = await attemptWebhookDelivery({
      url: "https://partner.example/hooks",
      secret: SECRET,
      deliveryId: "d-2",
      eventType: "platform.api_key.created.v1",
      payload: {},
      occurredAt: new Date(),
      fetchImpl,
      resolveAddresses: publicResolver,
    });
    expect(result.ok).toBe(false);
    expect(result.responseStatus).toBe(503);
  });

  it("classifies transport errors as failures with a null status and NO response-body echo", async () => {
    const fetchImpl = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    const result = await attemptWebhookDelivery({
      url: "https://partner.example/hooks",
      secret: SECRET,
      deliveryId: "d-3",
      eventType: "platform.api_key.created.v1",
      payload: {},
      occurredAt: new Date(),
      fetchImpl,
      resolveAddresses: publicResolver,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.responseStatus).toBeNull();
      expect(result.error).toBe("TypeError: fetch failed");
    }
  });
});

// ---------------------------------------------------------------------------
// Delivery-time SSRF control (risk R-024)
// ---------------------------------------------------------------------------
//
// The write-time guard cannot see through a hostname, so this is
// where a name that resolves somewhere internal — at registration or
// after being re-pointed — has to be stopped. What these tests care
// about is that the refusal happens BEFORE a socket exists, that a
// partly-public answer is not treated as a pass, that the connection
// is pinned to the address that was actually validated, and that an
// operator reading `webhook_delivery.lastError` can tell a refusal
// from an outage.

const BASE = {
  secret: SECRET,
  deliveryId: "d-ssrf",
  eventType: "platform.api_key.created.v1",
  payload: {},
} as const;

/** Ask a pin what the socket layer would get, in the `all: true` form. */
async function askPin(lookup: LookupFunction): Promise<readonly unknown[]> {
  return new Promise((resolve) => {
    lookup("partner.example", { all: true }, (_error, address) =>
      resolve(Array.isArray(address) ? address : [])
    );
  });
}

describe("attemptWebhookDelivery — refuses non-public destinations at delivery time", () => {
  it("refuses a hostname that resolves to the cloud metadata address, without opening a socket", async () => {
    const { fetchImpl, calls } = captureFetch(200);
    const result = await attemptWebhookDelivery({
      ...BASE,
      url: "https://partner.example/hooks",
      occurredAt: new Date(),
      fetchImpl,
      resolveAddresses: async () => [{ address: "169.254.169.254", family: 4 }],
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.startsWith(WEBHOOK_DESTINATION_REFUSED_PREFIX)).toBe(true);
    expect(result.responseStatus).toBeNull();
    // The point of resolving first: no connection is ever attempted.
    expect(calls).toHaveLength(0);
  });

  it("refuses a MIXED answer — a public A does not excuse a private AAAA", async () => {
    // "The public one wins" is the tempting shortcut and it is wrong:
    // the connector's happy-eyeballs logic may prefer the AAAA.
    const { fetchImpl, calls } = captureFetch(200);
    const result = await attemptWebhookDelivery({
      ...BASE,
      url: "https://partner.example/hooks",
      occurredAt: new Date(),
      fetchImpl,
      resolveAddresses: async () => [PUBLIC_V4, { address: "fd00::1", family: 6 }],
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.startsWith(WEBHOOK_DESTINATION_REFUSED_PREFIX)).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("refuses a private answer just as firmly when it is the only address", async () => {
    for (const address of ["127.0.0.1", "10.0.0.7", "192.168.1.1", "::1", "fe80::1"]) {
      const { fetchImpl, calls } = captureFetch(200);
      const result = await attemptWebhookDelivery({
        ...BASE,
        url: "https://partner.example/hooks",
        occurredAt: new Date(),
        fetchImpl,
        resolveAddresses: async () => [{ address, family: address.includes(":") ? 6 : 4 }],
      });
      expect(result.ok).toBe(false);
      expect(calls).toHaveLength(0);
    }
  });

  it("refuses a stored URL the lexical guard rejects, before it resolves anything", async () => {
    // Rows written before the write-time guard existed are still in
    // the table. Delivery is the last place to catch them, and a
    // plaintext scheme or an odd port never needs a DNS query.
    const { fetchImpl, calls } = captureFetch(200);
    const resolveAddresses = vi.fn(publicResolver);
    const result = await attemptWebhookDelivery({
      ...BASE,
      url: "http://partner.example:8080/hooks",
      occurredAt: new Date(),
      fetchImpl,
      resolveAddresses,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.startsWith(WEBHOOK_DESTINATION_REFUSED_PREFIX)).toBe(true);
    expect(resolveAddresses).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });

  it("never echoes the hostname or the resolved address in the refusal", async () => {
    const { fetchImpl } = captureFetch(200);
    const result = await attemptWebhookDelivery({
      ...BASE,
      url: "https://secret-tenant-name.partner.example/hooks",
      occurredAt: new Date(),
      fetchImpl,
      resolveAddresses: async () => [{ address: "169.254.169.254", family: 4 }],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).not.toContain("secret-tenant-name");
    expect(result.error).not.toContain("169.254.169.254");
  });
});

describe("attemptWebhookDelivery — pins the connection to the validated address", () => {
  it("connects through a dispatcher pinned to exactly the addresses that passed", async () => {
    const { fetchImpl, calls } = captureFetch(200);
    let pinned: LookupFunction | undefined;

    const result = await attemptWebhookDelivery({
      ...BASE,
      url: "https://partner.example/hooks",
      occurredAt: new Date(),
      fetchImpl,
      resolveAddresses: async () => [PUBLIC_V4],
      createDispatcher: (lookup) => {
        pinned = lookup;
        return createPinnedWebhookDispatcher(lookup);
      },
    });

    expect(result).toEqual({ ok: true, responseStatus: 200 });
    expect(calls).toHaveLength(1);
    // A dispatcher reached fetch — the request cannot use the default
    // (unpinned) global agent.
    expect((calls[0]?.init as { dispatcher?: unknown }).dispatcher).toBeDefined();

    expect(pinned).toBeDefined();
    if (pinned === undefined) return;
    // And the pin resolves to the validated address, not to whatever
    // DNS would say at connect time.
    await expect(askPin(pinned)).resolves.toEqual([{ address: "8.8.8.8", family: 4 }]);
  });

  it('keeps redirect: "error", because a followed redirect would escape the pin', async () => {
    // The pin governs the connection we open. A 302 would have the
    // client open a second one, to a host nothing validated.
    const { fetchImpl, calls } = captureFetch(200);
    await attemptWebhookDelivery({
      ...BASE,
      url: "https://partner.example/hooks",
      occurredAt: new Date(),
      fetchImpl,
      resolveAddresses: publicResolver,
    });
    expect(calls[0]?.init.redirect).toBe("error");
  });

  it("re-resolves on every attempt, so a stale good answer cannot persist", async () => {
    // The drain retries with backoff. Each attempt must ask again.
    const { fetchImpl } = captureFetch(200);
    const resolveAddresses = vi.fn(publicResolver);
    const attempt = async (): Promise<unknown> =>
      attemptWebhookDelivery({
        ...BASE,
        url: "https://partner.example/hooks",
        occurredAt: new Date(),
        fetchImpl,
        resolveAddresses,
      });

    await attempt();
    await attempt();
    expect(resolveAddresses).toHaveBeenCalledTimes(2);
  });

  it("refuses a retry whose answer turned private after an earlier attempt succeeded", async () => {
    const { fetchImpl } = captureFetch(200);
    let answer: ReadonlyArray<{ address: string; family: 4 | 6 }> = [PUBLIC_V4];
    const attempt = async (): ReturnType<typeof attemptWebhookDelivery> =>
      attemptWebhookDelivery({
        ...BASE,
        url: "https://partner.example/hooks",
        occurredAt: new Date(),
        fetchImpl,
        resolveAddresses: async () => answer,
      });

    await expect(attempt()).resolves.toMatchObject({ ok: true });
    answer = [{ address: "169.254.169.254", family: 4 }];
    const second = await attempt();
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.error.startsWith(WEBHOOK_DESTINATION_REFUSED_PREFIX)).toBe(true);
  });
});

describe("attemptWebhookDelivery — an operator can tell a refusal from an outage", () => {
  it("marks an unresolvable name distinctly from a refused one and from a dead endpoint", async () => {
    const { fetchImpl } = captureFetch(200);
    const common = {
      ...BASE,
      url: "https://partner.example/hooks",
      occurredAt: new Date(),
    };

    const unresolvable = await attemptWebhookDelivery({
      ...common,
      fetchImpl,
      resolveAddresses: async () => {
        const error = new Error("getaddrinfo ENOTFOUND partner.example") as Error & {
          code: string;
        };
        error.code = "ENOTFOUND";
        throw error;
      },
    });

    const refusedDestination = await attemptWebhookDelivery({
      ...common,
      fetchImpl,
      resolveAddresses: async () => [{ address: "169.254.169.254", family: 4 }],
    });

    const endpointDown = await attemptWebhookDelivery({
      ...common,
      resolveAddresses: publicResolver,
      fetchImpl: (async () => {
        throw new TypeError("fetch failed");
      }) as typeof fetch,
    });

    const endpointErroring = await attemptWebhookDelivery({
      ...common,
      resolveAddresses: publicResolver,
      fetchImpl: captureFetch(503).fetchImpl,
    });

    // All four fail, but the delivery record tells them apart. This
    // is the difference between "your endpoint points somewhere we
    // refuse" and "your endpoint is down".
    expect(unresolvable).toMatchObject({ ok: false, responseStatus: null });
    expect(refusedDestination).toMatchObject({ ok: false, responseStatus: null });
    expect(endpointDown).toMatchObject({ ok: false, responseStatus: null });
    expect(endpointErroring).toMatchObject({ ok: false, responseStatus: 503 });

    if (unresolvable.ok || refusedDestination.ok || endpointDown.ok) return;
    expect(unresolvable.error.startsWith(WEBHOOK_DESTINATION_UNRESOLVABLE_PREFIX)).toBe(true);
    expect(unresolvable.error).toContain("ENOTFOUND");
    expect(refusedDestination.error.startsWith(WEBHOOK_DESTINATION_REFUSED_PREFIX)).toBe(true);
    // An outage must NOT be dressed up as a policy refusal.
    expect(endpointDown.error).toBe("TypeError: fetch failed");
    expect(endpointDown.error.startsWith(WEBHOOK_DESTINATION_REFUSED_PREFIX)).toBe(false);
    expect(endpointDown.error.startsWith(WEBHOOK_DESTINATION_UNRESOLVABLE_PREFIX)).toBe(false);
  });

  it("refuses a name that resolves to nothing", async () => {
    const { fetchImpl, calls } = captureFetch(200);
    const result = await attemptWebhookDelivery({
      ...BASE,
      url: "https://partner.example/hooks",
      occurredAt: new Date(),
      fetchImpl,
      resolveAddresses: async () => [],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.startsWith(WEBHOOK_DESTINATION_UNRESOLVABLE_PREFIX)).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("gives up on a resolver that never answers, inside the attempt's own deadline", async () => {
    // The drain walks its claimed rows serially, so an unbounded wait
    // here would stall the whole tick, not just this delivery.
    const { fetchImpl, calls } = captureFetch(200);
    const result = await attemptWebhookDelivery({
      ...BASE,
      url: "https://partner.example/hooks",
      occurredAt: new Date(),
      fetchImpl,
      timeoutMs: 20,
      resolveAddresses: () => new Promise(() => {}),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.startsWith(WEBHOOK_DESTINATION_UNRESOLVABLE_PREFIX)).toBe(true);
    expect(calls).toHaveLength(0);
  });
});

describe("the injected fetch seam stays compatible with the global fetch type", () => {
  it("accepts a plain `typeof fetch` implementation", () => {
    // Guards the widened `WebhookFetch` type: a fake typed as the
    // global fetch must keep compiling, or every existing caller's
    // test breaks on an invisible type change.
    const globalShaped: typeof fetch = (async () =>
      new Response(null, { status: 204 })) as typeof fetch;
    const asWebhookFetch: WebhookFetch = globalShaped;
    expect(typeof asWebhookFetch).toBe("function");
  });
});

describe("webhookSecretBinding", () => {
  it("pins the AAD tuple to (org, webhook_subscription, secret, record)", () => {
    expect(webhookSecretBinding({ organizationId: "org-1", subscriptionId: "sub-1" })).toEqual({
      tenantId: "org-1",
      table: "webhook_subscription",
      column: "secret",
      recordId: "sub-1",
    });
  });
});
