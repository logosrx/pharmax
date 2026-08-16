// Authenticated operator smoke: signs in as the seeded synthetic
// Pharmacist (scripts/e2e-seed.ts) through the REAL sign-in form and
// walks the critical console surfaces — dashboard + queue counters,
// sidebar navigation, the ⌘K command palette, and the order search
// bar. No auth bypass: the session comes from POST /api/auth/sign-in
// exactly as production issues it.
//
// These tests run against the tenant origin (acme.localhost): sign-in
// resolves the organization from the request subdomain (ADR-0030).

import { expect, test, type Page } from "@playwright/test";

import { E2E_OPERATOR_EMAIL, E2E_OPERATOR_PASSWORD, E2E_ORG_BASE_URL } from "../env";

test.use({ baseURL: E2E_ORG_BASE_URL });

/**
 * Submit the sign-in form and wait for `expectAfterSubmit` to hold.
 *
 * Retried as a unit: against the dev server the first paint can precede
 * React hydration, and a pre-hydration click submits the form natively
 * (a GET back to /sign-in that clears the fields) instead of invoking
 * the JS handler. Re-filling inside the retry makes the flow immune to
 * that race without any arbitrary sleeps.
 */
async function submitSignIn(
  page: Page,
  password: string,
  expectAfterSubmit: () => Promise<void>
): Promise<void> {
  await page.goto("/sign-in");
  await expect(async () => {
    await page.getByLabel("Email").fill(E2E_OPERATOR_EMAIL);
    await page.getByLabel("Password").fill(password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expectAfterSubmit();
  }).toPass({ timeout: 45_000 });
}

async function signIn(page: Page): Promise<void> {
  await submitSignIn(page, E2E_OPERATOR_PASSWORD, async () => {
    await page.waitForURL("**/ops", { timeout: 10_000 });
  });
}

test.describe("operator console", () => {
  test("wrong password is rejected with a generic error", async ({ page }) => {
    await submitSignIn(page, "definitely-not-the-password", async () => {
      // Enumeration-safe message from packages/auth errors.ts.
      await expect(page.getByText("Incorrect email or password.")).toBeVisible({ timeout: 5_000 });
    });
    await expect(page).toHaveURL(/\/sign-in/);
  });

  test("sign-in lands on the dashboard with queue counters and navigation", async ({ page }) => {
    await signIn(page);

    // Role-aware greeting header renders with the operator's name.
    await expect(
      page.getByRole("heading", { name: /Good (morning|afternoon|evening), E2E/ })
    ).toBeVisible();

    // At-a-glance stats.
    await expect(page.getByText("In-flight orders")).toBeVisible();
    await expect(page.getByText("Awaiting verification")).toBeVisible();

    // Live workflow pipeline — every stage counter renders.
    await expect(page.getByText("Workflow pipeline")).toBeVisible();
    for (const stage of ["Typing", "PV1", "Fill", "Final"]) {
      await expect(page.getByText(stage, { exact: true }).first()).toBeVisible();
    }

    // Sidebar navigation + topbar order search render.
    await expect(page.locator("nav").first()).toBeVisible();
    await expect(page.getByLabel("Search or scan an order")).toBeVisible();
  });

  test("command palette opens with ⌘K, filters, and navigates", async ({ page }) => {
    await signIn(page);

    // Retried: the ⌘K listener is attached by a client component after
    // hydration, so an early keypress can land before it exists.
    const palette = page.getByRole("dialog", { name: "Command palette" });
    await expect(async () => {
      await page.keyboard.press("ControlOrMeta+k");
      await expect(palette).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 30_000 });

    await palette.getByRole("combobox").fill("account security");
    const option = palette.getByRole("option", { name: /Account security/ });
    await expect(option).toBeVisible();
    await option.click();

    await page.waitForURL("**/ops/account/security");
    await expect(palette).not.toBeVisible();
  });

  test("order search routes an unknown order to a graceful not-found", async ({ page }) => {
    await signIn(page);

    // Retried: OrderSearch is a client component whose onSubmit is
    // wired after hydration. A pre-hydration Enter triggers a native
    // form submit (no `action`) instead of `router.push`, so the URL
    // never becomes /ops/orders/... under slow first paint.
    const search = page.getByLabel("Search or scan an order");
    await expect(async () => {
      await search.fill("E2E-UNKNOWN-ORDER");
      await search.press("Enter");
      await page.waitForURL("**/ops/orders/E2E-UNKNOWN-ORDER", { timeout: 5_000 });
    }).toPass({ timeout: 30_000 });
    await expect(page.getByRole("heading", { name: "Order not found" })).toBeVisible();
  });
});
