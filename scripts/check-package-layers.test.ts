// Unit tests for the package-layer fitness function.
//
// Exercises the pure `analyzePackageGraph` against synthetic graphs:
// clean DAGs pass, cycles are detected (and ignored edges respected),
// and domain->domain isolation is enforced with an allowlist. Also
// runs the analyzer against the REAL on-disk graph as a regression
// sentinel so the live workspace stays clean.

import { describe, expect, it } from "vitest";

import {
  analyzePackageGraph,
  buildPackageGraphFromDisk,
  type AnalyzeConfig,
  type PackageGraph,
} from "./check-package-layers.js";

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const EMPTY_CONFIG: AnalyzeConfig = {
  ignoredEdges: [],
  domainPackages: new Set(),
  allowedDomainEdges: new Set(),
};

describe("analyzePackageGraph — cycle detection", () => {
  it("reports no cycles for a clean DAG", () => {
    const graph: PackageGraph = {
      a: ["b", "c"],
      b: ["c"],
      c: [],
    };
    const { cycles } = analyzePackageGraph(graph, EMPTY_CONFIG);
    expect(cycles).toEqual([]);
  });

  it("detects a direct two-node cycle", () => {
    const graph: PackageGraph = {
      a: ["b"],
      b: ["a"],
    };
    const { cycles } = analyzePackageGraph(graph, EMPTY_CONFIG);
    expect(cycles.length).toBe(1);
    expect(new Set(cycles[0])).toEqual(new Set(["a", "b"]));
  });

  it("detects a longer cycle", () => {
    const graph: PackageGraph = {
      a: ["b"],
      b: ["c"],
      c: ["a"],
    };
    const { cycles } = analyzePackageGraph(graph, EMPTY_CONFIG);
    expect(cycles.length).toBe(1);
    expect(new Set(cycles[0])).toEqual(new Set(["a", "b", "c"]));
  });

  it("reports a shared cycle only once regardless of entry order", () => {
    const graph: PackageGraph = {
      a: ["b"],
      b: ["a"],
      z: ["a"], // extra entry point into the same loop
    };
    const { cycles } = analyzePackageGraph(graph, EMPTY_CONFIG);
    expect(cycles.length).toBe(1);
  });

  it("respects ignoredEdges — the exempt back-edge is not a cycle", () => {
    const graph: PackageGraph = {
      database: ["tenancy"],
      tenancy: ["database"], // type-only, exempt
    };
    const { cycles } = analyzePackageGraph(graph, {
      ...EMPTY_CONFIG,
      ignoredEdges: [{ from: "tenancy", to: "database" }],
    });
    expect(cycles).toEqual([]);
  });

  it("still flags a cycle that does NOT use the ignored edge", () => {
    const graph: PackageGraph = {
      database: ["tenancy"],
      tenancy: ["database"], // exempt
      a: ["b"],
      b: ["a"], // not exempt
    };
    const { cycles } = analyzePackageGraph(graph, {
      ...EMPTY_CONFIG,
      ignoredEdges: [{ from: "tenancy", to: "database" }],
    });
    expect(cycles.length).toBe(1);
    expect(new Set(cycles[0])).toEqual(new Set(["a", "b"]));
  });

  it("ignores edges that point to external (unknown) packages", () => {
    const graph: PackageGraph = {
      a: ["b", "zod", "@external/thing"],
      b: [],
    };
    const { cycles } = analyzePackageGraph(graph, EMPTY_CONFIG);
    expect(cycles).toEqual([]);
  });
});

describe("analyzePackageGraph — domain isolation", () => {
  const domainPackages = new Set(["orders", "fill", "labels", "scan", "verification"]);

  it("permits a domain importing a shared (non-domain) package", () => {
    const graph: PackageGraph = {
      orders: ["command-bus", "sla"],
      "command-bus": [],
      sla: [],
    };
    const { domainViolations } = analyzePackageGraph(graph, {
      ...EMPTY_CONFIG,
      domainPackages,
    });
    expect(domainViolations).toEqual([]);
  });

  it("flags a domain importing a sibling domain not on the allowlist", () => {
    const graph: PackageGraph = {
      billing: ["shipping"],
      shipping: [],
    };
    const { domainViolations } = analyzePackageGraph(graph, {
      ...EMPTY_CONFIG,
      domainPackages: new Set(["billing", "shipping"]),
    });
    expect(domainViolations).toEqual([{ from: "billing", to: "shipping" }]);
  });

  it("permits an allowlisted domain -> domain edge", () => {
    const graph: PackageGraph = {
      fill: ["labels", "scan"],
      scan: ["labels"],
      labels: [],
    };
    const { domainViolations } = analyzePackageGraph(graph, {
      ...EMPTY_CONFIG,
      domainPackages,
      allowedDomainEdges: new Set(["fill -> labels", "fill -> scan", "scan -> labels"]),
    });
    expect(domainViolations).toEqual([]);
  });
});

describe("real workspace graph (regression sentinel)", () => {
  it("the live @pharmax graph is acyclic and domain-isolated", () => {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const graph = buildPackageGraphFromDisk(root);

    // Sanity: we actually read the workspace.
    expect(Object.keys(graph).length).toBeGreaterThan(20);
    expect(graph["@pharmax/command-bus"]).toBeDefined();

    const { cycles, domainViolations } = analyzePackageGraph(graph, {
      ignoredEdges: [{ from: "@pharmax/tenancy", to: "@pharmax/database" }],
      domainPackages: new Set([
        "@pharmax/orders",
        "@pharmax/fill",
        "@pharmax/verification",
        "@pharmax/shipping",
        "@pharmax/billing",
        "@pharmax/patients",
        "@pharmax/providers",
        "@pharmax/orgs",
        "@pharmax/reporting",
        "@pharmax/package-capture",
        "@pharmax/labels",
        "@pharmax/scan",
        "@pharmax/security",
      ]),
      allowedDomainEdges: new Set([
        "@pharmax/fill -> @pharmax/labels",
        "@pharmax/fill -> @pharmax/scan",
        "@pharmax/scan -> @pharmax/labels",
      ]),
    });

    expect(cycles).toEqual([]);
    expect(domainViolations).toEqual([]);
  });
});
