// Id → registry-code lookups for the command routes.
//
// The compliance commands address their targets by stable CODE
// ("CC6.1-2", "audit.chain_head_consistency") while the detail pages
// route by uuid. Something has to bridge the two, and doing it here
// rather than with a hidden form field is the point: a code posted by
// the browser is a code the operator can edit, which would let a
// sign-off submitted from one control's page land on another. The
// route resolves the code from the id in the URL it already trusts.

import "server-only";

import { readCompliance } from "./read-context.js";

export async function getControlCodeById(controlId: string): Promise<string | null> {
  return readCompliance("resolve-control-code", async (tx) => {
    const row = await tx.complianceControl.findUnique({
      where: { id: controlId },
      select: { code: true },
    });
    return row?.code ?? null;
  });
}

export async function getCheckCodeById(checkId: string): Promise<string | null> {
  return readCompliance("resolve-check-code", async (tx) => {
    const row = await tx.complianceCheck.findUnique({
      where: { id: checkId },
      select: { code: true },
    });
    return row?.code ?? null;
  });
}
