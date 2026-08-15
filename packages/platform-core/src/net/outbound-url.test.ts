// classifyOutboundUrl contract tests.
//
// This is the SSRF boundary for every caller-supplied URL our
// infrastructure later dials — partner webhook endpoints and carrier
// API base URLs alike — so the table below is written as an inventory
// of what an attacker would actually aim an outbound caller at: the
// loopback interface, the cloud metadata services, every RFC1918
// neighbour, and the numeric spellings that hide them from a naive
// string check.
//
// All hosts are RFC 2606 reserved names or reserved address blocks.

import { describe, expect, it } from "vitest";

import { classifyOutboundUrl } from "./outbound-url.js";

const PUBLIC_ENDPOINT = "https://partner.example.com/hooks";

describe("classifyOutboundUrl — accepts", () => {
  it("accepts a public HTTPS endpoint", () => {
    const verdict = classifyOutboundUrl(PUBLIC_ENDPOINT);
    expect(verdict.ok).toBe(true);
  });

  it("accepts an explicit :443, which is the default port", () => {
    // WHATWG normalizes the default port away, so this must not be
    // mistaken for the non-default-port refusal.
    expect(classifyOutboundUrl("https://partner.example.com:443/hooks").ok).toBe(true);
  });

  it("accepts a public endpoint with a query string and a trailing-dot FQDN", () => {
    expect(classifyOutboundUrl("https://partner.example.com/hooks?tenant=acme").ok).toBe(true);
    expect(classifyOutboundUrl("https://partner.example.com./hooks").ok).toBe(true);
  });

  it("accepts a globally routable IPv4 literal", () => {
    // Rejecting all literals would be easy but wrong: the control is
    // "not a private destination", not "not an IP".
    expect(classifyOutboundUrl("https://8.8.8.8/hooks").ok).toBe(true);
  });
});

describe("classifyOutboundUrl — scheme, credentials, port", () => {
  it("refuses a plaintext http endpoint", () => {
    const verdict = classifyOutboundUrl("http://partner.example.com/hooks");
    expect(verdict).toMatchObject({ ok: false, reason: "not_https" });
  });

  it("refuses non-http(s) schemes that can reach the local filesystem", () => {
    expect(classifyOutboundUrl("file:///etc/passwd")).toMatchObject({ reason: "not_https" });
    expect(classifyOutboundUrl("gopher://partner.example.com/")).toMatchObject({
      reason: "not_https",
    });
  });

  it("refuses userinfo credentials in the URL", () => {
    // Both a host-confusion disguise and a plaintext secret headed
    // for the audit chain, which does not redact the url field.
    expect(classifyOutboundUrl("https://user:pass@partner.example.com/hooks")).toMatchObject({
      ok: false,
      reason: "embedded_credentials",
    });
    expect(classifyOutboundUrl("https://user@partner.example.com/hooks")).toMatchObject({
      reason: "embedded_credentials",
    });
  });

  it("refuses a non-default port", () => {
    // Pinning 443 is what bounds the residual DNS risk: a name we
    // cannot see through reaches one port, not a port scan.
    expect(classifyOutboundUrl("https://partner.example.com:8443/hooks")).toMatchObject({
      ok: false,
      reason: "non_default_port",
    });
  });

  it("never reports a rejection detail containing the caller's URL", () => {
    const verdict = classifyOutboundUrl("https://user:hunter2@10.1.2.3:9999/secret-path");
    expect(verdict.ok).toBe(false);
    const detail = (verdict as { detail: string }).detail;
    expect(detail).not.toContain("hunter2");
    expect(detail).not.toContain("secret-path");
  });
});

describe("classifyOutboundUrl — non-public IPv4", () => {
  const rejected: ReadonlyArray<readonly [string, string]> = [
    ["loopback", "https://127.0.0.1/admin"],
    ["loopback, non-canonical octet", "https://127.1.2.3/admin"],
    ["cloud instance metadata (IMDS)", "https://169.254.169.254/latest/meta-data/"],
    ["ECS task metadata", "https://169.254.170.2/v2/credentials"],
    ["RFC1918 10/8", "https://10.0.0.7/internal"],
    ["RFC1918 172.16/12 lower bound", "https://172.16.0.1/internal"],
    ["RFC1918 172.16/12 upper bound", "https://172.31.255.254/internal"],
    ["RFC1918 192.168/16", "https://192.168.1.1/internal"],
    ["carrier-grade NAT 100.64/10", "https://100.64.0.1/internal"],
    ["unspecified 0.0.0.0/8", "https://0.0.0.0/internal"],
    ["multicast", "https://224.0.0.1/internal"],
    ["broadcast", "https://255.255.255.255/internal"],
  ];

  for (const [label, url] of rejected) {
    it(`refuses ${label}`, () => {
      expect(classifyOutboundUrl(url)).toMatchObject({
        ok: false,
        reason: "non_public_host",
      });
    });
  }

  it("refuses 172.32.0.1 only if it is genuinely private (it is not)", () => {
    // Guards the /12 boundary arithmetic: 172.32 is outside RFC1918
    // and a mask that swallowed it would be silently over-blocking.
    expect(classifyOutboundUrl("https://172.32.0.1/hooks").ok).toBe(true);
    expect(classifyOutboundUrl("https://172.15.0.1/hooks").ok).toBe(true);
  });

  it("refuses obfuscated numeric spellings of loopback", () => {
    // The WHATWG parser folds every one of these to 127.0.0.1, which
    // is exactly why validation runs on the parsed host and not the
    // raw string a `startsWith` check would see.
    for (const url of ["https://2130706433/", "https://0x7f.1/", "https://0177.0.0.1/"]) {
      expect(classifyOutboundUrl(url)).toMatchObject({ reason: "non_public_host" });
    }
  });
});

