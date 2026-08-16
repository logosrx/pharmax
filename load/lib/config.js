// Shared configuration for the Pharmax k6 load-test suite.
//
// Plain JavaScript, no npm dependencies — k6 ships its own runtime and
// resolves relative imports itself. Everything environment-specific
// comes in through __ENV so the scripts contain no hosts, no keys, and
// no tenant identifiers.
//
// The workload model here is the single source of the "1x pilot"
// assumption documented in docs/observability/slos.md ("Assumed pilot
// baseline"). Change them together.

/* global __ENV */

// ---------------------------------------------------------------------
// Staging-only guardrails
// ---------------------------------------------------------------------

// Hostname fragments that unambiguously identify a production
// deployment. Matching any of these aborts the run regardless of any
// other setting — there is deliberately no override.
const FORBIDDEN_HOST_PATTERNS = [/prod/i, /\bapi\.pharmax\./i, /\bapp\.pharmax\./i];

/**
 * Resolve and validate the target base URL. Aborts (throws during the
 * init phase, before any VU starts) unless:
 *   - PHARMAX_BASE_URL is set,
 *   - it does not look like production,
 *   - PHARMAX_LOAD_ACK=staging-only is set (a deliberate, typed
 *     acknowledgement — not a flag you can leave exported by accident
 *     in a deploy pipeline).
 */
export function requireStagingBaseUrl() {
  const baseUrl = (__ENV.PHARMAX_BASE_URL || "").replace(/\/+$/, "");
  if (baseUrl === "") {
    throw new Error(
      "PHARMAX_BASE_URL is not set. Point it at a STAGING environment, e.g. " +
        "PHARMAX_BASE_URL=https://staging.internal.example k6 run ... " +
        "NEVER run this suite against production."
    );
  }
  for (const pattern of FORBIDDEN_HOST_PATTERNS) {
    if (pattern.test(baseUrl)) {
      throw new Error(
        `PHARMAX_BASE_URL "${baseUrl}" matches the production pattern ${pattern}. ` +
          "This suite must never target production. Aborting."
      );
    }
  }
  if (__ENV.PHARMAX_LOAD_ACK !== "staging-only") {
    throw new Error(
      "Set PHARMAX_LOAD_ACK=staging-only to confirm the target is a staging " +
        "environment. This is a required, deliberate acknowledgement."
    );
  }
  return baseUrl;
}

// ---------------------------------------------------------------------
// Auth material (all injected, never committed)
// ---------------------------------------------------------------------

/** Headers for partner API (`/api/v1/*`) requests. */
export function partnerHeaders() {
  const apiKey = __ENV.PHARMAX_PARTNER_API_KEY || "";
  if (apiKey === "") {
    throw new Error(
      "PHARMAX_PARTNER_API_KEY is not set. Mint a staging partner API key " +
        "(pxk_...) with the prescriptions.create / orders.read scopes and " +
        "export it. Never use a production key."
    );
  }
  return {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };
}

/**
 * Cookie header for operator (`/ops/*`) requests. The web app resolves
 * operator sessions from the `pharmax_session` cookie
 * (packages/auth/src/configure.ts, DEFAULT_SESSION_POLICY).
 *
 * Note the 30-minute idle / 12-hour absolute session TTLs: mint the
 * session immediately before a long run.
 */
export function operatorCookieHeader() {
  const token = __ENV.PHARMAX_OPS_SESSION_TOKEN || "";
  if (token === "") {
    throw new Error(
      "PHARMAX_OPS_SESSION_TOKEN is not set. Sign in to STAGING as a " +
        "synthetic load-test operator and export the pharmax_session " +
        "cookie value."
    );
  }
  return { Cookie: `pharmax_session=${token}` };
}

// ---------------------------------------------------------------------
// Idempotency keys
// ---------------------------------------------------------------------

/**
 * RFC-4122-shaped v4 UUID from Math.random. Not cryptographically
 * strong, which is fine: these are load-test idempotency keys whose
 * only job is uniqueness within a run.
 */
