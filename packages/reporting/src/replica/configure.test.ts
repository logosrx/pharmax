import { afterEach, describe, expect, it } from "vitest";

import {
  configureReportReadScope,
  getReportReadScope,
  resetReportReadScopeConfigurationForTests,
  type ReportReadScope,
} from "./configure.js";

afterEach(() => resetReportReadScopeConfigurationForTests());

function scope(usingReplica: boolean): ReportReadScope {
  return {
    usingReplica,
    read: async (_org, fn) => fn({}),
  };
}

describe("configureReportReadScope", () => {
  it("returns null when unconfigured", () => {
    expect(getReportReadScope()).toBeNull();
  });

  it("returns the configured scope", () => {
    const s = scope(true);
    configureReportReadScope(s);
    expect(getReportReadScope()).toBe(s);
    expect(getReportReadScope()?.usingReplica).toBe(true);
  });

  it("is idempotent for the same instance", () => {
    const s = scope(false);
    configureReportReadScope(s);
    expect(() => configureReportReadScope(s)).not.toThrow();
  });

  it("throws when swapping to a different instance", () => {
    configureReportReadScope(scope(true));
    expect(() => configureReportReadScope(scope(false))).toThrow();
  });

  it("read() delegates to the configured implementation", async () => {
    let calls = 0;
    configureReportReadScope({
      usingReplica: true,
      read: <T>(_org: string, fn: (c: unknown) => Promise<T>) => {
        calls += 1;
        return fn({ marker: "replica-client" });
      },
    });
    const result = await getReportReadScope()!.read("org-1", async (c) => c);
    expect(calls).toBe(1);
    expect(result).toEqual({ marker: "replica-client" });
  });
});
