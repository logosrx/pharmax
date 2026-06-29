#!/usr/bin/env tsx
// scripts/check-package-layers.ts
//
// Pre-merge guard for the package dependency graph. Two invariants:
//
//   1. ACYCLIC — the internal `@pharmax/*` dependency graph must be a
//      DAG. A cycle between packages is the seed of a spider web: it
//      makes build order ambiguous, defeats incremental typechecking,
//      and means two packages can no longer be reasoned about (or
//      extracted) independently.
//
//      ONE edge is deliberately exempt: `@pharmax/tenancy ->
//      @pharmax/database`. The tenancy package imports ONLY Prisma
//      *types* (`PrismaClient`, `Prisma`) from database, while
//      database imports tenancy's runtime extension. The cycle is
//      therefore type-only at the tenancy end and is broken at
//      compile time (see packages/tenancy/src/session-guc.ts, which
//      documents the intent). We model that by IGNORING this single
//      edge during cycle detection so the runtime graph
//      (database -> tenancy) is what gets enforced as acyclic. Any
//      OTHER cycle fails the build.
//
//   2. DOMAIN ISOLATION — a business "domain" package may not import a
//      sibling domain package unless the edge is on the allowlist
//      below. Domains own a slice of the order workflow; letting them
//      reach into each other freely is exactly how a modular monolith
//      rots into a ball of mud. Shared/infra packages (command-bus,
//      workflow, sla, rbac, tenancy, database, crypto, audit, ...)
//      are NOT domains and may be imported by anyone above them.
//
//      Adding an entry to ALLOWED_DOMAIN_EDGES is an ARCHITECTURE
//      REVIEW EVENT: it must carry a one-line justification and is the
//      moment to ask "should this shared concept live in a lower
//      tier instead?" (see docs/ARCHITECTURE_PRINCIPLES.md §D).
//
// Exit codes:
//   0  Graph is acyclic and domain isolation holds.
//   1  One or more violations found.
//   2  Internal error (filesystem / parse failure).
//
// Pairs with: scripts/check-raw-prisma-usage.ts (tenancy boundary),
// scripts/check-command-files.ts (bus enforcement),
// scripts/check-migration-rls.ts (RLS coverage).

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PHARMAX_SCOPE = "@pharmax/";

/** Directed edge in the package graph. */
export interface Edge {
  readonly from: string;
  readonly to: string;
}

/** Adjacency map: package name -> its internal `@pharmax/*` deps. */
export type PackageGraph = Readonly<Record<string, ReadonlyArray<string>>>;

export interface AnalyzeConfig {
  /**
   * Edges removed from the graph BEFORE cycle detection. Each entry
   * is a known, deliberate, type-only back-edge. Keep this list
   * short — every entry is a cycle we have chosen to tolerate.
   */
  readonly ignoredEdges: ReadonlyArray<Edge>;
  /** Packages classified as business domains (subject to isolation). */
  readonly domainPackages: ReadonlySet<string>;
  /** Permitted domain -> domain edges, keyed "from -> to". */
  readonly allowedDomainEdges: ReadonlySet<string>;
}

export interface AnalyzeResult {
  /** Each cycle as the ordered list of packages forming the loop. */
  readonly cycles: ReadonlyArray<ReadonlyArray<string>>;
  /** Disallowed domain -> domain edges. */
  readonly domainViolations: ReadonlyArray<Edge>;
}

// ---------------------------------------------------------------------------
// Configuration — the frozen architecture contract
// ---------------------------------------------------------------------------

// Type-only back-edge. tenancy imports `PrismaClient`/`Prisma` types
// from database; database imports tenancy's runtime extension. Broken
// at compile time. See packages/tenancy/src/session-guc.ts.
const IGNORED_EDGES: ReadonlyArray<Edge> = [{ from: "@pharmax/tenancy", to: "@pharmax/database" }];

// Business domains: each owns a slice of the order lifecycle or a
// capability that is conceptually a sibling of one. Cross-cutting
// infrastructure (command-bus, workflow, sla, rbac, audit, tenancy,
// database, crypto, telemetry, cache, events, notifications,
// platform-core, documents, composition) is intentionally NOT here —
// those are meant to be depended upon from above.
const DOMAIN_PACKAGES: ReadonlySet<string> = new Set([
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
]);

// The CURRENT, frozen set of domain -> domain edges. Each is allowed
// for the stated reason; the Tier-2 architecture plan aims to remove
// the verification -> orders edge by moving the shared event->permission
// translator into a neutral contract package. Until then it is a
// conscious allow, not an accident.
const ALLOWED_DOMAIN_EDGES: ReadonlySet<string> = new Set([
  // fill prints vial labels as part of the FILL stage.
  "@pharmax/fill -> @pharmax/labels",
  // fill validates barcode scans (drug/lot) during filling.
  "@pharmax/fill -> @pharmax/scan",
  // scan validates a scanned barcode against the label's encoded content.
  "@pharmax/scan -> @pharmax/labels",
]);

// ---------------------------------------------------------------------------
// Pure analysis (unit-testable, no filesystem)
// ---------------------------------------------------------------------------

function edgeKey(from: string, to: string): string {
  return `${from} -> ${to}`;
}

