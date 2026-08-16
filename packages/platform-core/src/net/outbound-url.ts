// Outbound URL validation — the shared SSRF guard (ADR-0032).
//
// Any stored, caller-supplied URL that OUR infrastructure will later
// dial from inside the VPC has to pass through here first. Two
// call sites today:
//
//   - `CreateWebhookSubscription` (@pharmax/partner-api). A
//     subscription is a standing instruction for the delivery drain
//     to POST a signed payload at a partner-chosen URL on a poll
//     loop. Without a host check, `https://` alone lets an
//     authenticated tenant aim that loop at the loopback interface,
//     the cloud metadata service, or any RFC1918 neighbour, and read
//     back internal reachability through the recorded
//     `responseStatus`.
//
//   - `RegisterCarrierCredential` (@pharmax/shipping). The optional
//     `baseUrl` override is dialled by the FedEx/UPS/EasyPost clients
//     WITH THE CARRIER CREDENTIAL ATTACHED — FedEx posts
//     `client_id`/`client_secret` as a form body to
//     `<baseUrl>/oauth/token`, UPS sends `Authorization: Basic
//     base64(id:secret)`, EasyPost sends the API key as Basic auth on
//     every call. A hostile `baseUrl` therefore exfiltrates the
//     credential itself, not just reachability, and the tracking
//     pollers re-dial it unattended on every tick.
//
// This module is deliberately generic and lives in platform-core so
// both callers share ONE copy of the CIDR tables. A forked second
// copy would drift, and the divergence would not be visible in
// either package's tests.
//
// WHAT THIS CLOSES
//
// Every non-public destination expressible as a literal address or an
// obviously-local name. The check runs on the WHATWG-parsed URL, not
// the raw string, which matters more than it looks: the parser
// normalizes `https://2130706433/`, `https://0x7f.1/`, and
// `https://[::ffff:127.0.0.1]/` to `127.0.0.1`, `127.0.0.1`, and
// `::ffff:7f00:1`. Decimal, octal, hex, and IPv4-mapped-IPv6
// obfuscation therefore all collapse into the two literal forms the
// tables below cover, instead of each needing its own rule.
//
// WHAT THIS DOES NOT CLOSE
//
// DNS. `https://evil.example.com/` is lexically indistinguishable
// from any other public endpoint, and its A record may point at
// 169.254.169.254 today or be re-pointed there tomorrow (rebinding).
// A creation-time lexical check cannot see that and does not claim
// to. Closing it needs a delivery-time control — resolve, validate
// every resolved address, and pin the connection to the address that
// was validated — or an egress allowlist / forward proxy.
//
// That delivery-time control now exists for ONE of the two callers:
// `./pinned-resolution.ts` implements it and the webhook delivery
// transport uses it. It reuses the address tables below through
// `classifyOutboundAddress` rather than forking them. The carrier
// clients still dial by hostname and remain bounded only by the
// operator-only `baseUrl` permission.
//
// What bounds the residual differs by call site, so do not read one
// caller's mitigations onto the other:
//
//   - Webhook delivery is POST-only (IMDSv2 needs a PUT to mint a
//     token) and `deliver.ts` sets `redirect: "error"`, so a public
//     endpoint cannot 302 the worker inward.
//   - The carrier clients now set `redirect: "error"` as well, and
//     additionally refuse any 3xx handed back to them (their `fetch`
//     is injectable, so they cannot assume the transport honors the
//     flag). They are NOT method-bounded, though: `FedExClient`
//     issues a PUT for shipment cancellation, which is the method
//     IMDSv2 needs. Their other bound is that `baseUrl` is settable
//     only by an internal operator holding
//     `ship.manage_carrier_credentials`, never by a partner.
//
// Common to both: refusing any port but 443 means even a hostile DNS
// answer reaches exactly one port instead of scanning.
//
// PHI: none. Verdict details name the address CLASS that fired and
// never echo the caller's URL.

/** Which rule refused the URL. One code per distinct cause. */
export type OutboundUrlRejection =
  "unparseable" | "not_https" | "embedded_credentials" | "non_default_port" | "non_public_host";

export interface OutboundUrlAccepted {
  readonly ok: true;
  readonly url: URL;
}

export interface OutboundUrlRejected {
  readonly ok: false;
  readonly reason: OutboundUrlRejection;
  /** Human-readable class that fired. Never contains the input URL. */
  readonly detail: string;
}

export type OutboundUrlVerdict = OutboundUrlAccepted | OutboundUrlRejected;

