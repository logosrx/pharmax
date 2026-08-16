// Public-surface smoke: proves the console boots and serves its
// unauthenticated surfaces through a real browser. No database rows
// are touched; these tests must stay runnable even when seeding is
// unavailable.

import { expect, test, type Page } from "@playwright/test";

/** Collect console + page errors so a render that "works" but logs
 * errors still fails the smoke. */
function trackErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => {
    errors.push(String(error));
  });
  return errors;
}

test.describe("public surfaces", () => {
  test("health endpoint returns 200 ok", async ({ request }) => {
    const response = await request.get("/api/health");
    expect(response.status()).toBe(200);
    const body = (await response.json()) as { status?: string; service?: string };
    expect(body.status).toBe("ok");
    expect(body.service).toBe("pharmacy-os");
  });

  test("unauthenticated / redirects to sign-in, which renders without errors", async ({ page }) => {
    const errors = trackErrors(page);

    await page.goto("/");
    // proxy.ts: protected page routes bounce sessionless visitors.
    await expect(page).toHaveURL(/\/sign-in/);

    await expect(page.getByRole("heading", { name: "Welcome back" })).toBeVisible();
    await expect(page.getByLabel("Email")).toBeVisible();
    await expect(page.getByLabel("Password")).toBeVisible();
    await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();

    expect(errors).toEqual([]);
  });

  test("protected API routes reject sessionless callers with 401", async ({ request }) => {
    const response = await request.get("/api/ops/queue/stream", {
      // Assert the proxy's own 401, not a redirect chase.
      maxRedirects: 0,
    });
    expect(response.status()).toBe(401);
  });
});
