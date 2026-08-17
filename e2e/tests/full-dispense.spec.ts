// Full-dispense golden path + exception flows (go-live Workstream D,
// row D1).
//
// Golden path, through the REAL UI wherever a surface exists:
//
//   intake (transcribe Rx via /ops/prescriptions/new, create order via
//   POST /api/v1/orders — the production intake API; no ops-console UI
//   creates orders) → typing → PV1 approval (screening findings
//   acknowledged per-finding, then approve) → fill (assign lot, print
//   vial label, scan-to-complete) → final verification → shipping
//   (release → create shipment → confirm) → SHIPPED.
//
// Exception paths, each as its own test:
//
//   - PV1 rejection with a structured reason code (UI).
//   - Hold + release (via scripts/e2e-dispatch.ts — PlaceHold /
//     ReleaseHold have no ops UI or /api/ops route yet; the dispatch
//     goes through the real command bus, and the resulting states are
//     asserted through the UI).
//   - Cancellation with a disposition reason (same: CancelOrder has no
//     UI surface; dispatched through the command bus, asserted in UI).
//
// Separation of duties is real (packages/rbac separation-of-duties.ts),
// so the suite signs in four seeded operators (scripts/e2e-seed.ts):
// tech (typing + fill), pharmacist 1 (PV1), pharmacist 2 (final),
// shipping clerk (ship). Each runs in its own browser context.
//
// Printing: no physical Zebra printer exists in CI. PrintVialLabel
// writes the vial label + a PENDING print job for the workstation
// agent to pick up; the workbench renders that status and the barcode.
// The test asserts the label record, the PENDING job status, and the
// barcode value. CompleteFill then refuses while the print job is not
// COMPLETED (FILL_LABEL_PRINT_NOT_COMPLETE — a real no-silent-failure
// control), and in production the print-agent daemon confirms the job
// after the Zebra prints. No agent runs in CI, so the suite dispatches
// the same ConfirmVialLabelPrint command out-of-band (e2e-dispatch.ts,
// as the fill tech at workstation WS-01), re-asserts COMPLETED in the
// workbench, and completes fill with the printed barcode — so a
// silently-failed print could not pass.
//
// Shipping: the manual path (CreateShipment with an operator-entered
// tracking number, then ConfirmShipment) — no carrier account, no
// external network dependency.
//
// Hermeticity: every order this file creates carries a unique
// per-run external order number (E2E-<runId>-…) and finishes in a
// state that does not accumulate across reused-database runs in a way
// that breaks assertions — all row lookups are scoped by that number.

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { expect, test, type APIRequestContext, type Browser, type Page } from "@playwright/test";

import {
  E2E_API_KEY_TOKEN,
  E2E_DATABASE_URL,
  E2E_KMS_SEED,
  E2E_OPERATOR_EMAIL,
  E2E_OPERATOR_PASSWORD,
  E2E_ORG_BASE_URL,
  E2E_PHARMACIST2_EMAIL,
  E2E_PHARMACIST2_PASSWORD,
  E2E_SHIPPING_EMAIL,
  E2E_SHIPPING_PASSWORD,
  E2E_STATE_FILE,
  E2E_TECH2_EMAIL,
  E2E_TECH2_PASSWORD,
  E2E_TECH_EMAIL,
  E2E_TECH_PASSWORD,
  type E2ESeedState,
} from "../env";

test.use({ baseURL: E2E_ORG_BASE_URL });

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

/** Unique per-run marker so a reused database never collides. */
const runId = randomUUID().slice(0, 8);

function seedState(): E2ESeedState {
  return JSON.parse(readFileSync(E2E_STATE_FILE, "utf8")) as E2ESeedState;
}

const IS_CI = process.env["CI"] !== undefined;

/**
 * See the note in `submitActionForm` — sized for a cold dev compile.
 *
 * Doubled on CI, where two vCPUs are shared between webpack, Chromium
 * and the tests: a cold ops route measured over a minute there against
 * a few seconds locally. This is infrastructure latency, not slack for
 * product bugs — a real refusal answers immediately with an `error=`
 * code, and a real hang exhausts any budget we would plausibly set.
 */
const ACTION_POST_TIMEOUT_MS = IS_CI ? 120_000 : 60_000;