/** WHATWG normalizes every numeric IPv4 form to a dotted quad. */
const IPV4_DOTTED_QUAD = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function ipv4ToInt(a: number, b: number, c: number, d: number): number {
  return ((a << 24) >>> 0) + (b << 16) + (c << 8) + d;
}

interface Ipv4Block {
  readonly base: number;
  readonly bits: number;
  readonly label: string;
}

/**
 * IANA IPv4 Special-Purpose Address Registry, restricted to the
 * blocks that are not globally reachable. Written as a table so a
 * reviewer can check it against the registry line by line rather
 * than reading control flow.
 */
const IPV4_RESERVED_BLOCKS: readonly Ipv4Block[] = [
  { base: ipv4ToInt(0, 0, 0, 0), bits: 8, label: 'unspecified / "this network"' },
  { base: ipv4ToInt(10, 0, 0, 0), bits: 8, label: "RFC1918 private" },
  { base: ipv4ToInt(100, 64, 0, 0), bits: 10, label: "carrier-grade NAT" },
  { base: ipv4ToInt(127, 0, 0, 0), bits: 8, label: "loopback" },
  { base: ipv4ToInt(169, 254, 0, 0), bits: 16, label: "link-local (cloud instance metadata)" },
  { base: ipv4ToInt(172, 16, 0, 0), bits: 12, label: "RFC1918 private" },
  { base: ipv4ToInt(192, 0, 0, 0), bits: 24, label: "IETF protocol assignments" },
  { base: ipv4ToInt(192, 0, 2, 0), bits: 24, label: "documentation (TEST-NET-1)" },
  { base: ipv4ToInt(192, 168, 0, 0), bits: 16, label: "RFC1918 private" },
  { base: ipv4ToInt(198, 18, 0, 0), bits: 15, label: "benchmarking" },
  { base: ipv4ToInt(198, 51, 100, 0), bits: 24, label: "documentation (TEST-NET-2)" },
  { base: ipv4ToInt(203, 0, 113, 0), bits: 24, label: "documentation (TEST-NET-3)" },
  { base: ipv4ToInt(224, 0, 0, 0), bits: 4, label: "multicast" },
  { base: ipv4ToInt(240, 0, 0, 0), bits: 4, label: "reserved / broadcast" },
];

/** Reserved-block label, or null when the literal is globally routable. */
function classifyIpv4(hostname: string): string | null {
  const match = IPV4_DOTTED_QUAD.exec(hostname);
  if (match === null) {
    return null;
  }
  const octets = [match[1], match[2], match[3], match[4]].map((part) => Number(part));
  if (octets.some((octet) => Number.isNaN(octet) || octet > 255)) {
    // Unreachable via a parsed URL — WHATWG rejects `999.1.1.1` —
    // but the helper is exported-adjacent, so fail closed.
    return "malformed IPv4 literal";
  }
  const address = ipv4ToInt(octets[0]!, octets[1]!, octets[2]!, octets[3]!);
  for (const block of IPV4_RESERVED_BLOCKS) {
    const mask = block.bits === 0 ? 0 : (0xffffffff << (32 - block.bits)) >>> 0;
    if ((address & mask) >>> 0 === block.base) {
      return block.label;
    }
  }
  return null;
}

type Ipv6Groups = readonly [number, number, number, number, number, number, number, number];

/** Expand an IPv6 literal to its eight 16-bit groups, or null. */
function expandIpv6(address: string): Ipv6Groups | null {
  const halves = address.split("::");
  if (halves.length > 2) {
    return null;
  }

  const parseGroups = (part: string): number[] | null => {
    if (part === "") {
      return [];
    }
    const groups: number[] = [];
    const pieces = part.split(":");
    for (const [index, piece] of pieces.entries()) {
      // A trailing dotted quad (`::ffff:127.0.0.1`) occupies the
      // final two groups. WHATWG never emits this form, but a caller
      // may hand us an un-normalized literal.
      if (piece.includes(".")) {
        if (index !== pieces.length - 1) {
          return null;
        }
        const quad = IPV4_DOTTED_QUAD.exec(piece);
        if (quad === null) {
          return null;
        }
        const octets = [quad[1], quad[2], quad[3], quad[4]].map((o) => Number(o));
        if (octets.some((octet) => Number.isNaN(octet) || octet > 255)) {
          return null;
        }
        groups.push((octets[0]! << 8) | octets[1]!, (octets[2]! << 8) | octets[3]!);
        continue;
      }
      if (!/^[0-9a-f]{1,4}$/i.test(piece)) {
        return null;
      }
      groups.push(Number.parseInt(piece, 16));
    }
    return groups;
  };

  const head = parseGroups(halves[0] ?? "");
  const tail = halves.length === 2 ? parseGroups(halves[1] ?? "") : [];
  if (head === null || tail === null) {
    return null;
  }
  if (halves.length === 1) {
    return head.length === 8 ? (head as unknown as Ipv6Groups) : null;
  }
  const fill = 8 - head.length - tail.length;
  if (fill < 1) {
    return null;
  }
  return [...head, ...new Array<number>(fill).fill(0), ...tail] as unknown as Ipv6Groups;
}

