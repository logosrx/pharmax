// resolvePinnedAddresses contract tests.
//
// This is the delivery-time half of the SSRF boundary — the control
// that runs when we are about to open a socket, after the lexical
// guard has already accepted a hostname it cannot see through. The
// properties worth pinning down are therefore not "does it reject
// 127.0.0.1" (the shared tables already own that, and
// outbound-url.test.ts covers them) but the three that make the
// difference between a real control and false confidence:
//
//   - EVERY resolved address is judged, so one private AAAA hiding
//     behind a public A poisons the whole answer.
//   - The pin cannot resolve. Whatever hostname the socket layer
//     asks it for, it hands back the addresses that were validated,
//     so there is no second DNS query to race.
//   - Nothing is cached, so an answer that passed once cannot keep
//     authorising connections later.
//
// The resolver is injected everywhere except one bracketed-literal
// test, which uses the real resolver on a NUMERIC name — getaddrinfo
// answers those locally, so no test here issues a real DNS query.
// All addresses are reserved documentation blocks or well-known
// public resolver addresses; no hostname is real.

import { describe, expect, it, vi } from "vitest";

import {
  resolvePinnedAddresses,
  type AddressResolver,
  type ResolvedAddress,
} from "./pinned-resolution.js";

const HOSTNAME = "partner.example.com";

/** A globally routable IPv4 / IPv6 pair the tables accept. */
const PUBLIC_V4: ResolvedAddress = { address: "8.8.8.8", family: 4 };
const PUBLIC_V6: ResolvedAddress = { address: "2606:4700:4700::1111", family: 6 };

function resolverOf(...addresses: readonly ResolvedAddress[]): AddressResolver {
  return async () => addresses;
}

type LookupResult =
  | { readonly kind: "all"; readonly addresses: readonly ResolvedAddress[] }
  | { readonly kind: "single"; readonly address: string; readonly family: number }
  | { readonly kind: "error"; readonly message: string };

/** Drive a pin the way `net.connect` does and capture what it answers. */
async function pinFor(resolver: AddressResolver): Promise<{
  call: (options: { all?: boolean; family?: number }, hostname?: string) => Promise<LookupResult>;
  addresses: readonly ResolvedAddress[];
}> {
  const resolution = await resolvePinnedAddresses(HOSTNAME, resolver);
  if (!resolution.ok) {
    throw new Error(`expected an accepted resolution, got: ${resolution.detail}`);
  }
  const { lookup, addresses } = resolution;
  return {
    addresses,
    call: (options, hostname = HOSTNAME) =>
      new Promise<LookupResult>((resolve) => {
        lookup(hostname, options, (error, address, family) => {
          if (error !== null) {
            resolve({ kind: "error", message: error.message });
            return;
          }
          if (Array.isArray(address)) {
            resolve({
              kind: "all",
              addresses: address.map((entry) => ({
                address: entry.address,
                family: entry.family === 6 ? 6 : 4,
              })),
            });
            return;
          }
          resolve({ kind: "single", address: String(address), family: family ?? 0 });
        });
      }),
  };
}

describe("resolvePinnedAddresses — accepts a public answer", () => {
  it("accepts a hostname whose every address is globally routable", async () => {
    const resolution = await resolvePinnedAddresses(HOSTNAME, resolverOf(PUBLIC_V4, PUBLIC_V6));
    expect(resolution.ok).toBe(true);
    if (!resolution.ok) return;
    expect(resolution.addresses).toEqual([PUBLIC_V4, PUBLIC_V6]);
  });

  it("preserves resolver order, so happy-eyeballs still gets the resolver's preference", async () => {
    const resolution = await resolvePinnedAddresses(HOSTNAME, resolverOf(PUBLIC_V6, PUBLIC_V4));
    expect(resolution.ok).toBe(true);
    if (!resolution.ok) return;
    expect(resolution.addresses.map((entry) => entry.address)).toEqual([
      PUBLIC_V6.address,
      PUBLIC_V4.address,
    ]);
  });
});

describe("resolvePinnedAddresses — WHATWG-bracketed IPv6 literals", () => {
  // `url.hostname` keeps an IPv6 literal bracketed
  // (`[2606:4700:4700::1111]`), and the delivery transport passes
  // `url.hostname` straight in. `getaddrinfo` refuses the bracketed
  // spelling outright, so unless the brackets are stripped here every
  // public IPv6-literal endpoint records as unresolvable and never
  // dials.

  it("hands the resolver the bare literal, never the bracketed spelling", async () => {
    const resolver = vi.fn<AddressResolver>(async () => [PUBLIC_V6]);
    const resolution = await resolvePinnedAddresses(`[${PUBLIC_V6.address}]`, resolver);
    expect(resolver).toHaveBeenCalledWith(PUBLIC_V6.address);
    expect(resolution).toMatchObject({ ok: true });
  });

  it("resolves a bracketed public literal through the REAL resolver", async () => {
    // The regression as it actually presented: systemAddressResolver
    // + `url.hostname`. getaddrinfo maps a numeric name to itself
    // without a DNS query, so this touches no network.
    const resolution = await resolvePinnedAddresses(`[${PUBLIC_V6.address}]`);
    expect(resolution.ok).toBe(true);
    if (!resolution.ok) return;
    expect(resolution.addresses).toEqual([PUBLIC_V6]);
  });

  it("still refuses a bracketed non-public literal", async () => {
    const resolution = await resolvePinnedAddresses("[::1]", async () => [
      { address: "::1", family: 6 },
    ]);
    expect(resolution).toMatchObject({ ok: false, reason: "non_public_address" });
  });
});