/**
 * Budget for compiling one ops route (see `warmActionRoute`). Separate
 * from the POST budget so the two costs are legible apart: this one is
 * webpack, that one is the command.
 */
const ROUTE_WARM_TIMEOUT_MS = IS_CI ? 180_000 : 60_000;

/** Sign-in as a unit: navigate, fill, submit, land on the dashboard. */
const SIGN_IN_RETRY_BUDGET_MS = IS_CI ? 180_000 : 45_000;
const SIGN_IN_LANDING_TIMEOUT_MS = IS_CI ? 60_000 : 20_000;

/**
 * Retry a navigation that failed at the transport level.
 *
 * `next dev` restarts itself when used heap passes 80% of the V8 ceiling,
 * and compiling this app's ops surface gets there on a CI runner. The
 * restart kills in-flight sockets, so a navigation can fail with
 * `net::ERR_CONNECTION_RESET`/`_REFUSED` before any HTTP response exists.
 * That is infrastructure, not product signal — a real failure answers
 * with a status code or an error page, and both still fail the caller's
 * assertions. Anything that is not a `net::` error rethrows untouched.
 *
 * Installed by wrapping `goto` once per page rather than editing all 27
 * call sites: the wrapper cannot be forgotten at a new call site, and it
 * keeps the navigation lines in the tests about what they are fetching.
 */
function hardenNavigation(page: Page): void {
  const goto = page.goto.bind(page);
  page.goto = async (url, options) => {
    const ATTEMPTS = 3;
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await goto(url, options);
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        if (attempt >= ATTEMPTS || !message.includes("net::ERR_")) throw cause;
        // Give the restarted server a moment to bind again.
        await page.waitForTimeout(2_000 * attempt);
      }
    }
  };
}

const APP_ORIGIN = new URL(E2E_ORG_BASE_URL).origin;

/**
 * Whether the browser has committed a real page on the app's own
 * origin. Compared as a parsed origin, not a string prefix: a host
 * like `acme.localhost.example.com` shares the prefix but is a
 * different site, which is the js/incomplete-url-substring-sanitization
 * pattern CodeQL rejects. Non-http commits (`chrome-error://`,
 * `about:blank`) parse but never match, and unparseable values are
 * simply "not on our origin".
 */
function isOnAppOrigin(url: string): boolean {
  try {
    return new URL(url).origin === APP_ORIGIN;
  } catch {
    return false;
  }
}

/**
 * Compile an ops action route before the assertion that measures it.
 *
 * `next dev` compiles a route on its first request, and CI always starts
 * from a cold `.next`. Billed to the POST, that compile is the single
 * biggest source of noise in this suite: the budget went 20s → 60s
 * chasing it, and the runs that appeared to "hang" were the cold ones —
 * a fresh worktree, or any CI runner. A warm local checkout never
 * reproduced it, which is how it stayed misfiled as an environment
 * artefact for so long.
 *
 * Deliberately just-in-time, one route at a time. Compiling the whole
 * ops surface up front works locally and does not survive CI: holding
 * every route's module graph at once exhausts the dev server's heap, and
 * `next dev` reacts by restarting itself mid-suite — dropping sockets,
 * abandoning open Postgres transactions and discarding every compile.
 * (With that restart disabled the server OOMs outright instead.) Warming
 * exactly the route about to be posted keeps the memory profile
 * identical to plain lazy compilation while still moving the cost off
 * the assertion's clock.
 *
 * Harmless by construction: a GET against a POST-only route makes Next
 * load the module to discover its exported methods, then answer 405
 * without running a line of the handler. No command can run down this
 * path however the caller is authenticated.
 *
 * Sent through the page's own context so it carries the signed-in
 * operator's cookie. That matters: `proxy.ts` redirects operator routes
 * when no session cookie is present, and it does so before Next resolves
 * the route — an anonymous warm request compiles nothing at all, which
 * is exactly how an earlier version of this warmed 33 routes in 6.3s and
 * left every one of them cold.
 */
