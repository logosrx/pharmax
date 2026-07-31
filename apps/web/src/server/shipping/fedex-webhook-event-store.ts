// Wires the Prisma-backed `FedExWebhookEventStore` to the singleton
// Prisma client. Production store for the FedEx AIV webhook route.
// Tests use `InMemoryFedExWebhookEventStore` from `@pharmax/shipping`
// directly and never reach this module.

import "server-only";

import { prisma } from "@pharmax/database";
import { PrismaFedExWebhookEventStore } from "@pharmax/shipping";

export const fedExWebhookEventStore = new PrismaFedExWebhookEventStore(prisma);
