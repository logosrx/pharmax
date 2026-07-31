// republish-dead-outbox CLI — pure helper contracts.

import { describe, expect, it } from "vitest";

import { buildRepublishWhere, parseCli, summarizeDeadRows } from "./republish-dead-outbox.js";

describe("buildRepublishWhere", () => {
  it("always pins status DEAD for id selections", () => {
    expect(buildRepublishWhere({ kind: "ids", ids: ["a", "b"] })).toEqual({
      status: "DEAD",
      id: { in: ["a", "b"] },
    });
  });

  it("always pins status DEAD for event-type selections, with optional org narrow", () => {
    expect(buildRepublishWhere({ kind: "event-type", eventType: "x.y.v1" })).toEqual({
      status: "DEAD",
      eventType: "x.y.v1",
    });
    expect(
      buildRepublishWhere({ kind: "event-type", eventType: "x.y.v1", organizationId: "org-1" })
    ).toEqual({
      status: "DEAD",
      eventType: "x.y.v1",
      organizationId: "org-1",
    });
  });
});

describe("summarizeDeadRows", () => {
  it("groups by (eventType, org) with count and oldest/newest timestamps", () => {
    const t1 = new Date("2026-07-01T00:00:00.000Z");
    const t2 = new Date("2026-07-02T00:00:00.000Z");
    const t3 = new Date("2026-07-03T00:00:00.000Z");
    const groups = summarizeDeadRows([
      { eventType: "a.v1", organizationId: "org-1", createdAt: t2 },
      { eventType: "a.v1", organizationId: "org-1", createdAt: t1 },
      { eventType: "a.v1", organizationId: "org-2", createdAt: t3 },
      { eventType: "b.v1", organizationId: "org-1", createdAt: t3 },
    ]);
    expect(groups).toEqual([
      { eventType: "a.v1", organizationId: "org-1", count: 2, oldest: t1, newest: t2 },
      { eventType: "a.v1", organizationId: "org-2", count: 1, oldest: t3, newest: t3 },
      { eventType: "b.v1", organizationId: "org-1", count: 1, oldest: t3, newest: t3 },
    ]);
  });

  it("returns empty for no rows", () => {
    expect(summarizeDeadRows([])).toEqual([]);
  });
});

describe("parseCli", () => {
  it("defaults to list mode with no selector args", () => {
    expect(parseCli([])).toEqual({ mode: "list", confirmed: false });
    expect(parseCli(["--list"])).toEqual({ mode: "list", confirmed: false });
  });

  it("rejects --ids combined with --event-type", () => {
    const r = parseCli(["--ids=a", "--event-type=x.y.v1"]);
    expect(r).toHaveProperty("error");
  });

  it("parses an ids selector and requires --yes to confirm", () => {
    const unconfirmed = parseCli(["--ids=a, b ,c"]);
    expect(unconfirmed).toEqual({
      mode: "republish",
      selector: { kind: "ids", ids: ["a", "b", "c"] },
      confirmed: false,
    });
    const confirmed = parseCli(["--ids=a", "--yes"]);
    expect(confirmed).toMatchObject({ mode: "republish", confirmed: true });
  });

  it("parses an event-type selector with optional org", () => {
    expect(parseCli(["--event-type=x.y.v1", "--org=org-1", "--yes"])).toEqual({
      mode: "republish",
      selector: { kind: "event-type", eventType: "x.y.v1", organizationId: "org-1" },
      confirmed: true,
    });
  });
});