async function warmActionRoute(page: Page, actionPathSuffix: string): Promise<void> {
  const path = actionPathSuffix.startsWith("/api/")
    ? actionPathSuffix
    : `/api/ops${actionPathSuffix}`;
  const response = await page.request.fetch(new URL(path, E2E_ORG_BASE_URL).toString(), {
    method: "GET",
    timeout: ROUTE_WARM_TIMEOUT_MS,
    failOnStatusCode: false,
    maxRedirects: 0,
  });
  // 405 is the proof the request reached the compiled route module. A
  // redirect would mean proxy.ts intercepted it and nothing compiled; a
  // 404 would mean this path no longer maps to a route. Either way the
  // warm-up would be silently doing nothing, which is worse than not
  // having one — the cost quietly returns to the assertion and the next
  // person re-debugs a timeout that looks like a product hang.
  expect(response.status(), `warm ${path} should reach the route module`).toBe(405);
}

/**
 * Click a native ActionForm submit and capture the ops route's 303
 * redirect target — which is where the command's outcome (success
 * params or `error=` code) travels.
 *
 * KNOWN PRODUCT BUG (worked around, not fixed here): the shared ops
 * dispatcher (apps/web/src/server/ops/dispatch-from-route.ts) builds
 * every post-command redirect against the placeholder base
 * `http://internal`, so the Location header is an absolute
 * `http://internal/...` URL that no browser can resolve. The command
 * itself commits BEFORE the redirect, so state is real — but the
 * browser then strands on a network-error page. This helper therefore
 * (a) reads the 303 Location straight off the POST response, which is
 * the command's authoritative outcome, and (b) waits for the doomed
 * follow-up navigation to settle so the caller can re-navigate to the
 * surface it wants to assert. If the bug gets fixed, everything here
 * still holds — the Location just becomes followable too.
 */
async function submitActionForm(
  page: Page,
  actionPathSuffix: string,
  click: () => Promise<void>
): Promise<URL> {
  await warmActionRoute(page, actionPathSuffix);
  const before = page.url();
  const [response] = await Promise.all([
    page.waitForResponse(
      (r) =>
        r.request().method() === "POST" && new URL(r.url()).pathname.endsWith(actionPathSuffix),
      { timeout: ACTION_POST_TIMEOUT_MS }
    ),
    click(),
  ]);
  expect(response.status(), `POST ${actionPathSuffix}`).toBe(303);
  // Resolved against the page rather than parsed bare: an ops route
  // may answer with an absolute Location (today) or a relative one
  // (once the http://internal placeholder is fixed — see the note
  // above). `new URL(relative)` throws TypeError: Invalid URL, so
  // parsing bare couples this suite to whichever form ships first.
  const location = new URL(response.headers()["location"] ?? "about:blank", page.url());
  // Let the (currently doomed) redirect navigation fully settle
  // before the caller's next goto — otherwise the error-page commit
  // lands mid-goto and Playwright reports "interrupted by another
  // navigation". The failure is two-phase (commit to http://internal,
  // THEN swap to chrome-error://), so wait for the terminal state:
  // the chrome-error page today, or a loaded real page once the
  // Location bug is fixed.
  try {
    const deadline = Date.now() + 10_000;
    for (;;) {
      const now = page.url();
      if (now.startsWith("chrome-error://")) break;
      if (now !== before && isOnAppOrigin(now)) {
        await page.waitForLoadState("load", { timeout: 5_000 });
        break;
      }
      if (Date.now() > deadline) break;
      await page.waitForTimeout(200);
    }
  } catch {
    // Settling is best-effort — the command outcome was already read
    // off the 303 above.
  }
  return location;
}

/** Assert the ops route redirect carries no `error=` refusal code. */
function expectApplied(location: URL): void {
  expect(location.searchParams.get("error"), location.toString()).toBeNull();
}

/**
 * Sign in as a seeded operator. Retried as a unit: the first paint can
 * precede React hydration, and a pre-hydration click submits the form
 * natively instead of invoking the JS handler (see operator-smoke).
 *
 * The navigation is INSIDE the retry on purpose. With it outside, an
 * attempt whose click did land left the page mid-navigation away from
 * /sign-in, so every subsequent attempt failed looking for an Email
 * field that was no longer on screen — the retry could report only the
 * first attempt's failure, never recover from it. That is the flake
 * this helper was written to absorb, so it has to survive its own
 * first attempt.
 */
