// Heartbeat canary — requests the public health endpoint from outside the
// VPC and fails the run unless it answers 200 with `{"status":"ok"}`.
//
// Scope is deliberately narrow (see the module README): no authentication,
// no navigation, no PHI. The endpoint (`apps/web/app/api/health/route.ts`)
// is the app's no-auth liveness probe; this canary proves the whole public
// ingress path — DNS, TLS, CloudFront, WAF, ALB, ECS web — can serve it.
//
// Runtime contract: syn-nodejs-puppeteer-13.1+ (the `@aws/synthetics-*`
// namespace). The target URL arrives via the HEARTBEAT_URL environment
// variable set in the canary's run_config, so a URL change is a Terraform
// apply, not a script change.

/* eslint-disable no-undef, @typescript-eslint/no-require-imports --
   This file is a CommonJS Lambda handler executed by the CloudWatch
   Synthetics runtime (which provides require/process/exports), not part of
   the repo's ESM/TypeScript toolchain. */

const synthetics = require("@aws/synthetics-puppeteer");
const log = require("@aws/synthetics-logger");
const https = require("https");
const { URL } = require("url");

const REQUEST_TIMEOUT_MS = 10000;

function requestOnce(url) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const request = https.request(
      {
        hostname: target.hostname,
        port: target.port || 443,
        path: `${target.pathname}${target.search}`,
        method: "GET",
        timeout: REQUEST_TIMEOUT_MS,
        headers: { "User-Agent": "pharmax-synthetics-heartbeat" },
      },
      (response) => {
        let body = "";
        response.on("data", (chunk) => {
          body += chunk;
        });
        response.on("end", () => {
          resolve({ statusCode: response.statusCode, body });
        });
      }
    );
    request.on("error", reject);
    request.on("timeout", () => {
      request.destroy(new Error(`Request timed out after ${REQUEST_TIMEOUT_MS}ms`));
    });
    request.end();
  });
}

async function checkHeartbeat() {
  const url = process.env.HEARTBEAT_URL;
  if (!url) {
    throw new Error("HEARTBEAT_URL environment variable is not set");
  }

  await synthetics.executeStep("heartbeat", async () => {
    const { statusCode, body } = await requestOnce(url);
    log.info(`Heartbeat responded with status ${statusCode}`);

    if (statusCode !== 200) {
      throw new Error(`Expected HTTP 200, got ${statusCode}`);
    }

    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      throw new Error("Health endpoint did not return valid JSON");
    }

    if (parsed.status !== "ok") {
      throw new Error(`Health endpoint returned status "${parsed.status}", expected "ok"`);
    }
  });
}

exports.handler = async () => {
  return checkHeartbeat();
};
