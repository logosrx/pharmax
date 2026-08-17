// Redirect helper tests.
//
// The property under test is narrow and load-bearing: NOTHING this
// module emits may leave the origin the operator is on, and what it
// emits must be resolvable by a browser. The bug it replaces failed
// the second half — `Location: http://internal/ops/typing` stranded
// every operator on a network-error page after a successful command.

import { describe, expect, it } from "vitest";

import { sameOriginPath, seeOther } from "./redirect.js";

function locationOf(response: Response): string {
  const location = response.headers.get("location");
  expect(location).not.toBeNull();
  return location as string;
}

describe("sameOriginPath", () => {
  it("keeps a plain path unchanged", () => {
    expect(sameOriginPath("/ops/typing")).toBe("/ops/typing");
  });

  it("preserves a query string the caller already composed", () => {
    expect(sameOriginPath("/ops/pv1?orderId=abc")).toBe("/ops/pv1?orderId=abc");
  });

  it("strips the origin from an absolute url", () => {
    expect(sameOriginPath("https://evil.example/ops/typing")).toBe("/ops/typing");
  });

  it("strips the host from a protocol-relative url", () => {
    // `//evil.example/x` is the classic open-redirect payload: it is a
    // URL, not a path, and resolving it against any base yields a
    // different origin. Keeping only the path defuses it.
    expect(sameOriginPath("//evil.example/x")).toBe("/x");
  });

  it("never returns a value that parses as an absolute url", () => {
    for (const target of [
      "/ops/fill",
      "//evil.example/ops/fill",
      "https://evil.example/ops/fill",
      "http://internal/ops/fill",
    ]) {
      const path = sameOriginPath(target);
      expect(path.startsWith("/")).toBe(true);
      expect(path.startsWith("//")).toBe(false);
      expect(() => new URL(path)).toThrow();
    }
  });

  it("drops CR/LF so a target cannot inject a second header", () => {
    const path = sameOriginPath("/ops/typing\r\nX-Injected: 1");
    expect(path).not.toContain("\r");
    expect(path).not.toContain("\n");
  });
});

describe("seeOther", () => {
  it("responds 303 so the browser re-issues the follow-up as GET", () => {
    // 302 would let a refresh re-POST a command that already applied.
    expect(seeOther("/ops/typing").status).toBe(303);
  });

  it("emits a relative Location, never the old http://internal base", () => {
    const location = locationOf(seeOther("/ops/typing"));
    expect(location).toBe("/ops/typing");
    expect(location).not.toContain("internal");
  });

  it("sets extra params on top of a target that already has a query", () => {
    // The failure path appends `error` to targets like
    // `/ops/pv1?orderId=abc`; string templating produced `?a=1?error=…`.
    const location = locationOf(seeOther("/ops/pv1?orderId=abc", { error: "PV1_DENIED: nope" }));
    const url = new URL(location, "http://test.invalid");
    expect(url.pathname).toBe("/ops/pv1");
    expect(url.searchParams.get("orderId")).toBe("abc");
    expect(url.searchParams.get("error")).toBe("PV1_DENIED: nope");
    expect(location.match(/\?/g)).toHaveLength(1);
  });

  it("percent-encodes param values rather than emitting them raw", () => {
    const location = locationOf(seeOther("/ops/reports", { error: "a b&c=d" }));
    expect(location).not.toContain("a b&c=d");
    expect(new URL(location, "http://test.invalid").searchParams.get("error")).toBe("a b&c=d");
  });

  it("drops empty-string params so optional flash fields can be passed through", () => {
    const location = locationOf(seeOther("/ops/shipping", { error: "", note: "kept" }));
    const url = new URL(location, "http://test.invalid");
    expect(url.searchParams.has("error")).toBe(false);
    expect(url.searchParams.get("note")).toBe("kept");
  });

  it("cannot be made to redirect off-origin through the target", () => {
    expect(locationOf(seeOther("https://evil.example/steal"))).toBe("/steal");
    expect(locationOf(seeOther("//evil.example/steal"))).toBe("/steal");
  });
});
