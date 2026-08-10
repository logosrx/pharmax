// Body parsing for operator action routes — the one place that
// decides what a request body is, so that a malformed body is a
// clean, redirectable refusal instead of an unhandled 500.
//
// The failure this guards: every ops action is a server-rendered
// form POST, and `request.formData()` THROWS on a body that is not
// form-encoded or multipart (a `text/plain` POST, a curl with no
// content-type, a truncated body). Unguarded, that throw escapes the
// route handler as a 500 with a stack trace — no flash message, no
// redirect, and an operator staring at a Next.js error page. The
// JSON branch always had a `.catch`; the form branch did not.
//
// Malformed JSON deliberately degrades to `{}` rather than an error,
// preserving the long-standing behaviour of every JSON-accepting ops
// route: the empty record flows into the route's own field
// validation, which produces a field-level message ("disposition is
// required") that is more useful than "body unreadable".

import "server-only";

export type OpsRequestBody =
  | {
      readonly ok: true;
      readonly bodyKind: "form";
      readonly body: FormData;
    }
  | {
      readonly ok: true;
      readonly bodyKind: "json";
      readonly body: Record<string, unknown>;
    }
  | {
      readonly ok: false;
      /** Flash-ready `CODE: message` payload. Never echoes body content. */
      readonly error: string;
    };

export const OPS_REQUEST_BODY_INVALID = "OPS_REQUEST_BODY_INVALID";

/**
 * Parse an ops action request body as JSON (when the content type
 * says so) or form data (otherwise, matching what browser forms
 * send). Never throws on caller-controlled input.
 */
export async function parseOpsRequestBody(request: Request): Promise<OpsRequestBody> {
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    return { ok: true, bodyKind: "json", body };
  }
  try {
    return { ok: true, bodyKind: "form", body: await request.formData() };
  } catch {
    return {
      ok: false,
      error:
        `${OPS_REQUEST_BODY_INVALID}: The request body could not be read as a form ` +
        `submission. Re-submit from the page form; programmatic clients must send ` +
        `form-encoded, multipart, or application/json bodies.`,
    };
  }
}
