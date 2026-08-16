// Partner API prescription intake — SLO-1 in docs/observability/slos.md.
//
// POST /api/v1/prescriptions with synthetic payloads matching the
// CreatePrescription zod schema. Open workload model
// (constant-arrival-rate): partner EHRs do not slow down because we
// did, so neither does the load generator.
//
//   WORKLOAD=smoke      1 VU x 1 iteration (default; syntax check)
//   WORKLOAD=pilot_1x   3 submissions/min (assumed pilot design peak)
//   WORKLOAD=pilot_5x   15 submissions/min
//   WORKLOAD=pilot_10x  30 submissions/min
//
// STAGING ONLY. The init phase aborts without PHARMAX_LOAD_ACK and a
// non-production PHARMAX_BASE_URL. See load/README.md.

/* global console */

import http from "k6/http";
import { check } from "k6";
import { Counter, Rate } from "k6/metrics";

import {
  arrivalRateScenario,
  idempotencyKey,
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

// Availability SLI: 5xx responses only. 4xx (bad payload — a bug in
// this script) fails checks instead; 429 quota shaping is neither.
const intakeServerErrors = new Rate("partner_intake_server_errors");
const intakeRateLimited = new Counter("partner_intake_rate_limited");
const intakeReplays = new Counter("partner_intake_idempotent_replays");

const TAG = "partner_intake";

export const options = {
  scenarios: {
    [WORKLOAD]:
      WORKLOAD === "smoke"
        ? smokeScenario({ exec: "submitPrescription", tags: { endpoint: TAG } })
        : arrivalRateScenario({
            exec: "submitPrescription",
            ratePerMinute: PILOT_BASELINE.intakePerMinute * workloadMultiplier(WORKLOAD),
            tags: { endpoint: TAG },
          }),
  },
  // Wired to SLO-1: p95 <= 500 ms, p99 <= 1000 ms, server-error rate
  // < 0.1% (99.9% availability), plus a correctness bar on checks.
  thresholds: Object.assign(sloThresholds(TAG, SLO.partnerIntake), {
    [`checks{endpoint:${TAG}}`]: ["rate>0.99"],
  }),
};

export function setup() {
  // Fail fast on missing auth/seed config before any load starts.
  partnerHeaders();
  const seed = requireSeedIdentifiers();
  console.warn(`partner-api-intake: workload=${WORKLOAD} target=${BASE_URL} — staging-only suite`);
  return { seed };
}

export function submitPrescription(data) {
  const payload = prescriptionPayload(data.seed);
  const res = http.post(`${BASE_URL}/api/v1/prescriptions`, JSON.stringify(payload), {
    headers: Object.assign(partnerHeaders(), { "Idempotency-Key": idempotencyKey() }),
    tags: { endpoint: TAG },
  });

  intakeServerErrors.add(res.status >= 500);
  if (res.status === 429) {
    // Per-key quota shaping (ADR-0032). At 10x this may fire if the
    // staging key's tier is too small — raise the tier, do not treat
    // it as an SLO breach.
    intakeRateLimited.add(1);
  }

  const body = parseJson(res);
  if (res.status === 200 && body && body.meta && body.meta.idempotentReplay === true) {
    intakeReplays.add(1);
  }

  check(
    res,
    {
      "intake accepted (201 created / 200 replay / 429 shaped)": (r) =>
        r.status === 201 || r.status === 200 || r.status === 429,
      "created response carries prescriptionId + rxNumber": (r) =>
        r.status !== 201 ||
        (body !== null &&
          body.data &&
          typeof body.data.prescriptionId === "string" &&
          typeof body.data.rxNumber === "string"),
    },
    { endpoint: TAG }
  );
}

function parseJson(res) {
  try {
    return res.json();
  } catch {
    return null;
  }
}
