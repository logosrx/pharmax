// Stripe singleton.
//
// Returns `null` when `STRIPE_SECRET_KEY` is unset so the rest of the
// app boots in environments without Stripe credentials. The webhook
// route checks for null and responds with 503.
//
// We pin `apiVersion` to a known value so future Stripe API shifts
// require an explicit code change rather than silently changing the
// shape of objects we receive.

import "server-only";

import Stripe from "stripe";

import { env } from "../env.js";

let cached: Stripe | null | undefined;

export function getStripe(): Stripe | null {
  if (cached !== undefined) return cached;

  if (!env.STRIPE_SECRET_KEY) {
    cached = null;
    return cached;
  }

  cached = new Stripe(env.STRIPE_SECRET_KEY, {
    // Omitting `apiVersion` pins to the SDK's default (the latest version
    // the installed Stripe package's TypeScript types reflect). Bumping
    // the SDK then becomes the explicit, reviewable place where API
    // version changes happen.
    typescript: true,
    appInfo: {
      name: "pharmacy-os",
      version: "0.1.0",
    },
  });
  return cached;
}