/**
 * Detect every cycle reachable in `graph`, after removing
 * `ignoredEdges`, and collect disallowed domain->domain edges.
 *
 * Cycle detection is a depth-first walk tracking the current path;
 * when an edge points back into a node on the active path we record
 * the loop slice. The `finished` set prevents re-reporting the same
 * SCC from multiple entry points.
 */
export function analyzePackageGraph(graph: PackageGraph, config: AnalyzeConfig): AnalyzeResult {
  const ignored = new Set(config.ignoredEdges.map((e) => edgeKey(e.from, e.to)));

  const cycles: string[][] = [];
  const seenCycleSignatures = new Set<string>();
  const onPath: string[] = [];
  const onPathSet = new Set<string>();
  const finished = new Set<string>();

  function visit(node: string): void {
    onPath.push(node);
    onPathSet.add(node);

    for (const dep of graph[node] ?? []) {
      if (ignored.has(edgeKey(node, dep))) continue;
      if (graph[dep] === undefined) continue; // external / unknown node
      if (onPathSet.has(dep)) {
        const startIdx = onPath.indexOf(dep);
        const loop = onPath.slice(startIdx);
        // Canonical signature so the same loop entered from different
        // nodes is reported once.
        const signature = [...loop].sort((a, b) => a.localeCompare(b)).join("|");
        if (!seenCycleSignatures.has(signature)) {
          seenCycleSignatures.add(signature);
          cycles.push([...loop, dep]);
        }
        continue;
      }
      if (!finished.has(dep)) {
        visit(dep);
      }
    }

    onPath.pop();
    onPathSet.delete(node);
    finished.add(node);
  }

  for (const node of Object.keys(graph)) {
    if (!finished.has(node)) visit(node);
  }

  const domainViolations: Edge[] = [];
  for (const [from, deps] of Object.entries(graph)) {
    if (!config.domainPackages.has(from)) continue;
    for (const to of deps) {
      if (!config.domainPackages.has(to)) continue;
      if (config.allowedDomainEdges.has(edgeKey(from, to))) continue;
      domainViolations.push({ from, to });
    }
  }

  return { cycles, domainViolations };
}

// ---------------------------------------------------------------------------
// Disk reader
// ---------------------------------------------------------------------------

/**
 * Build the internal dependency graph by reading every workspace
 * `package.json` under `packages/` and `apps/`. Only `@pharmax/*`
 * entries from `dependencies` + `devDependencies` become edges;
 * third-party deps are ignored.
 */
export function buildPackageGraphFromDisk(rootDir: string): PackageGraph {
  const manifests: string[] = [];
  for (const top of ["packages", "apps"]) {
    const base = join(rootDir, top);
    let entries: string[];
    try {
      entries = readdirSync(base);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const pkgJson = join(base, entry, "package.json");
      try {
        if (statSync(pkgJson).isFile()) manifests.push(pkgJson);
      } catch {
        // no package.json in this dir; skip.
      }
    }
  }

  const graph: Record<string, string[]> = {};
  for (const manifestPath of manifests) {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      name?: string;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const name = manifest.name;
    if (name === undefined) continue;
    const deps = new Set<string>();
    for (const group of [manifest.dependencies, manifest.devDependencies]) {
      for (const dep of Object.keys(group ?? {})) {
        if (dep.startsWith(PHARMAX_SCOPE)) deps.add(dep);
      }
    }
    graph[name] = [...deps];
  }
  return graph;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const graph = buildPackageGraphFromDisk(root);
  const { cycles, domainViolations } = analyzePackageGraph(graph, {
    ignoredEdges: IGNORED_EDGES,
    domainPackages: DOMAIN_PACKAGES,
    allowedDomainEdges: ALLOWED_DOMAIN_EDGES,
  });

  const pkgCount = Object.keys(graph).length;
  let failed = false;

  if (cycles.length > 0) {
    failed = true;
    process.stderr.write(`[check-package-layers] ${cycles.length} dependency cycle(s):\n`);
    for (const cycle of cycles) {
      process.stderr.write(`  ${cycle.join(" -> ")}\n`);
    }
    process.stderr.write(
      "    A cycle makes these packages inseparable. Break it by extracting the\n" +
        "    shared piece into a lower-tier package, or — if it is a deliberate\n" +
        "    type-only edge — add it to IGNORED_EDGES with a justification.\n"
    );
  }

  if (domainViolations.length > 0) {
    failed = true;
    process.stderr.write(
      `[check-package-layers] ${domainViolations.length} disallowed domain -> domain edge(s):\n`
    );
    for (const v of domainViolations) {
      process.stderr.write(`  ${v.from} -> ${v.to}\n`);
    }
    process.stderr.write(
      "    Domains must not import sibling domains. Either move the shared concept\n" +
        "    into a lower tier (preferred), or add the edge to ALLOWED_DOMAIN_EDGES\n" +
        "    in scripts/check-package-layers.ts with a one-line justification.\n"
    );
  }

  if (failed) {
    process.exit(1);
  }

  process.stdout.write(
    `[check-package-layers] ok — ${pkgCount} package(s): graph is acyclic, domain isolation holds\n`
  );
}

const RUNNING_AS_SCRIPT = process.argv[1] === fileURLToPath(import.meta.url);
if (RUNNING_AS_SCRIPT) {
  main().catch((err) => {
    process.stderr.write(`[check-package-layers] internal error: ${String(err)}\n`);
    process.exit(2);
  });
}
