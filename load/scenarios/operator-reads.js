// Operator queue-view / dashboard read path — SLO-4 in
// docs/observability/slos.md.
//
// Closed workload model (constant-vus): a fixed operator population
// cycling the server-rendered queue views with think time, the way a
// pharmacy shift actually uses the console. Authenticates with a
// staging operator's `pharmax_session` cookie.
//
//   WORKLOAD=smoke      1 VU x 1 iteration (default; syntax check)
//   WORKLOAD=pilot_1x   10 operators, ~15 s think time
//   WORKLOAD=pilot_5x   50 operators
//   WORKLOAD=pilot_10x  100 operators
//
// The SSE live-counts feed (GET /api/ops/queue/stream) is deliberately
// NOT exercised: k6's HTTP client does not consume event streams, and
// holding the connection open without reading it would measure
// nothing. Its freshness SLI is a documented gap in SLO-4.
//
// STAGING ONLY. See load/README.md.

/* global console */

import http from "k6/http";
import { check, sleep } from "k6";
import { Rate } from "k6/metrics";

import {
  operatorCookieHeader,
  operatorPopulationScenario,
  PILOT_BASELINE,
  requireStagingBaseUrl,
  resolveWorkload,
  sloThresholds,
  smokeScenario,
  SLO,
  workloadMultiplier,
} from "../lib/config.js";

const BASE_URL = requireStagingBaseUrl();
const WORKLOAD = resolveWorkload();

const readServerErrors = new Rate("operator_read_server_errors");

const TAG = "operator_read";

// The queue views a shift actually lives in (apps/web/app/ops/...).
// Weighted: the stage queues get visited more than admin surfaces.
const QUEUE_VIEWS = [
  "/ops",
  "/ops/orders",
  "/ops/typing",
  "/ops/pv1",
  "/ops/fill",
  "/ops/final",
  "/ops/shipping",
  "/ops/typing",
  "/ops/pv1",
  "/ops/fill",
];

export const options = {
  scenarios: {
    [WORKLOAD]:
      WORKLOAD === "smoke"
        ? smokeScenario({ exec: "browseQueues", tags: { endpoint: TAG } })
        : operatorPopulationScenario({
            exec: "browseQueues",
            vus: PILOT_BASELINE.concurrentOperators * workloadMultiplier(WORKLOAD),
            tags: { endpoint: TAG },
          }),
  },
  // Wired to SLO-4: p95 <= 800 ms, p99 <= 1500 ms, server-error rate
  // < 0.1% (99.9% availability).
  thresholds: Object.assign(sloThresholds(TAG, SLO.operatorRead), {
    [`checks{endpoint:${TAG}}`]: ["rate>0.99"],
  }),
};

export function setup() {
  operatorCookieHeader();
  console.warn(`operator-reads: workload=${WORKLOAD} target=${BASE_URL} — staging-only suite`);
}

export function browseQueues() {
  const path = QUEUE_VIEWS[Math.floor(Math.random() * QUEUE_VIEWS.length)];
  const res = http.get(`${BASE_URL}${path}`, {
    headers: operatorCookieHeader(),
    tags: { endpoint: TAG },
    // A redirect to /sign-in means the session expired: fail loudly
    // rather than load-testing the sign-in page by accident.
    redirects: 0,
  });

  readServerErrors.add(res.status >= 500);

  check(
    res,
    {
      "queue view rendered (200, not a sign-in redirect)": (r) => r.status === 200,
    },
    { endpoint: TAG }
  );

  // Think time: ~15 s +/- 33% jitter so the population does not sync
  // into lockstep waves.
  const think = PILOT_BASELINE.operatorThinkTimeSeconds;
  sleep(think * (0.67 + Math.random() * 0.66));
}