/** Reserved-scope label, or null when the literal is globally routable. */
function classifyIpv6(address: string): string | null {
  const groups = expandIpv6(address);
  if (groups === null) {
    return "malformed IPv6 literal";
  }
  const [g0, g1, g2, g3, g4, g5, g6, g7] = groups;

  if (groups.every((group) => group === 0)) {
    return "unspecified (::)";
  }
  if (
    g0 === 0 &&
    g1 === 0 &&
    g2 === 0 &&
    g3 === 0 &&
    g4 === 0 &&
    g5 === 0 &&
    g6 === 0 &&
    g7 === 1
  ) {
    return "IPv6 loopback (::1)";
  }
  // ::ffff:0:0/96 (IPv4-mapped) and ::/96 (deprecated IPv4-compatible)
  // both carry an IPv4 address in the low 32 bits. Re-run the IPv4
  // table over it — `::ffff:7f00:1` IS 127.0.0.1.
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && (g5 === 0xffff || g5 === 0)) {
    const embedded = `${g6 >> 8}.${g6 & 0xff}.${g7 >> 8}.${g7 & 0xff}`;
    const label = classifyIpv4(embedded);
    return label === null ? null : `IPv4-in-IPv6 ${label}`;
  }
  if ((g0 & 0xffc0) === 0xfe80) {
    return "IPv6 link-local (fe80::/10)";
  }
  if ((g0 & 0xfe00) === 0xfc00) {
    return "IPv6 unique-local (fc00::/7)";
  }
  if ((g0 & 0xff00) === 0xff00) {
    return "IPv6 multicast (ff00::/8)";
  }
  if (g0 === 0x0100 && g1 === 0 && g2 === 0 && g3 === 0) {
    return "IPv6 discard-only (100::/64)";
  }
  if (g0 === 0x2001 && g1 === 0x0db8) {
    return "IPv6 documentation (2001:db8::/32)";
  }
  // 64:ff9b::/96 (NAT64) and 2002::/16 (6to4) both embed an IPv4
  // address the far side will route for us. Neither is a legitimate
  // partner endpoint, so refuse the prefix outright.
  if (g0 === 0x0064 && g1 === 0xff9b) {
    return "IPv6 NAT64 translation prefix (64:ff9b::/96)";
  }
  if (g0 === 0x2002) {
    return "IPv6 6to4 prefix (2002::/16)";
  }
  return null;
}

/**
 * Names that can only resolve through a local resolver, a search
 * domain, or /etc/hosts. A public endpoint always has a registrable
 * domain, so a single-label host is included: `https://intranet/`
 * reaches a neighbour, never a partner or a carrier.
 */
const LOCAL_HOSTNAME_SUFFIXES: readonly string[] = [".localhost", ".local", ".internal"];

function classifyHostname(hostname: string): string | null {
  // One trailing dot is a legal FQDN root; strip it so `localhost.`
  // and `svc.internal.` are judged on their real labels.
  const name = hostname.endsWith(".") ? hostname.slice(0, -1) : hostname;
  if (name === "localhost") {
    return "localhost";
  }
  for (const suffix of LOCAL_HOSTNAME_SUFFIXES) {
    if (name.endsWith(suffix)) {
      return `local-only domain (*${suffix})`;
    }
  }
  if (!name.includes(".")) {
    return "single-label hostname (resolves only via a local search domain)";
  }
  return null;
}

export interface OutboundAddressAccepted {
  readonly ok: true;
}

export interface OutboundAddressRejected {
  readonly ok: false;
  /** Human-readable class that fired. Never contains the address. */
  readonly detail: string;
}

export type OutboundAddressVerdict = OutboundAddressAccepted | OutboundAddressRejected;

