// Singleton PrismaClient. Server-only.
//
// The cached `globalThis` reference avoids spawning a new client on each
// hot-module reload during `next dev`, which would otherwise exhaust
// Postgres connections in a few seconds.

import process from "node:process";

import { PrismaClient } from "./generated/client/index.js";

type GlobalWithPrisma = typeof globalThis & {
  __pharmaxPrisma?: PrismaClient;
};

const globalForPrisma = globalThis as GlobalWithPrisma;

const isProduction = process.env["NODE_ENV"] === "production";

export const prisma: PrismaClient =
  globalForPrisma.__pharmaxPrisma ??
  new PrismaClient({
    log: isProduction ? ["error"] : ["warn", "error"],
  });

if (!isProduction) {
  globalForPrisma.__pharmaxPrisma = prisma;
}