export function uuidv4() {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/**
 * Idempotency-Key header value. Prefixed so staging `command_log` rows
 * from load runs are trivially identifiable (the route namespaces it
 * further as `partner:<apiKeyId>:<this>`).
 */
export function idempotencyKey() {
  return `k6-load-${uuidv4()}`;
}

// ---------------------------------------------------------------------
// Workload model
// ---------------------------------------------------------------------

// Pilot (1x) baseline, documented in docs/observability/slos.md:
// one site, ~200 prescriptions/day over a 10-hour window, peak-hour
// factor ~2.5 and EHR batch-burst factor ~2 → design peak ≈ 180
// submissions/hour. Operator population 10, ~4 reads/minute each.
export const PILOT_BASELINE = {
  intakePerMinute: 3,
  // EHR partners polling GET /api/v1/orders for status sync (assume 3
  // integrated partners syncing once a minute at pilot).
  partnerOrderPollsPerMinute: 3,
  concurrentOperators: 10,
  operatorThinkTimeSeconds: 15,
};

const MULTIPLIERS = {
  pilot_1x: 1,
  pilot_5x: 5,
  pilot_10x: 10,
};

/** Steady-state measurement duration for rate scenarios. */
export const STEADY_STATE_DURATION = "10m";

/**
 * Resolve the requested workload from WORKLOAD. Defaults to "smoke"
 * (1 VU, 1 iteration) so a bare `k6 run <script>` is always a safe
 * syntax/wiring check and never a load test by accident.
 */
export function resolveWorkload() {
  const name = __ENV.WORKLOAD || "smoke";
  if (name !== "smoke" && !(name in MULTIPLIERS)) {
    throw new Error(
      `Unknown WORKLOAD "${name}". Expected one of: smoke, ${Object.keys(MULTIPLIERS).join(", ")}.`
    );
  }
  return name;
}

export function workloadMultiplier(workload) {
  return workload === "smoke" ? 0 : MULTIPLIERS[workload];
}

/**
 * Build a constant-arrival-rate scenario (open model: arrivals do not
 * slow down when the system does, which is how real partner traffic
 * behaves and what makes latency degradation visible).
 */
export function arrivalRateScenario({ exec, ratePerMinute, tags }) {
  return {
    executor: "constant-arrival-rate",
    exec,
    rate: ratePerMinute,
    timeUnit: "1m",
    duration: STEADY_STATE_DURATION,
    // Enough headroom that VU starvation never caps the arrival rate:
    // at p99 = 1 s a VU sustains ~60 iterations/minute.
    preAllocatedVUs: Math.max(5, Math.ceil(ratePerMinute / 10)),
    maxVUs: Math.max(20, Math.ceil(ratePerMinute / 2)),
    tags,
  };
}

/**
 * Build a constant-VUs scenario (closed model: a fixed operator
 * population with think time, which is how console usage behaves).
 */
export function operatorPopulationScenario({ exec, vus, tags }) {
  return {
    executor: "constant-vus",
    exec,
    vus,
    duration: STEADY_STATE_DURATION,
    tags,
  };
}

/** 1 VU x 1 iteration — syntax/wiring validation. */
export function smokeScenario({ exec, tags }) {
  return {
    executor: "shared-iterations",
    exec,
    vus: 1,
    iterations: 1,
    maxDuration: "1m",
    tags,
  };
}

// ---------------------------------------------------------------------
// SLO thresholds (docs/observability/slos.md is the narrative source)
// ---------------------------------------------------------------------

// Milliseconds, matching k6's http_req_duration unit.
export const SLO = {
  // SLO-1: partner prescription submission.
  partnerIntake: { p95: 500, p99: 1000, maxServerErrorRate: 0.001 },
  // SLO-1 companion read surface: GET /api/v1/orders.
  partnerRead: { p95: 400, p99: 800, maxServerErrorRate: 0.001 },
  // SLO-4: queue view / dashboard read path.
  operatorRead: { p95: 800, p99: 1500, maxServerErrorRate: 0.001 },
};

/**
 * Threshold entries for a request class tagged `endpoint:<tag>`.
 * `checks` capture correctness (expected status + body shape) and the
 * dedicated `<tag>_server_errors` Rate metric captures availability.
 */
export function sloThresholds(tag, slo) {
  return {
    [`http_req_duration{endpoint:${tag}}`]: [`p(95)<${slo.p95}`, `p(99)<${slo.p99}`],
    [`${tag}_server_errors`]: [`rate<${slo.maxServerErrorRate}`],
  };
}
