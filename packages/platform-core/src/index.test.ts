import { describe, expect, it } from "vitest";
import { platformCore } from "./index.js";

describe("platformCore", () => {
  it("exposes the package marker", () => {
    expect(platformCore.name).toBe("@pharmax/platform-core");
    expect(platformCore.description).toContain("platform primitives");
  });
});