/**
 * Judge a BARE IP literal — the form a resolver hands back, with no
 * URL wrapped around it.
 *
 * This is the public entry point the delivery-time control in
 * `./pinned-resolution.ts` uses to check every resolved address. It
 * exists so that path shares the SAME tables as `classifyOutboundUrl`
 * instead of forking a second copy: a block added above is enforced
 * at both creation time and delivery time, or at neither.
 *
 * Fails CLOSED. Anything that is not a well-formed IPv4 or IPv6
 * literal is refused rather than waved through, because the only
 * callers are on a path where "we could not tell" must not mean
 * "connect anyway".
 */
export function classifyOutboundAddress(address: string): OutboundAddressVerdict {
  // A caller holding `url.hostname` for an IPv6 host has the
  // bracketed form; accept it so both spellings reach the same table.
  const bare = address.startsWith("[") && address.endsWith("]") ? address.slice(1, -1) : address;

  if (bare === "") {
    return Object.freeze({ ok: false as const, detail: "empty address" });
  }

  const label = bare.includes(":")
    ? classifyIpv6(bare)
    : IPV4_DOTTED_QUAD.test(bare)
      ? classifyIpv4(bare)
      : "not an IP literal";

  if (label !== null) {
    return Object.freeze({
      ok: false as const,
      detail: `Address is a non-public destination: ${label}.`,
    });
  }
  return Object.freeze({ ok: true as const });
}

/**
 * Decide whether a caller-supplied URL is a legitimate outbound
 * destination for our infrastructure to dial. Lexical only — see the
 * DNS note in the module header for what this deliberately does not
 * cover.
 */
export function classifyOutboundUrl(rawUrl: string): OutboundUrlVerdict {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return Object.freeze({
      ok: false as const,
      reason: "unparseable" as const,
      detail: "URL could not be parsed.",
    });
  }

  if (url.protocol !== "https:") {
    return Object.freeze({
      ok: false as const,
      reason: "not_https" as const,
      detail: "Scheme must be https.",
    });
  }

  // `https://user:pass@host/` is refused for two independent reasons:
  // it is the classic host-confusion disguise, and both callers
  // persist the URL verbatim somewhere that does not redact it —
  // webhook: audit metadata + outbox payload; carrier: the
  // `carrier_credential` row and `command_log.requestPayload`, whose
  // redaction list covers the key material but not `baseUrl`. A
  // credential here becomes a plaintext secret in the append-only
  // chain.
  if (url.username !== "" || url.password !== "") {
    return Object.freeze({
      ok: false as const,
      reason: "embedded_credentials" as const,
      detail: "URL must not carry userinfo credentials.",
    });
  }

  // WHATWG normalizes an explicit `:443` on https to the empty
  // string, so this only refuses a genuinely non-default port. The
  // point is the residual DNS risk: a hostile name we cannot see
  // through still only ever reaches one port instead of scanning.
  if (url.port !== "") {
    return Object.freeze({
      ok: false as const,
      reason: "non_default_port" as const,
      detail: "Endpoint must listen on the default HTTPS port (443).",
    });
  }

  const hostname = url.hostname;
  const literal =
    hostname.startsWith("[") && hostname.endsWith("]")
      ? classifyIpv6(hostname.slice(1, -1))
      : IPV4_DOTTED_QUAD.test(hostname)
        ? classifyIpv4(hostname)
        : classifyHostname(hostname);

  if (literal !== null) {
    return Object.freeze({
      ok: false as const,
      reason: "non_public_host" as const,
      detail: `Host is a non-public destination: ${literal}.`,
    });
  }

  return Object.freeze({ ok: true as const, url });
}

/** Emitted in place of a URL we will not tokenize. */
export const UNREPORTABLE_URL = "<unparseable>";

/**
 * Reduce a URL to the least an operator needs in order to act on it:
 * scheme plus host, including the port when one was given.
 *
 * Everything else is dropped, because a URL that FAILED the guard is
 * the one most likely to carry a secret. `https://key:secret@host/`
 * puts a credential in userinfo — the `embedded_credentials` verdict
 * exists precisely because a row written before the guard can look
 * like that — and a path or query can carry a bearer token. An audit
 * line has to be safe to paste into a ticket, so none of that is
 * echoed. The scheme and host are not secrets and are what an
 * operator needs to recognize the row.
 *
 * An unparseable input is not tokenized at all: with no structure to
 * trust there is no way to tell a host from a payload, so nothing is
 * echoed.
 */
export function redactUrlForReport(rawUrl: string): string {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return UNREPORTABLE_URL;
  }
  // Non-special schemes (`file:`, `javascript:`) parse with an empty
  // host and carry their payload in the path. Never fall back to
  // echoing that payload.
  return url.host === "" ? `${url.protocol}<no-host>` : `${url.protocol}//${url.host}`;
}