describe("resolvePinnedAddresses — refuses non-public answers", () => {
  it("refuses a hostname that resolves to the cloud metadata address", async () => {
    // The headline R-024 attack: a lexically-innocent name whose A
    // record points at IMDS.
    const resolution = await resolvePinnedAddresses(
      HOSTNAME,
      resolverOf({ address: "169.254.169.254", family: 4 })
    );
    expect(resolution).toMatchObject({ ok: false, reason: "non_public_address" });
    if (resolution.ok) return;
    expect(resolution.detail).toContain("link-local");
  });

  it("refuses loopback, RFC1918, and CGNAT answers", async () => {
    for (const address of ["127.0.0.1", "10.0.0.5", "192.168.1.10", "172.16.4.4", "100.64.0.1"]) {
      const resolution = await resolvePinnedAddresses(HOSTNAME, resolverOf({ address, family: 4 }));
      expect(resolution).toMatchObject({ ok: false, reason: "non_public_address" });
    }
  });

  it("refuses IPv6 loopback, unique-local, and link-local answers", async () => {
    for (const address of ["::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1"]) {
      const resolution = await resolvePinnedAddresses(HOSTNAME, resolverOf({ address, family: 6 }));
      expect(resolution).toMatchObject({ ok: false, reason: "non_public_address" });
    }
  });

  it("refuses a MIXED answer — a public A does not excuse a private AAAA", async () => {
    // The whole reason every address is checked. A connector doing
    // happy-eyeballs may well prefer the AAAA, so "one of them was
    // public" is not a safe answer; a mixed reply is evidence the
    // name is not under honest control.
    const resolution = await resolvePinnedAddresses(
      HOSTNAME,
      resolverOf(PUBLIC_V4, { address: "fd00::1", family: 6 })
    );
    expect(resolution).toMatchObject({ ok: false, reason: "non_public_address" });
  });

  it("refuses a mixed answer regardless of which position the private address is in", async () => {
    const privateFirst = await resolvePinnedAddresses(
      HOSTNAME,
      resolverOf({ address: "10.1.2.3", family: 4 }, PUBLIC_V4)
    );
    const privateLast = await resolvePinnedAddresses(
      HOSTNAME,
      resolverOf(PUBLIC_V4, { address: "10.1.2.3", family: 4 })
    );
    const privateMiddle = await resolvePinnedAddresses(
      HOSTNAME,
      resolverOf(PUBLIC_V4, { address: "10.1.2.3", family: 4 }, PUBLIC_V6)
    );
    for (const resolution of [privateFirst, privateLast, privateMiddle]) {
      expect(resolution).toMatchObject({ ok: false, reason: "non_public_address" });
    }
  });

  it("refuses an answer whose addresses are not IP literals at all", async () => {
    // Fail closed: "we could not tell" must never mean "connect".
    const resolution = await resolvePinnedAddresses(
      HOSTNAME,
      resolverOf({ address: "not-an-address", family: 4 })
    );
    expect(resolution).toMatchObject({ ok: false, reason: "non_public_address" });
  });
});

describe("resolvePinnedAddresses — refuses unresolvable names", () => {
  it("refuses when the resolver throws, and reports the error CODE only", async () => {
    const resolver: AddressResolver = async () => {
      const error = new Error(`getaddrinfo ENOTFOUND ${HOSTNAME}`) as Error & { code: string };
      error.code = "ENOTFOUND";
      throw error;
    };
    const resolution = await resolvePinnedAddresses(HOSTNAME, resolver);
    expect(resolution).toMatchObject({ ok: false, reason: "resolution_failed" });
    if (resolution.ok) return;
    expect(resolution.detail).toContain("ENOTFOUND");
    // The resolver's message embeds the hostname; the verdict must not.
    expect(resolution.detail).not.toContain(HOSTNAME);
  });

  it("refuses when the resolver throws something with no code", async () => {
    const resolver: AddressResolver = async () => {
      throw new Error("boom");
    };
    const resolution = await resolvePinnedAddresses(HOSTNAME, resolver);
    expect(resolution).toMatchObject({ ok: false, reason: "resolution_failed" });
    if (resolution.ok) return;
    expect(resolution.detail).toContain("unknown resolver error");
  });

  it("refuses an empty answer rather than treating it as nothing to check", async () => {
    const resolution = await resolvePinnedAddresses(HOSTNAME, resolverOf());
    expect(resolution).toMatchObject({ ok: false, reason: "resolution_failed" });
  });
});

