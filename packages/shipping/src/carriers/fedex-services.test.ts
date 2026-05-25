import { describe, expect, it } from "vitest";

import {
  FEDEX_PACKAGING_TYPES,
  FEDEX_SERVICE_TYPES,
  findFedExPackaging,
  findFedExService,
} from "./fedex-services.js";

describe("FEDEX_SERVICE_TYPES", () => {
  it("has unique service codes", () => {
    const codes = FEDEX_SERVICE_TYPES.map((s) => s.code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it("includes the core US services", () => {
    const codes = FEDEX_SERVICE_TYPES.map((s) => s.code);
    expect(codes).toEqual(
      expect.arrayContaining([
        "FEDEX_GROUND",
        "GROUND_HOME_DELIVERY",
        "FEDEX_2_DAY",
        "STANDARD_OVERNIGHT",
        "PRIORITY_OVERNIGHT",
      ])
    );
  });

  it("findFedExService returns the registered entry for a known code", () => {
    expect(findFedExService("FEDEX_GROUND")?.label).toBe("FedEx Ground");
  });

  it("findFedExService returns undefined for an unknown code", () => {
    expect(findFedExService("DOES_NOT_EXIST")).toBeUndefined();
  });
});

describe("FEDEX_PACKAGING_TYPES", () => {
  it("has unique packaging codes", () => {
    const codes = FEDEX_PACKAGING_TYPES.map((p) => p.code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it("flags FEDEX_BOX as One Rate eligible up to 50 lbs", () => {
    const pkg = findFedExPackaging("FEDEX_BOX");
    expect(pkg).toBeDefined();
    expect(pkg!.oneRateEligible).toBe(true);
    expect(pkg!.oneRateMaxLbs).toBe(50);
  });

  it("flags YOUR_PACKAGING as NOT One Rate eligible", () => {
    const pkg = findFedExPackaging("YOUR_PACKAGING");
    expect(pkg!.oneRateEligible).toBe(false);
    expect(pkg!.oneRateMaxLbs).toBeNull();
  });
});
