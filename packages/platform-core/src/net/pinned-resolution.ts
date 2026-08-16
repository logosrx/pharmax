// Delivery-time DNS validation with connection pinning (ADR-0032,
// risk R-024).
//
// `./outbound-url.ts` screens a caller-supplied URL when it is
// STORED. That check is lexical, so it cannot see through a hostname:
// `https://partner.example.com/` looks exactly like a legitimate
// endpoint whether its A record points at a partner's load balancer
// or at 169.254.169.254, and a name that resolves publicly at
// registration can be re-pointed the minute after. This module is the
// other half — the control that runs when we are about to DIAL.
//
// WHY A CUSTOM `lookup` AND NOT "resolve, check, then fetch"
//
// The obvious version is broken. If you resolve a hostname, validate
// the answer, and then hand the HOSTNAME to your HTTP client, the
// client resolves it a SECOND time inside the socket layer. An
// attacker who controls the zone answers the first query with a
// public address and the second with 169.254.169.254 — classic DNS
// rebinding, and the check bought nothing. That TOCTOU window is
// exactly why the write-time guard's author declined to half-build
// this: a validation that does not pin creates false confidence,
// which is worse than a documented residual.
//
// So there is only ever ONE resolution per attempt. It happens here,
// every address it returns is validated, and the surviving set is
// frozen into a `lookup` function that performs NO DNS of its own —
// it can only hand back addresses that were already validated. That
// function is what the socket layer calls, so the address that was
// checked IS the address that gets dialled. There is no second query
// to race.
//
// WHY EVERY ADDRESS, AND WHY ONE BAD ONE POISONS THE SET
//
// `getaddrinfo` returns every A and AAAA record. Validating only the
// first, or filtering to "the public ones", both fail the same way:
// a hostile zone returns one routable A next to a private AAAA and
// lets the connector's happy-eyeballs logic pick the AAAA. A mixed
// answer is not a partly-good answer, it is evidence the name is not
// under honest control, so the whole attempt is refused.
//
// NO CACHING, DELIBERATELY
//
// Nothing here memoizes. Callers retry on a backoff and each attempt
// must re-resolve from scratch: a cache would let an answer that
// passed at 09:00 keep authorising connections at 11:00, which
// reintroduces the staleness the pin exists to remove. TTL handling
// is therefore "no TTL, no reuse".
//
// PHI: none. Details name the address CLASS or the resolver's error
// CODE, never the hostname, the URL, or the resolved address.

import { lookup as systemLookup } from "node:dns/promises";
import type { LookupFunction } from "node:net";

import { classifyOutboundAddress } from "./outbound-url.js";

export interface ResolvedAddress {
  readonly address: string;
  readonly family: 4 | 6;
}

/**
 * Hostname -> every address the name resolves to. Injectable so the
 * test suite can drive this path without touching a real resolver;
 * production passes `systemAddressResolver`. Always receives the bare
 * hostname — `resolvePinnedAddresses` strips WHATWG's IPv6 brackets
 * before the resolver sees the name.
 */
export type AddressResolver = (hostname: string) => Promise<readonly ResolvedAddress[]>;

/** Which rule refused the destination. One code per distinct cause. */
export type PinnedResolutionRejection = "resolution_failed" | "non_public_address";

export interface PinnedResolutionAccepted {
  readonly ok: true;
  /** Every address that passed, in resolver order. */
  readonly addresses: readonly ResolvedAddress[];
  /**
   * The pin. Hand this to the socket layer (undici's
   * `Agent({ connect: { lookup } })`, `net.connect`, `https.request`)
   * so the connection can only reach `addresses`. It performs no DNS.
   */
  readonly lookup: LookupFunction;
}

export interface PinnedResolutionRejected {
  readonly ok: false;
  readonly reason: PinnedResolutionRejection;
  /** Address class or resolver error code. Never the hostname. */
  readonly detail: string;
}

export type PinnedResolution = PinnedResolutionAccepted | PinnedResolutionRejected;

/**
 * The real resolver: one `getaddrinfo` returning every A and AAAA
 * record. `verbatim` keeps the resolver's own ordering rather than
 * re-sorting IPv4 first — we validate all of them, so the order only
 * affects which one the connector tries first.
 */
