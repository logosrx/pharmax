// Mixed pilot workload — the realistic composite of what a live pilot
// site puts on the platform at once:
//
//   1. Partner EHR prescription submissions (open model, SLO-1)
//      POST /api/v1/prescriptions
//   2. Partner EHR order-status polling (open model, SLO-1 companion)
//      GET /api/v1/orders?limit=50 — how integrated EHRs sync state
//   3. Operator queue-view browsing (closed model, SLO-4)
//      GET /ops/... with a session cookie
//
// Ratios at 1x (see docs/observability/slos.md, "Assumed pilot
// baseline"): 3 submissions/min + 3 partner polls/min + 10 operators
// at ~4 reads/min each ≈ 1 write : ~15 reads. Every accepted
// submission also enqueues a `prescription.created.v1` outbox row, so
// this scenario indirectly loads the worker drain (SLO-3) — watch
// pharmax_outbox_claim_lag_seconds / OutboxOldestUndispatchedAgeSeconds
// on the staging dashboards during the run.
//
//   WORKLOAD=smoke      1 iteration of each traffic class (default)
//   WORKLOAD=pilot_1x   assumed pilot design peak
//   WORKLOAD=pilot_5x   5x pilot
//   WORKLOAD=pilot_10x  10x pilot
//
// STAGING ONLY. See load/README.md.

/* global console */

import http from "k6/http";
import { check, sleep } from "k6";
import { Counter, Rate } from "k6/metrics";

import {
  arrivalRateScenario,
  idempotencyKey,
  operatorCookieHeader,
  operatorPopulationScenario,
  partnerHeaders,
  PILOT_BASELINE,
  requireStagingBaseUrl,
  resolveWorkload,
  sloThresholds,
  smokeScenario,
  SLO,
  workloadMultiplier,
} from "../lib/config.js";
import { prescriptionPayload, requireSeedIdentifiers } from "../lib/synthetic.js";

const BASE_URL = requireStagingBaseUrl();
const WORKLOAD = resolveWorkload();
const MULTIPLIER = workloadMultiplier(WORKLOAD);

const intakeServerErrors = new Rate("partner_intake_server_errors");
const intakeRateLimited = new Counter("partner_intake_rate_limited");
const pollServerErrors = new Rate("partner_poll_server_errors");
const readServerErrors = new Rate("operator_read_server_errors");

const INTAKE_TAG = "partner_intake";
const POLL_TAG = "partner_poll";
const READ_TAG = "operator_read";

const QUEUE_VIEWS = [
  "/ops",
  "/ops/orders",
  "/ops/typing",
  "/ops/pv1",
  "/ops/fill",
  "/ops/final",
  "/ops/shipping",
];

function buildScenarios() {
  if (WORKLOAD === "smoke") {
    return {
      smoke_intake: smokeScenario({ exec: "submitPrescription", tags: { endpoint: INTAKE_TAG } }),
      smoke_poll: smokeScenario({ exec: "pollOrders", tags: { endpoint: POLL_TAG } }),
      smoke_reads: smokeScenario({ exec: "browseQueues", tags: { endpoint: READ_TAG } }),
    };
  }
  return {
    partner_intake: arrivalRateScenario({
      exec: "submitPrescription",
      ratePerMinute: PILOT_BASELINE.intakePerMinute * MULTIPLIER,
      tags: { endpoint: INTAKE_TAG },
    }),
    partner_order_polling: arrivalRateScenario({
      exec: "pollOrders",
      ratePerMinute: PILOT_BASELINE.partnerOrderPollsPerMinute * MULTIPLIER,
      tags: { endpoint: POLL_TAG },
    }),
    operator_reads: operatorPopulationScenario({
      exec: "browseQueues",
      vus: PILOT_BASELINE.concurrentOperators * MULTIPLIER,
      tags: { endpoint: READ_TAG },
    }),
  };
}

export const options = {
  scenarios: buildScenarios(),
  // Each traffic class carries its own SLO bar; a mixed run fails if
  // ANY of them misses under composite load.
  thresholds: Object.assign(
    sloThresholds(INTAKE_TAG, SLO.partnerIntake),
    sloThresholds(POLL_TAG, SLO.partnerRead),
    sloThresholds(READ_TAG, SLO.operatorRead),
    {
      [`checks{endpoint:${INTAKE_TAG}}`]: ["rate>0.99"],
      [`checks{endpoint:${POLL_TAG}}`]: ["rate>0.99"],
      [`checks{endpoint:${READ_TAG}}`]: ["rate>0.99"],
    }
  ),
};

export function setup() {
  partnerHeaders();
  operatorCookieHeader();
  const seed = requireSeedIdentifiers();
  console.warn(`mixed-pilot: workload=${WORKLOAD} target=${BASE_URL} — staging-only suite`);
  return { seed };
}

// ---- Traffic class 1: partner prescription submissions ---------------

export function submitPrescription(data) {
  const payload = prescriptionPayload(data.seed);
  const res = http.post(`${BASE_URL}/api/v1/prescriptions`, JSON.stringify(payload), {
    headers: Object.assign(partnerHeaders(), { "Idempotency-Key": idempotencyKey() }),
    tags: { endpoint: INTAKE_TAG },
  });

  intakeServerErrors.add(res.status >= 500);
  if (res.status === 429) intakeRateLimited.add(1);

  check(
    res,
    {
      "intake accepted (201 / 200 replay / 429 shaped)": (r) =>
        r.status === 201 || r.status === 200 || r.status === 429,
    },
    { endpoint: INTAKE_TAG }
  );
}

// ---- Traffic class 2: partner order-status polling --------------------

export function pollOrders() {
  const res = http.get(`${BASE_URL}/api/v1/orders?limit=50`, {
    headers: partnerHeaders(),
    tags: { endpoint: POLL_TAG },
  });

  pollServerErrors.add(res.status >= 500);

  check(
    res,
    {
      "order list returned (200 / 429 shaped)": (r) => r.status === 200 || r.status === 429,
      "order list carries pagination": (r) => {
        if (r.status !== 200) return true;
        const body = parseJson(r);
        return body !== null && body.pagination && typeof body.pagination.hasMore === "boolean";
      },
    },
    { endpoint: POLL_TAG }
  );
}

// ---- Traffic class 3: operator queue-view browsing --------------------

export function browseQueues() {
  const path = QUEUE_VIEWS[Math.floor(Math.random() * QUEUE_VIEWS.length)];
  const res = http.get(`${BASE_URL}${path}`, {
    headers: operatorCookieHeader(),
    tags: { endpoint: READ_TAG },
    redirects: 0,
  });

  readServerErrors.add(res.status >= 500);

  check(
    res,
    {
      "queue view rendered (200, not a sign-in redirect)": (r) => r.status === 200,
    },
    { endpoint: READ_TAG }
  );

  const think = PILOT_BASELINE.operatorThinkTimeSeconds;
  sleep(think * (0.67 + Math.random() * 0.66));
}

function parseJson(res) {
  try {
    return res.json();
  } catch {
    return null;
  }
}
