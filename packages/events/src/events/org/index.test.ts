// Domain-level test for org.* event definitions.

import { describe, expect, it } from "vitest";

import * as OrgEvents from "./index.js";

const ALL = Object.values(OrgEvents);

describe("org domain barrel", () => {
  it("5 org.* events are registered", () => {
    expect(ALL.length).toBe(5);
  });

  it("every org.* event is owned by `orgs`", () => {
    for (const def of ALL) {
      expect(def.owner, `${def.fullName} owner`).toBe("orgs");
    }
  });

  it("every org.* event is PHI-free", () => {
    for (const def of ALL) {
      expect(def.phiSafe, `${def.fullName} phiSafe`).toBe(true);
    }
  });
});
