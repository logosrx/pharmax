// Tests for the trusted-proxy client-IP resolver (pentest H4).
//
// The security property under test: a client can NEVER influence which
// address becomes the rate-limit key. We only ever trust the
// Nth-from-the-right forwarded entry (N = trusted hop count), and every
// ambiguous or short chain fails closed to `undefined` (the shared
// "unknown" bucket), never to a client-supplied value.

import { beforeEach, describe, expect, it, vi } from "vitest";

// Mutable env stand-in: `resolveClientIp` reads the hop count at call
// time, so each test sets the topology it exercises.
const envMock = vi.hoisted(() => ({ env: { TRUSTED_PROXY_HOP_COUNT: 0 } }));
vi.mock("@/server/env", () => envMock);

import { resolveClientIp } from "./client-ip.js";

function withXff(value: string | null): Request {
  const headers = new Headers();
  if (value !== null) headers.set("x-forwarded-for", value);
  return new Request("http://localhost/probe", { headers });
}

beforeEach(() => {
  envMock.env.TRUSTED_PROXY_HOP_COUNT = 0;
});

describe("resolveClientIp — fail-closed cases", () => {
  it("returns undefined when no proxy is trusted (hop count 0), even with a header", () => {
    envMock.env.TRUSTED_PROXY_HOP_COUNT = 0;
    expect(resolveClientIp(withXff("203.0.113.9"))).toBeUndefined();
  });

  it("returns undefined when the header is absent", () => {
    envMock.env.TRUSTED_PROXY_HOP_COUNT = 1;
    expect(resolveClientIp(withXff(null))).toBeUndefined();
  });

  it("returns undefined when the chain is shorter than the trusted hop count", () => {
    // Two proxies expected, only one entry present → the request did not
    // traverse the proxies we expect; the entry is client-influenced.
    envMock.env.TRUSTED_PROXY_HOP_COUNT = 2;
    expect(resolveClientIp(withXff("203.0.113.9"))).toBeUndefined();
  });

  it("returns undefined when the resolved entry is not IP-shaped", () => {
    envMock.env.TRUSTED_PROXY_HOP_COUNT = 1;
    expect(resolveClientIp(withXff("not-an-ip"))).toBeUndefined();
  });

  it("ignores a client-injected non-IP prefix and still fails closed on a bad trusted slot", () => {
    // hop=2 but the trusted (2nd-from-right) slot is junk a misconfigured
    // proxy wrote — refuse rather than trust it.
    envMock.env.TRUSTED_PROXY_HOP_COUNT = 2;
    expect(resolveClientIp(withXff("garbage, edge-ip"))).toBeUndefined();
  });
});

describe("resolveClientIp — one trusted hop (ALB-only tiers)", () => {
  beforeEach(() => {
    envMock.env.TRUSTED_PROXY_HOP_COUNT = 1;
  });

  it("reads the single right-most entry the proxy appended", () => {
    expect(resolveClientIp(withXff("198.51.100.7, 10.0.0.4"))).toBe("10.0.0.4");
  });

  it("ignores a spoofed left-hand entry an attacker prepends", () => {
    expect(resolveClientIp(withXff("1.2.3.4, 5.6.7.8, 10.0.0.4"))).toBe("10.0.0.4");
  });

  it("accepts a lone real entry", () => {
    expect(resolveClientIp(withXff("10.0.0.4"))).toBe("10.0.0.4");
  });
});

describe("resolveClientIp — two trusted hops (CloudFront -> ALB)", () => {
  beforeEach(() => {
    envMock.env.TRUSTED_PROXY_HOP_COUNT = 2;
  });

  it("reads the viewer address CloudFront appended (2nd from the right)", () => {
    // viewer, cloudfront-edge — ALB appends the edge, so viewer is 2nd
    // from the right.
    expect(resolveClientIp(withXff("203.0.113.9, 130.176.0.10"))).toBe("203.0.113.9");
  });

  it("ignores everything a client injects to the left of the trusted slot", () => {
    // spoof-a, spoof-b, viewer, cloudfront-edge
    expect(resolveClientIp(withXff("9.9.9.9, 8.8.8.8, 203.0.113.9, 130.176.0.10"))).toBe(
      "203.0.113.9"
    );
  });
});

describe("resolveClientIp — address shapes and hygiene", () => {
  beforeEach(() => {
    envMock.env.TRUSTED_PROXY_HOP_COUNT = 1;
  });

  it("tolerates surrounding whitespace and empty entries", () => {
    expect(resolveClientIp(withXff("  , 198.51.100.7 ,  10.0.0.4  "))).toBe("10.0.0.4");
  });

  it("accepts an IPv4 address with a port suffix", () => {
    expect(resolveClientIp(withXff("10.0.0.4:53512"))).toBe("10.0.0.4:53512");
  });

  it("accepts an IPv6 address", () => {
    expect(resolveClientIp(withXff("2001:db8::1"))).toBe("2001:db8::1");
  });
});
