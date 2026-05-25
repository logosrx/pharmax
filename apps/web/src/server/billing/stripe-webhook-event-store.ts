// Wires the Prisma-backed `StripeWebhookEventStore` to the singleton
// Prisma client. This is the production store used by the webhook
// route. Tests use the in-memory store from `@pharmax/platform-core`
// directly and never reach this module.

import "server-only";

import { billing, prisma } from "@pharmax/database";

export const stripeWebhookEventStore = new billing.PrismaStripeWebhookEventStore(prisma);
