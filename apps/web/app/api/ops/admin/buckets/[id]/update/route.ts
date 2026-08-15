// POST /api/ops/admin/buckets/[id]/update — dispatch UpdateBucket and
// redirect back to the list with a flash message.
//
// `kind` is only forwarded when the form actually rendered the field
// (custom buckets). The edit page omits it entirely for system buckets,
// so a system bucket save arrives with name + sortOrder alone and the
// command's system-field guard is never even reached. That is UI
// convenience, not enforcement: a hand-crafted POST carrying a kind for
// a system bucket is refused server-side by UpdateBucket.

import { UpdateBucket } from "@pharmax/orgs";

import { dispatchOpsCommand } from "../../../../../../../src/server/ops/dispatch-from-route.js";

export const dynamic = "force-dynamic";

function readString(body: FormData | Record<string, unknown>, key: string): string {
  const v = body instanceof FormData ? body.get(key) : body[key];
  return typeof v === "string" ? v : "";
}

const BUCKET_KINDS = new Set(["WORKFLOW", "EMERGENCY", "HOLD", "EXCEPTION", "CUSTOM"]);
type BucketKindValue = "WORKFLOW" | "EMERGENCY" | "HOLD" | "EXCEPTION" | "CUSTOM";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const { id } = await params;
  return dispatchOpsCommand({
    request,
    command: UpdateBucket,
    buildInput: ({ body }) => {
      const name = readString(body, "name").trim();
      const sortOrderRaw = readString(body, "sortOrder").trim();
      const kindRaw = readString(body, "kind").trim();

      if (name.length === 0) return { error: "name is required" };

      const sortOrder = Number(sortOrderRaw);
      if (!Number.isInteger(sortOrder) || sortOrder < 0) {
        return { error: "sortOrder must be a non-negative whole number" };
      }

      return {
        bucketId: id,
        name,
        sortOrder,
        ...(BUCKET_KINDS.has(kindRaw) ? { kind: kindRaw as BucketKindValue } : {}),
      };
    },
    idempotencyKeyPrefix: `ops:bucket:update:${id}`,
    successRedirect: (out) =>
      "/ops/admin/buckets?flash=" +
      encodeURIComponent(
        out.fieldsChanged.length === 0
          ? `Bucket ${out.code} unchanged.`
          : `Bucket ${out.code} updated (${out.fieldsChanged.join(", ")}).`
      ),
    failureRedirect: `/ops/admin/buckets/${id}/edit`,
    successLogEvent: "ops.bucket.update.ok",
    failureLogEvent: "ops.bucket.update.fail",
  });
}
