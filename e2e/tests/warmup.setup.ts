// Route warm-up — a setup project the real suites depend on.
//
// The webServer runs `next dev`, which compiles each route lazily on
// its FIRST request (see playwright.config.ts for why a production
// build is not an option here). That compile is pure infrastructure
// cost, but without this file it lands INSIDE whichever assertion
// happens to touch the route first, so a test measuring "does
// StartTyping apply?" is really measuring "does StartTyping apply,
// plus a webpack compile of the ops command stack?".
//
// That is what made the D1 suite fail in CI while passing locally.
// The budget for an action POST went 20s → 60s chasing it, and the
// runs that "hung" were the ones with a cold `.next` — a fresh
// worktree, or any CI runner, where nothing is cached. A local
// worktree with a warm 369MB `.next` never reproduced it.
//
// Warming here moves that cost onto its own clock, once, where it is
// labelled for what it is.
//
// How a warm request stays harmless: it is a GET against a POST-only
// action route. Next has to load the route module to discover which
// methods it exports before it can answer 405, so the module compiles
// and not one line of the handler runs.
//
// Getting that far needs a session COOKIE but not a session. `proxy.ts`
// redirects operator routes when no `pharmax_session` cookie is
// present, and it redirects before Next resolves the route, so an
// anonymous warm request compiles nothing at all — the first version
// of this file "warmed" 33 routes in 6.3s and left every one of them
// cold. A placeholder cookie gets the request past the proxy; the
// route's own `resolveOperatorTenancyContext` then rejects it, because
// the proxy's presence check is a filter, not the authorisation.
//
// The 405 assertion below is what keeps this honest. A warm-up that
// silently stops warming is worse than no warm-up: the cost quietly
// moves back into the tests and the next person re-debugs a timeout
// that looks like a product hang. 405 can only come from the route
// module itself, so it proves the compile happened.

import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { expect, test } from "@playwright/test";

import { E2E_ORG_BASE_URL } from "../env";

// Compiling the whole ops surface from scratch on a cold CI runner.
// Deliberately generous: the point is to absorb a slow compile, and a
// warm-up that times out tells us far less than one that reports how
// long each route actually took.
const WARMUP_TIMEOUT_MS = 900_000;
const PER_ROUTE_TIMEOUT_MS = 180_000;

// Well-formed but matches nothing. Every route below bounces on the
// invalid session (or on 405) long before it reads an id.
const PLACEHOLDER_ID = "00000000-0000-4000-8000-000000000000";

// Gets past proxy.ts's presence check so Next resolves the route and
// compiles it. Not a credential and not accepted as one: every route
// re-derives the operator from this value and refuses.
const WARMUP_COOKIE = "pharmax_session=warmup-not-a-session";

const ORDER_ACTIONS_DIR = fileURLToPath(
  new URL("../../apps/web/app/api/ops/orders/[orderId]", import.meta.url)
);

/**
 * Read the order action routes off disk rather than listing them.
 * A hand-maintained list silently goes stale the moment someone adds
 * an action, and a stale warm-up fails as a mystery timeout in an
 * unrelated test months later.
 */
function orderActionPaths(): ReadonlyArray<string> {
  return readdirSync(ORDER_ACTIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => `/api/ops/orders/${PLACEHOLDER_ID}/${entry.name}`)
    .sort();
}

/** Surfaces the suites navigate to, and the one non-order action. */
const OTHER_PATHS: ReadonlyArray<string> = [
  "/sign-in",
  "/ops",
  "/ops/typing",
  "/ops/pv1",
  "/ops/fill",
  `/ops/fill/${PLACEHOLDER_ID}`,
  "/ops/final",
  "/ops/shipping",
  "/ops/emergency",
  "/ops/prescriptions/new",
  `/ops/orders/${PLACEHOLDER_ID}`,
  "/api/ops/prescriptions/create",
];

test("warm the ops routes the dispense suites touch", async ({ request }) => {
  test.setTimeout(WARMUP_TIMEOUT_MS);

  const actionPaths = orderActionPaths();
  expect(
    actionPaths.length,
    "no order action routes found — did the route tree move?"
  ).toBeGreaterThan(0);

  const timings: Array<{ path: string; ms: number }> = [];

  const warm = async (path: string): Promise<number> => {
    const startedAt = Date.now();
    const response = await request.get(new URL(path, E2E_ORG_BASE_URL).toString(), {
      headers: { cookie: WARMUP_COOKIE },
      timeout: PER_ROUTE_TIMEOUT_MS,
      failOnStatusCode: false,
      // The redirect chain is noise here; the compile has already
      // happened by the time the route answers.
      maxRedirects: 0,
    });
    const ms = Date.now() - startedAt;
    timings.push({ path, ms });
    return response.status();
  };

  for (const path of actionPaths) {
    // 405 is the proof: only the compiled route module can answer it.
    // A redirect means proxy.ts intercepted and nothing compiled; a 404
    // means the disk-derived URL no longer maps to a route.
    expect(await warm(path), `warm ${path} should reach the route module`).toBe(405);
  }

  for (const path of OTHER_PATHS) {
    // Pages and the one GET-less non-order action answer in their own
    // ways (200, or a redirect to /sign-in from the page's own auth);
    // 404 is the only unambiguous "this never compiled".
    expect(await warm(path), `warm ${path}`).not.toBe(404);
  }

  // Printed because the interesting number in CI is which route ate
  // the cold compile, and how much of the wall clock it was.
  const total = timings.reduce((sum, entry) => sum + entry.ms, 0);
  const top = [...timings].sort((a, b) => b.ms - a.ms).slice(0, 5);
  console.warn(
    `[warmup] ${timings.length} routes in ${(total / 1000).toFixed(1)}s; slowest:\n` +
      top.map((entry) => `  ${(entry.ms / 1000).toFixed(1)}s  ${entry.path}`).join("\n")
  );
});