export const systemAddressResolver: AddressResolver = async (hostname) => {
  const entries = await systemLookup(hostname, { all: true, verbatim: true });
  return entries.map((entry) => ({
    address: entry.address,
    family: entry.family === 6 ? (6 as const) : (4 as const),
  }));
};

/**
 * Build the pinned `lookup`. Private on purpose: the ONLY way a
 * caller can obtain one is off a successful `resolvePinnedAddresses`,
 * so it is not possible to pin a connection to an address that was
 * never validated.
 */
function createPinnedLookup(addresses: readonly ResolvedAddress[]): LookupFunction {
  // Copy so a later mutation of the caller's array cannot retarget a
  // live pin.
  const pinned: readonly ResolvedAddress[] = addresses.map((entry) => ({
    address: entry.address,
    family: entry.family,
  }));

  // `hostname` is ignored, and that is the entire point: whatever the
  // connector asks for, it gets the validated set and nothing else.
  return (_hostname, options, callback) => {
    // `net.connect` uses `all: true` when happy-eyeballs
    // (`autoSelectFamily`) is on, and the single-address form
    // otherwise. Both shapes have to be answered.
    if (options.all === true) {
      callback(
        null,
        pinned.map((entry) => ({ address: entry.address, family: entry.family }))
      );
      return;
    }

    const wanted = options.family === 4 || options.family === 6 ? options.family : null;
    const chosen = wanted === null ? pinned[0] : pinned.find((entry) => entry.family === wanted);
    if (chosen === undefined) {
      // Fail the socket rather than fall back to a real lookup.
      callback(new Error("No validated address for the requested family."), "", 4);
      return;
    }
    callback(null, chosen.address, chosen.family);
  };
}

/** Pull a resolver's error CODE without echoing the hostname it names. */
function resolverErrorCode(cause: unknown): string {
  if (typeof cause === "object" && cause !== null && "code" in cause) {
    const code = (cause as { readonly code?: unknown }).code;
    if (typeof code === "string" && code !== "") {
      return code;
    }
  }
  return "unknown resolver error";
}

/**
 * Resolve `hostname`, validate EVERY address it returns against the
 * shared outbound tables, and — on success — return the pin that
 * restricts the connection to exactly those addresses.
 *
 * Refuses the whole attempt if the name does not resolve, resolves to
 * nothing, or resolves to anything non-public. See the module header
 * for why a mixed answer is not a partial success.
 */
export async function resolvePinnedAddresses(
  hostname: string,
  resolver: AddressResolver = systemAddressResolver
): Promise<PinnedResolution> {
  // A caller holding `url.hostname` has WHATWG's bracketed spelling
  // for an IPv6 literal (`[2606:4700:4700::1111]`), which
  // `getaddrinfo` refuses outright. Strip the brackets so the
  // resolver sees the bare literal — `getaddrinfo` maps a numeric
  // name to itself without a DNS query — and the address then goes
  // through the same table check as any resolved answer.
  const bareHostname =
    hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;

  let addresses: readonly ResolvedAddress[];
  try {
    addresses = await resolver(bareHostname);
  } catch (cause) {
    return Object.freeze({
      ok: false as const,
      reason: "resolution_failed" as const,
      detail: `Hostname did not resolve (${resolverErrorCode(cause)}).`,
    });
  }

  if (addresses.length === 0) {
    return Object.freeze({
      ok: false as const,
      reason: "resolution_failed" as const,
      detail: "Hostname resolved to no addresses.",
    });
  }

  for (const entry of addresses) {
    const verdict = classifyOutboundAddress(entry.address);
    if (!verdict.ok) {
      return Object.freeze({
        ok: false as const,
        reason: "non_public_address" as const,
        detail: verdict.detail,
      });
    }
  }

  const validated = Object.freeze(
    addresses.map((entry) => Object.freeze({ address: entry.address, family: entry.family }))
  );
  return Object.freeze({
    ok: true as const,
    addresses: validated,
    lookup: createPinnedLookup(validated),
  });
}