describe("classifyOutboundUrl — non-public IPv6", () => {
  const rejected: ReadonlyArray<readonly [string, string]> = [
    ["IPv6 loopback", "https://[::1]/admin"],
    ["IPv6 unspecified", "https://[::]/admin"],
    ["IPv6 unique-local fd00::/8", "https://[fd00::1]/internal"],
    ["IPv6 unique-local fc00::/7 lower half", "https://[fc00::1]/internal"],
    ["IPv6 link-local fe80::/10", "https://[fe80::1]/internal"],
    ["IPv6 multicast", "https://[ff02::1]/internal"],
    ["IPv6 documentation", "https://[2001:db8::1]/internal"],
    ["NAT64 translation prefix", "https://[64:ff9b::a00:1]/internal"],
    ["6to4 prefix", "https://[2002:a00:1::]/internal"],
  ];

  for (const [label, url] of rejected) {
    it(`refuses ${label}`, () => {
      expect(classifyOutboundUrl(url)).toMatchObject({
        ok: false,
        reason: "non_public_host",
      });
    });
  }

  it("refuses IPv4-mapped IPv6 wrapping a private address", () => {
    // The parser rewrites [::ffff:127.0.0.1] to [::ffff:7f00:1], so
    // the guard has to unwrap the low 32 bits rather than pattern
    // match the dotted form.
    expect(classifyOutboundUrl("https://[::ffff:127.0.0.1]/admin")).toMatchObject({
      reason: "non_public_host",
    });
    expect(classifyOutboundUrl("https://[::ffff:a9fe:a9fe]/latest/meta-data/")).toMatchObject({
      reason: "non_public_host",
    });
    expect(classifyOutboundUrl("https://[::ffff:10.0.0.1]/internal")).toMatchObject({
      reason: "non_public_host",
    });
  });

  it("accepts a globally routable IPv6 literal", () => {
    expect(classifyOutboundUrl("https://[2606:4700:4700::1111]/hooks").ok).toBe(true);
  });
});

describe("classifyOutboundUrl — local hostnames", () => {
  const rejected: ReadonlyArray<readonly [string, string]> = [
    ["localhost", "https://localhost/admin"],
    ["localhost with a trailing dot", "https://localhost./admin"],
    ["a .localhost subdomain", "https://api.localhost/admin"],
    ["an mDNS .local name", "https://printer.local/admin"],
    ["an .internal name", "https://vault.internal/admin"],
    ["an AWS-style compute.internal name", "https://ip-10-0-0-7.eu-west-1.compute.internal/x"],
    ["a single-label hostname", "https://intranet/admin"],
  ];

  for (const [label, url] of rejected) {
    it(`refuses ${label}`, () => {
      expect(classifyOutboundUrl(url)).toMatchObject({
        ok: false,
        reason: "non_public_host",
      });
    });
  }

  it("does not over-block names that merely contain a local-ish label", () => {
    // `local` as an interior label is ordinary; only the suffix is
    // special. Over-blocking here would break real partners.
    expect(classifyOutboundUrl("https://local.example.com/hooks").ok).toBe(true);
    expect(classifyOutboundUrl("https://internal-api.example.com/hooks").ok).toBe(true);
  });
});

describe("classifyOutboundUrl — unparseable input", () => {
  it("refuses a string the URL parser rejects", () => {
    // Zod's z.url() screens most of these first; the guard fails
    // closed rather than trusting that ordering.
    expect(classifyOutboundUrl("https://")).toMatchObject({
      ok: false,
      reason: "unparseable",
    });
    expect(classifyOutboundUrl("not a url at all")).toMatchObject({ reason: "unparseable" });
  });
});