async function signIn(page: Page, email: string, password: string): Promise<void> {
  const alreadyOnDashboard = (): boolean => {
    try {
      return new URL(page.url()).pathname === "/ops";
    } catch {
      return false;
    }
  };

  await expect(async () => {
    // A previous attempt may have succeeded just past its own deadline.
    if (alreadyOnDashboard()) return;
    await page.goto("/sign-in");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill(password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForURL("**/ops", { timeout: SIGN_IN_LANDING_TIMEOUT_MS });
  }).toPass({ timeout: SIGN_IN_RETRY_BUDGET_MS });
}

async function newOperatorPage(browser: Browser, email: string, password: string): Promise<Page> {
  const context = await browser.newContext({ baseURL: E2E_ORG_BASE_URL });
  const page = await context.newPage();
  hardenNavigation(page);
  await signIn(page, email, password);
  return page;
}

/**
 * Transcribe a prescription for the seeded synthetic patient through
 * /ops/prescriptions/new (as the tech). Uses the catalog demo product
 * and the seeded prescriber (both preselected). Returns the new
 * prescription's id, parsed from the success redirect.
 *
 * KNOWN PRODUCT BUG (worked around, not fixed here): the natural flow
 * is search → click the match. But auditPatientView's minute-bucketed
 * idempotency key omits the `surface` that IS in the ViewPatient
 * payload, so the PATIENT_SEARCH_RESULT audit and the
 * PATIENT_ADMIN_PAGE audit that follows within the same minute share
 * a key with different payloads → COMMAND_IDEMPOTENCY_PAYLOAD_MISMATCH
 * → step 2 withholds the patient and never renders the form. Until
 * that is fixed, the helper deep-links straight to step 2 (a URL shape
 * the page itself emits in its LinkCards); the search UI is covered by
 * its own test below, which stops before the click-through.
 */
async function transcribePrescription(page: Page, state: E2ESeedState): Promise<string> {
  await page.goto(`/ops/prescriptions/new?patientId=${encodeURIComponent(state.patientId)}`);

  // The transcription form. Prescriber + catalog product are
  // preselected; the demo product is non-controlled, so refills stay
  // editable and no DEA affordance triggers. ActionForm posts
  // natively, so a pre-hydration submit still works.
  await page.getByLabel("Sig — directions for use").fill("Inject 1mL once weekly. (E2E DEMO)");
  // Role-based, not exact-label: the visible <label> carries a
  // required-marker "*", so an exact label lookup never resolves.
  await page.getByRole("textbox", { name: "Quantity", exact: true }).fill("10");
  await page.getByRole("spinbutton", { name: "Days supply" }).fill("30");
  const location = await submitActionForm(page, "/api/ops/prescriptions/create", () =>
    page.getByRole("button", { name: "Transcribe prescription" }).click()
  );
  expectApplied(location);
  const prescriptionId = location.searchParams.get("prescriptionId");
  expect(prescriptionId).not.toBeNull();
  expect(location.searchParams.get("rxNumber")).not.toBeNull();
  return prescriptionId!;
}

/**
 * Create an order through the production intake surface: POST
 * /api/v1/orders with the seeded partner API key. There is no
 * ops-console UI for order creation — the v1 partner API is the
 * real path (`intakeSourceKind` is forced to API by the route).
 */
async function createOrderViaIntakeApi(
  request: APIRequestContext,
  state: E2ESeedState,
  prescriptionId: string,
  externalOrderNumber: string
): Promise<string> {
  const response = await request.post(`${E2E_ORG_BASE_URL}/api/v1/orders`, {
    headers: {
      authorization: `Bearer ${E2E_API_KEY_TOKEN}`,
      "idempotency-key": randomUUID(),
    },
    data: {
      clinicId: state.clinicId,
      siteId: state.siteId,
      patientId: state.patientId,
      externalOrderNumber,
      priority: "NORMAL",
      lines: [{ prescriptionId, quantityToFill: 1, daysSupplyToFill: 30 }],
    },
  });
  expect(response.status(), await response.text()).toBe(201);
  const body = (await response.json()) as { data: { orderId: string } };
  return body.data.orderId;
}

/** Intake helper: transcribe (UI) + create the order (v1 API). */
async function intakeOrder(
  techPage: Page,
  request: APIRequestContext,
  state: E2ESeedState,
  suffix: string
): Promise<{ orderId: string; externalOrderNumber: string }> {
  const prescriptionId = await transcribePrescription(techPage, state);
  const externalOrderNumber = `E2E-${runId}-${suffix}`;
  const orderId = await createOrderViaIntakeApi(
    request,
    state,
    prescriptionId,
    externalOrderNumber
  );
  return { orderId, externalOrderNumber };
}

/** The queue row (an <li>) containing this order's external number. */
function queueRow(page: Page, externalOrderNumber: string) {
  return page.locator("li").filter({ hasText: externalOrderNumber }).first();
}

/**
 * Typing stage through the UI: claim, then complete review. Each
 * submit is followed by an explicit re-navigation (see
 * submitActionForm for the redirect bug that makes this necessary).
 */
async function completeTyping(
  techPage: Page,
  orderId: string,
  externalOrderNumber: string
): Promise<void> {
  await techPage.goto("/ops/typing");
  expectApplied(
    await submitActionForm(techPage, `/orders/${orderId}/start-typing`, () =>
      queueRow(techPage, externalOrderNumber)
        .getByRole("button", { name: "Claim · Start typing" })
        .click()
    )
  );

  await techPage.goto("/ops/typing");
  expectApplied(
    await submitActionForm(techPage, `/orders/${orderId}/complete-typing-review`, () =>
      queueRow(techPage, externalOrderNumber)
        .getByRole("button", { name: /Complete review/ })
        .click()
    )
  );

  // Typed → out of the typing queue.
  await techPage.goto("/ops/typing");
  await expect(queueRow(techPage, externalOrderNumber)).toHaveCount(0);
}

/** Claim the order in the PV1 queue (StartPV1). */
async function claimPv1(
  pharmacistPage: Page,
  orderId: string,
  externalOrderNumber: string
): Promise<void> {
  await pharmacistPage.goto("/ops/pv1");
  expectApplied(
    await submitActionForm(pharmacistPage, `/orders/${orderId}/start-pv1`, () =>
      queueRow(pharmacistPage, externalOrderNumber)
        .getByRole("button", { name: "Claim · Start PV1" })
        .click()
    )
  );
  // Claimed: the queue re-render shows the decision actions.
  await pharmacistPage.goto("/ops/pv1");
  await expect(
    queueRow(pharmacistPage, externalOrderNumber).getByRole("button", { name: "Approve PV1" })
  ).toBeVisible({ timeout: 15_000 });
}

/**
 * Acknowledge every outstanding clinical-screening finding on the
 * order detail page, then approve PV1 from the decision panel.
 * ApprovePV1 re-screens and refuses (PV1_SCREENING_ACKNOWLEDGEMENT_
 * REQUIRED) if any finding requiring acknowledgement is not
 * acknowledged by THIS pharmacist, so the loop runs first.
 */
async function acknowledgeFindingsAndApprovePv1(
  pharmacistPage: Page,
  orderId: string
): Promise<void> {
  await pharmacistPage.goto(`/ops/orders/${orderId}`);

  // HARD_STOP findings render no control ("No override") and would
  // make approval impossible; the synthetic fixture must never
  // produce one.
  await expect(pharmacistPage.getByText("No override")).toHaveCount(0);

  // Acknowledge one finding per pass — each acknowledgement posts,
  // then the page is re-opened for a fresh render of what is left.
  for (let i = 0; i < 10; i++) {
    const ackButton = pharmacistPage.getByRole("button", { name: /^Acknowledge / }).first();
    if ((await ackButton.count()) === 0) break;
    expectApplied(
      await submitActionForm(
        pharmacistPage,
        `/orders/${orderId}/acknowledge-pv1-screening-finding`,
        () => ackButton.click()
      )
    );
    await pharmacistPage.goto(`/ops/orders/${orderId}`);
  }
  await expect(pharmacistPage.getByRole("button", { name: /^Acknowledge / })).toHaveCount(0);

  // Approve. ApprovePV1 re-screens inside the command; a refusal
  // would come back as an `error=` code on the redirect and fail
  // expectApplied — a silent screening bypass cannot pass here.
  expectApplied(
    await submitActionForm(pharmacistPage, `/orders/${orderId}/approve-pv1`, () =>
      pharmacistPage.getByRole("button", { name: "Approve PV1" }).click()
    )
  );
}

test.describe("full dispense", () => {
  // Pages built by `newOperatorPage` are hardened on creation; the
  // fixture-provided one has to be caught here.
  test.beforeEach(({ page }) => {
    hardenNavigation(page);
  });

  test("intake step 1: blind-index patient search finds the synthetic fixture", async ({
    browser,
  }) => {
    // Run as tech 2 — a technician (the page needs prescriptions.create)
    // but a DIFFERENT user from the tech who transcribes — so this
    // test's PATIENT_SEARCH_RESULT audit can never share a
    // minute-bucketed idempotency key with the transcribing tech's
    // PATIENT_ADMIN_PAGE audits (see transcribePrescription's header
    // for the underlying product bug). It also deliberately stops
    // before the click-through, which is the exact interaction that
    // bug breaks.
    const state = seedState();
    const page = await newOperatorPage(browser, E2E_TECH2_EMAIL, E2E_TECH2_PASSWORD);

    await page.goto("/ops/prescriptions/new");
    await page.getByLabel("Last name").fill(state.patientLastName);
    await page.getByRole("button", { name: "Find patient" }).click();
    await expect(
      page.getByRole("link", { name: new RegExp(state.patientLastName) }).first()
    ).toBeVisible({ timeout: 15_000 });
  });

  test("golden path: intake → typing → PV1 → fill → label → final → ship", async ({
    browser,
    request,
  }) => {
    test.setTimeout(420_000);
    const state = seedState();

    const techPage = await newOperatorPage(browser, E2E_TECH_EMAIL, E2E_TECH_PASSWORD);

    // ---- Intake ----
    const { orderId, externalOrderNumber } = await intakeOrder(techPage, request, state, "GOLD");

    // ---- Typing (tech) ----
    await completeTyping(techPage, orderId, externalOrderNumber);

    // ---- PV1 (pharmacist 1 — SoD: not the typist) ----
    const rph1Page = await newOperatorPage(browser, E2E_OPERATOR_EMAIL, E2E_OPERATOR_PASSWORD);
    await claimPv1(rph1Page, orderId, externalOrderNumber);
    await acknowledgeFindingsAndApprovePv1(rph1Page, orderId);

    // ---- Fill (tech): claim → workbench → lot → label → scans ----
    await techPage.goto("/ops/fill");
    expectApplied(
      await submitActionForm(techPage, `/orders/${orderId}/start-fill`, () =>
        queueRow(techPage, externalOrderNumber)
          .getByRole("button", { name: "Claim · Start fill" })
          .click()
      )
    );

    // Lot assignment — the seeded LOT-DEMO-01 is preselected (active,
    // unexpired; expired/held lots never reach the candidate list).
    await techPage.goto(`/ops/fill/${orderId}`);
    expectApplied(
      await submitActionForm(techPage, `/orders/${orderId}/assign-lot`, () =>
        techPage.getByRole("button", { name: "Assign lot" }).click()
      )
    );
    await techPage.goto(`/ops/fill/${orderId}`);
    await expect(techPage.getByText("lot ✓")).toBeVisible();
    await expect(techPage.getByText("LOT-DEMO-01").first()).toBeVisible();

    // Vial label print — no physical printer, so the observable
    // outcome is the label record + PENDING print job + barcode. A
    // silent print failure cannot pass: the barcode drives the
    // completion scan below.
    expectApplied(
      await submitActionForm(techPage, `/orders/${orderId}/print-vial-label`, () =>
        techPage.getByRole("button", { name: "Print vial label" }).click()
      )
    );
    await techPage.goto(`/ops/fill/${orderId}`);
    await expect(techPage.getByText("label ✓")).toBeVisible();
    await expect(techPage.getByText("PENDING")).toBeVisible();
    const barcode = await techPage.locator("code", { hasText: /^PX:/ }).first().innerText();
    expect(barcode).toMatch(/^PX:[0-9a-f-]{36}$/);

    // CompleteFill refuses while the print job is not COMPLETED (a
    // real control — no silent print failures). In production the
    // print-agent daemon confirms the job after the Zebra prints; no
    // agent runs in CI, so the same ConfirmVialLabelPrint command is
    // dispatched out-of-band as the tech at workstation WS-01, then
    // the workbench is reloaded to show the COMPLETED print state.
    dispatchCommand("confirm-vial-label-print", orderId, "COMPLETED");
    await techPage.goto(`/ops/fill/${orderId}`);
    await expect(techPage.getByText("COMPLETED")).toBeVisible();

    // Scan-to-complete: lot barcode + printed vial-label barcode.
    await techPage.getByLabel("Lot scan").fill("LOT-DEMO-01");
    await techPage.getByLabel("Vial label scan").fill(barcode);
    expectApplied(
      await submitActionForm(techPage, `/orders/${orderId}/complete-fill`, () =>
        techPage.getByRole("button", { name: /Complete fill/ }).click()
      )
    );

    // ---- Final verification (pharmacist 2 — SoD: neither the PV1
    // approver nor the filler) ----
    const rph2Page = await newOperatorPage(
      browser,
      E2E_PHARMACIST2_EMAIL,
      E2E_PHARMACIST2_PASSWORD
    );
    await rph2Page.goto("/ops/final");
    expectApplied(
      await submitActionForm(rph2Page, `/orders/${orderId}/start-final`, () =>
        queueRow(rph2Page, externalOrderNumber)
          .getByRole("button", { name: "Claim · Start verification" })
          .click()
      )
    );
    await rph2Page.goto("/ops/final");
    expectApplied(
      await submitActionForm(rph2Page, `/orders/${orderId}/approve-final`, () =>
        queueRow(rph2Page, externalOrderNumber)
          .getByRole("button", { name: "Approve final" })
          .click()
      )
    );

    // ---- Shipping (clerk): release → manual shipment → confirm ----
    const shipPage = await newOperatorPage(browser, E2E_SHIPPING_EMAIL, E2E_SHIPPING_PASSWORD);
    await shipPage.goto("/ops/shipping");
    expectApplied(
      await submitActionForm(shipPage, `/orders/${orderId}/release-to-ship`, () =>
        queueRow(shipPage, externalOrderNumber)
          .getByRole("button", { name: "Release to ship" })
          .click()
      )
    );

    // Manual shipment (no carrier account, no external network):
    // carrier + service level + operator-entered tracking number.
    await shipPage.goto("/ops/shipping");
    const shipRow = queueRow(shipPage, externalOrderNumber);
    await shipRow.getByLabel("Service level").fill("PRIORITY");
    await shipRow.getByLabel("Tracking number").fill(`E2E-TRACK-${runId}`);
    expectApplied(
      await submitActionForm(shipPage, `/orders/${orderId}/create-shipment`, () =>
        shipRow.getByRole("button", { name: "Create shipment" }).click()
      )
    );

    await shipPage.goto("/ops/shipping");
    const confirmRow = queueRow(shipPage, externalOrderNumber);
    await expect(confirmRow.getByText(`E2E-TRACK-${runId}`)).toBeVisible();
    expectApplied(
      await submitActionForm(shipPage, `/orders/${orderId}/confirm-shipment`, () =>
        confirmRow.getByRole("button", { name: /Confirm shipment/ }).click()
      )
    );

    // ---- End-to-end assertion: the order detail timeline sits on
    // the terminal "Shipped" step (viewed by the tech, who holds
    // patients.read). "Shipped" is also a stage label, so the check
    // keys on the timeline's aria-current step, not on bare text. ----
    await techPage.goto(`/ops/orders/${orderId}`);
    await expect(techPage.locator('li[aria-current="step"]')).toContainText("Shipped");
  });

  test("PV1 rejection requires a reason code and lands in the exception state", async ({
    browser,
    request,
  }) => {
    test.setTimeout(240_000);
    const state = seedState();

    const techPage = await newOperatorPage(browser, E2E_TECH_EMAIL, E2E_TECH_PASSWORD);
    const { orderId, externalOrderNumber } = await intakeOrder(techPage, request, state, "REJ");
    await completeTyping(techPage, orderId, externalOrderNumber);

    const rph1Page = await newOperatorPage(browser, E2E_OPERATOR_EMAIL, E2E_OPERATOR_PASSWORD);
    await claimPv1(rph1Page, orderId, externalOrderNumber);

    // Reject with a structured reason code — the select defaults to
    // DOSE_INCORRECT; pick a different one to prove the control is live.
    const row = queueRow(rph1Page, externalOrderNumber);
    await row.getByLabel("Rejection reason").selectOption("SIG_AMBIGUOUS");
    expectApplied(
      await submitActionForm(rph1Page, `/orders/${orderId}/reject-pv1`, () =>
        row.getByRole("button", { name: "Reject", exact: true }).click()
      )
    );

    await rph1Page.goto(`/ops/orders/${orderId}`);
    await expect(rph1Page.getByText("PV1 rejected").first()).toBeVisible({ timeout: 15_000 });
  });

  test("hold and release: command-bus dispatch, states verified in the UI", async ({
    browser,
    request,
  }) => {
    test.setTimeout(240_000);
    const state = seedState();

    const techPage = await newOperatorPage(browser, E2E_TECH_EMAIL, E2E_TECH_PASSWORD);
    const { orderId, externalOrderNumber } = await intakeOrder(techPage, request, state, "HOLD");

    // PlaceHold/ReleaseHold have no ops UI or /api/ops route yet, so
    // they are dispatched through the real command bus (reason codes
    // are structurally required by both input schemas).
    dispatchCommand("place-hold", orderId, "WAITING_FOR_PROVIDER");
    await techPage.goto(`/ops/orders/${orderId}`);
    await expect(techPage.getByText("On hold").first()).toBeVisible({ timeout: 15_000 });

    dispatchCommand("release-hold", orderId, "INFO_RECEIVED");
    await techPage.goto(`/ops/orders/${orderId}`);
    await expect(techPage.getByText("On hold")).toHaveCount(0);
    await expect(techPage.getByText("Received", { exact: true }).first()).toBeVisible();

    // The released order is live again: it reappears in the typing
    // queue rather than lingering in an exception bucket.
    await techPage.goto("/ops/typing");
    await expect(queueRow(techPage, externalOrderNumber)).toBeVisible({ timeout: 15_000 });
  });

  test("cancellation goes through CancelOrder with a disposition reason", async ({
    browser,
    request,
  }) => {
    test.setTimeout(240_000);
    const state = seedState();

    const techPage = await newOperatorPage(browser, E2E_TECH_EMAIL, E2E_TECH_PASSWORD);
    const { orderId, externalOrderNumber } = await intakeOrder(techPage, request, state, "CXL");

    // CancelOrder has no UI surface; dispatched through the command
    // bus with the required disposition reason + actor stamp.
    dispatchCommand("cancel-order", orderId, "DATA_ENTRY_ERROR");

    await techPage.goto(`/ops/orders/${orderId}`);
    await expect(techPage.getByText("Cancelled").first()).toBeVisible({ timeout: 15_000 });

    // Terminal: the typing queue offers no work on it. (KNOWN PRODUCT
    // BUG, reported not fixed: CancelOrder skips the bucket move on
    // the assumption that "the UI filters by status", but
    // list-orders-in-bucket filters by bucket only — so the cancelled
    // row stays VISIBLE in the queue. It is inert: no action renders
    // for a CANCELLED status. Asserting the truthful current behavior;
    // tighten to toHaveCount(0) once the bucket move is fixed.)
    await techPage.goto("/ops/typing");
    const cancelledRow = queueRow(techPage, externalOrderNumber);
    await expect(cancelledRow.getByRole("button", { name: "Claim · Start typing" })).toHaveCount(0);
  });
});

/**
 * Run scripts/e2e-dispatch.ts synchronously against the e2e database.
 * See that file's header for why these three commands cannot run
 * through the UI yet.
 */
function dispatchCommand(action: string, orderId: string, reason: string): void {
  execFileSync("pnpm", ["tsx", "scripts/e2e-dispatch.ts", action, orderId, reason], {
    cwd: repoRoot,
    stdio: ["ignore", "pipe", "inherit"],
    env: {
      ...process.env,
      DATABASE_URL: E2E_DATABASE_URL,
      DIRECT_URL: E2E_DATABASE_URL,
      PHARMAX_LOCAL_KMS_SEED: E2E_KMS_SEED,
    },
  });
}
