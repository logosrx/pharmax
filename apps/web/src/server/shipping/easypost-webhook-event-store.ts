// Wires the Prisma-backed `EasyPostWebhookEventStore` to the singleton
// Prisma client. This is the production store used by the webhook
// route. Tests use `InMemoryEasyPostWebhookEventStore` from
// `@pharmax/shipping` directly and never reach this module.

import "server-only";

import { prisma } from "@pharmax/database";
import { PrismaEasyPostWebhookEventStore } from "@pharmax/shipping";

export const easyPostWebhookEventStore = new PrismaEasyPostWebhookEventStore(prisma);
