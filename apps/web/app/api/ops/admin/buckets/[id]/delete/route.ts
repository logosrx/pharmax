// POST /api/ops/admin/buckets/[id]/delete — dispatch DeleteBucket and
// redirect back to the list with a flash message.
//
// The command refuses system buckets and buckets still holding orders,
// so the failure redirect lands back on the edit page where the banner
// can show which of the two happened (and, for the orders case, how
// many need moving).

import { DeleteBucket } from "@pharmax/orgs";

import { dispatchOpsCommand } from "../../../../../../../src/server/ops/dispatch-from-route.js";

export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const { id } = await params;
  return dispatchOpsCommand({
    request,
    command: DeleteBucket,
    buildInput: () => ({ bucketId: id }),
    idempotencyKeyPrefix: `ops:bucket:delete:${id}`,
    successRedirect: (out) =>
      "/ops/admin/buckets?flash=" + encodeURIComponent(`Bucket ${out.code} deleted.`),
    failureRedirect: `/ops/admin/buckets/${id}/edit`,
    successLogEvent: "ops.bucket.delete.ok",
    failureLogEvent: "ops.bucket.delete.fail",
  });
}
