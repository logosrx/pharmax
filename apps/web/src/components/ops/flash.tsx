// QueueFlash — renders the success/error flash carried in the URL.
//
// The command routes redirect back with `?flash=<key>&orderId=<id>`
// on success or `?error=<message>` on failure. This centralizes the
// two ad-hoc banner blocks every queue page used to hand-roll.

import { Banner } from "../ui/feedback.js";

function pick(params: Record<string, string | string[] | undefined>, key: string): string | null {
  const v = params[key];
  return typeof v === "string" ? v : null;
}

export function QueueFlash({
  params,
  messages,
}: {
  readonly params: Record<string, string | string[] | undefined>;
  readonly messages: Readonly<Record<string, string>>;
}) {
  const flashKey = pick(params, "flash");
  const orderId = pick(params, "orderId");
  const error = pick(params, "error");

  return (
    <>
      {flashKey !== null && messages[flashKey] !== undefined ? (
        <Banner tone="success">
          {messages[flashKey]} {orderId !== null ? <code>{orderId}</code> : null}
        </Banner>
      ) : null}
      {error !== null ? (
        <Banner tone="danger" title="That action didn't go through">
          {error}
        </Banner>
      ) : null}
    </>
  );
}