describe("resolvePinnedAddresses — verdict details leak nothing", () => {
  it("never echoes the hostname or the resolved address", async () => {
    const resolution = await resolvePinnedAddresses(
      "internal-thing.partner.example.com",
      resolverOf({ address: "169.254.169.254", family: 4 })
    );
    expect(resolution.ok).toBe(false);
    if (resolution.ok) return;
    expect(resolution.detail).not.toContain("internal-thing");
    expect(resolution.detail).not.toContain("169.254.169.254");
  });
});

describe("the pin — cannot resolve, so there is no second query to race", () => {
  it("answers the `all: true` form with exactly the validated addresses", async () => {
    // `net.connect` uses this form when autoSelectFamily is on, which
    // is the default. It must see the validated set and nothing else.
    const pin = await pinFor(resolverOf(PUBLIC_V4, PUBLIC_V6));
    await expect(pin.call({ all: true })).resolves.toEqual({
      kind: "all",
      addresses: [PUBLIC_V4, PUBLIC_V6],
    });
  });

  it("answers the single-address form with the first validated address", async () => {
    const pin = await pinFor(resolverOf(PUBLIC_V4, PUBLIC_V6));
    await expect(pin.call({})).resolves.toEqual({
      kind: "single",
      address: PUBLIC_V4.address,
      family: 4,
    });
  });

  it("honours a requested family, and errors rather than substituting another", async () => {
    const pin = await pinFor(resolverOf(PUBLIC_V4));
    await expect(pin.call({ family: 4 })).resolves.toEqual({
      kind: "single",
      address: PUBLIC_V4.address,
      family: 4,
    });
    // No validated IPv6 exists. Failing the socket is correct; quietly
    // handing back the IPv4 would be a lie to the connector, and
    // falling back to a real lookup would reopen the race.
    await expect(pin.call({ family: 6 })).resolves.toMatchObject({ kind: "error" });
  });

  it("IGNORES the hostname it is asked for — this is what defeats rebinding", async () => {
    // The socket layer passes the hostname it wants. A pin that
    // honoured it would just be a resolver with extra steps. Ask it
    // for a completely different name and it must still answer with
    // the addresses that were validated.
    const pin = await pinFor(resolverOf(PUBLIC_V4));
    await expect(pin.call({ all: true }, "attacker-controlled.example.com")).resolves.toEqual({
      kind: "all",
      addresses: [PUBLIC_V4],
    });
  });

  it("performs no DNS of its own, however many times the connector asks", async () => {
    const resolver = vi.fn<AddressResolver>(async () => [PUBLIC_V4]);
    const pin = await pinFor(resolver);
    await pin.call({ all: true });
    await pin.call({});
    await pin.call({ all: true }, "somewhere-else.example.com");
    // One resolution for the attempt, and only one.
    expect(resolver).toHaveBeenCalledTimes(1);
  });

  it("cannot be retargeted by mutating the array the resolver returned", async () => {
    const mutable: ResolvedAddress[] = [PUBLIC_V4];
    const resolution = await resolvePinnedAddresses(HOSTNAME, async () => mutable);
    expect(resolution.ok).toBe(true);
    if (!resolution.ok) return;
    mutable.push({ address: "169.254.169.254", family: 4 });
    mutable[0] = { address: "127.0.0.1", family: 4 };

    const answered = await new Promise<readonly ResolvedAddress[]>((resolve) => {
      resolution.lookup(HOSTNAME, { all: true }, (_error, address) => {
        resolve(
          (Array.isArray(address) ? address : []).map((entry) => ({
            address: entry.address,
            family: entry.family === 6 ? 6 : 4,
          }))
        );
      });
    });
    expect(answered).toEqual([PUBLIC_V4]);
  });
});

describe("resolvePinnedAddresses — nothing is cached across attempts", () => {
  it("re-resolves on every call", async () => {
    const resolver = vi.fn<AddressResolver>(async () => [PUBLIC_V4]);
    await resolvePinnedAddresses(HOSTNAME, resolver);
    await resolvePinnedAddresses(HOSTNAME, resolver);
    await resolvePinnedAddresses(HOSTNAME, resolver);
    expect(resolver).toHaveBeenCalledTimes(3);
  });

  it("refuses on a later attempt when a previously-good name turns private", async () => {
    // The drain retries with backoff. A cached "it was public at
    // 09:00" must not authorise the 09:30 attempt.
    let answer: readonly ResolvedAddress[] = [PUBLIC_V4];
    const resolver: AddressResolver = async () => answer;

    await expect(resolvePinnedAddresses(HOSTNAME, resolver)).resolves.toMatchObject({ ok: true });
    answer = [{ address: "169.254.169.254", family: 4 }];
    await expect(resolvePinnedAddresses(HOSTNAME, resolver)).resolves.toMatchObject({
      ok: false,
      reason: "non_public_address",
    });
  });
});
