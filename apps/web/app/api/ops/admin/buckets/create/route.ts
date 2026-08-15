// POST /api/ops/admin/buckets/create — dispatch CreateBucket and
// redirect back to the list with a flash message.

import { CreateBucket } from "@pharmax/orgs";

import { dispatchOpsCommand } from "../../../../../../src/server/ops/dispatch-from-route.js";

export const dynamic = "force-dynamic";

function readString(body: FormData | Record<string, unknown>, key: string): string {
  const v = body instanceof FormData ? body.get(key) : body[key];
  return typeof v === "string" ? v : "";
}

const ASSIGNABLE_KINDS = new Set(["CUSTOM", "HOLD", "EXCEPTION"]);
type AssignableKind = "CUSTOM" | "HOLD" | "EXCEPTION";

export async function POST(request: Request): Promise<Response> {
  return dispatchOpsCommand({
    request,
    command: CreateBucket,
    buildInput: ({ body }) => {
      // `code` is upper-cased here as a convenience so an operator
      // typing `prior_auth` is not bounced by the schema. Everything
      // else about the code — shape, reservation, uniqueness — is
      // decided by the command, which is the source of truth.
      const code = readString(body, "code").trim().toUpperCase();
      const name = readString(body, "name").trim();
      const kindRaw = readString(body, "kind").trim();
      const sortOrderRaw = readString(body, "sortOrder").trim();
      const siteId = readString(body, "siteId").trim();

      if (code.length === 0) return { error: "code is required" };
      if (name.length === 0) return { error: "name is required" };
      if (!ASSIGNABLE_KINDS.has(kindRaw)) {
        return { error: "kind must be one of CUSTOM, HOLD, EXCEPTION" };
      }

      const sortOrder = sortOrderRaw.length === 0 ? 100 : Number(sortOrderRaw);
      if (!Number.isInteger(sortOrder) || sortOrder < 0) {
        return { error: "sortOrder must be a non-negative whole number" };
      }

      return {
        code,
        name,
        kind: kindRaw as AssignableKind,
        sortOrder,
        ...(siteId.length > 0 ? { siteId } : {}),
      };
    },
    idempotencyKeyPrefix: "ops:bucket:create",
    successRedirect: (out) =>
      "/ops/admin/buckets?flash=" + encodeURIComponent(`Bucket ${out.code} created.`),
    failureRedirect: "/ops/admin/buckets/new",
    successLogEvent: "ops.bucket.create.ok",
    failureLogEvent: "ops.bucket.create.fail",
  });
}
