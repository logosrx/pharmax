// ResendNotificationChannel — production email adapter.
//
// Implements `NotificationChannel` against the Resend HTTP API
// (`resend` SDK). Routes only `to.kind === "email"`; any other
// recipient kind surfaces as `NOTIFICATION_RECIPIENT_KIND_UNSUPPORTED`
// at the standard channel guard.
//
// Idempotency: Resend supports an `Idempotency-Key` header on send.
// We pass the caller's `idempotencyKey` straight through so two
// outbox-handler retries with the same key resolve to the SAME
// Resend message id rather than producing two emails. The
// adapter does NOT maintain its own dedupe cache — Resend's
// server-side dedupe is the load-bearing guarantee.
//
// Transport failures: any non-2xx from Resend (or an unhandled
// network error from `fetch`) is translated to a `PharmaxError`
// with code `NOTIFICATION_TRANSPORT_ERROR`. The outbox drainer
// catches and reschedules with exponential backoff. The full
// underlying error is preserved via `cause` for Sentry.
//
// PHI invariant: Resend is NOT a PHI-eligible transport in our
// current posture (no signed BAA). The channel reports
// `phiCapable: false`; the registry's `assertNoPhiInContext` gate
// will reject any context payload whose top-level keys match the
// PHI sentinel list. To send PHI via email in the future you'd
// either flip `phiCapable: true` AFTER a BAA review AND the
// template's `phiAllowed` flag, OR (more likely) route PHI-
// bearing notifications to an in-app channel that doesn't leave
// the trust boundary.

import { errors } from "@pharmax/platform-core";
import {
  assertChannelSupportsRecipient,
  assertNoPhiInContext,
  assertRequiredContextKeysPresent,
  assertTemplateAllowsRecipient,
  getTemplate,
  NOTIFICATION_TRANSPORT_ERROR,
  type NotificationChannel,
  type NotificationChannelMetadata,
  type NotificationRecipientKind,
  type NotificationSendInput,
  type NotificationSendResult,
} from "@pharmax/notifications";
import { Resend } from "resend";

import {
  renderReportCompletedEmail,
  type ReportCompletedRenderInput,
} from "./render-report-completed-email.js";

/**
 * Narrow contract over Resend's `emails.send` for testing — the
 * adapter calls only this slice, so unit tests pass a stub that
 * implements the same shape without bundling the SDK.
 */
export interface ResendSendApi {
  send(input: {
    readonly from: string;
    readonly to: ReadonlyArray<string>;
    readonly subject: string;
    readonly text: string;
    readonly html: string;
    readonly headers: Readonly<Record<string, string>>;
  }): Promise<{
    readonly data: { id: string } | null;
    readonly error: { name?: string; message?: string } | null;
  }>;
}

export interface ResendNotificationChannelOptions {
  /** Resend API key (`re_...`). When unset, the channel CANNOT
   *  be constructed — callers should fall back to
   *  `InMemoryNotificationChannel` at boot. */
  readonly apiKey: string;
  /** Verified sender address registered with Resend. MUST be in a
   *  verified domain or Resend rejects the send. */
  readonly fromAddress: string;
  /** Override the underlying Resend client (tests). Production
   *  leaves this undefined and we construct `new Resend(apiKey)`. */
  readonly sendApi?: ResendSendApi;
  /** Channel name reported in metadata + error envelopes. */
  readonly name?: string;
}

const DEFAULT_NAME = "resend-email";
const SUPPORTED_KINDS: ReadonlyArray<NotificationRecipientKind> = Object.freeze(["email"]);

export class ResendNotificationChannel implements NotificationChannel {
  public readonly metadata: NotificationChannelMetadata;

  private readonly api: ResendSendApi;
  private readonly fromAddress: string;

  constructor(options: ResendNotificationChannelOptions) {
    this.metadata = Object.freeze({
      name: options.name ?? DEFAULT_NAME,
      supportedRecipientKinds: SUPPORTED_KINDS,
      phiCapable: false,
    });
    this.fromAddress = options.fromAddress;
    this.api = options.sendApi ?? buildDefaultSendApi(options.apiKey);
  }

  async send(input: NotificationSendInput): Promise<NotificationSendResult> {
    // Validation gates run first — uniform with InMemoryNotificationChannel.
    const template = getTemplate(input.template);
    assertChannelSupportsRecipient(this.metadata, input.to);
    assertTemplateAllowsRecipient(template, input.to);
    assertRequiredContextKeysPresent(template, input.context);
    assertNoPhiInContext(template, this.metadata, input.context);

    const rendered = renderTemplate(input.template, input.context);

    let response: Awaited<ReturnType<ResendSendApi["send"]>>;
    try {
      response = await this.api.send({
        from: this.fromAddress,
        to: [input.to.address],
        subject: rendered.subject,
        text: rendered.text,
        html: rendered.html,
        headers: {
          "Idempotency-Key": input.idempotencyKey,
        },
      });
    } catch (cause) {
      throw new errors.InternalError({
        code: NOTIFICATION_TRANSPORT_ERROR,
        message: "Resend transport failed before a response was returned.",
        metadata: { channelName: this.metadata.name, template: input.template },
        cause,
      });
    }

    if (response.error !== null && response.error !== undefined) {
      throw new errors.InternalError({
        code: NOTIFICATION_TRANSPORT_ERROR,
        message: `Resend rejected the send: ${response.error.message ?? "unknown error"}`,
        metadata: {
          channelName: this.metadata.name,
          template: input.template,
          vendorErrorName: response.error.name ?? null,
        },
      });
    }

    if (response.data === null) {
      throw new errors.InternalError({
        code: NOTIFICATION_TRANSPORT_ERROR,
        message: "Resend returned no data and no error — malformed response.",
        metadata: { channelName: this.metadata.name, template: input.template },
      });
    }

    return Object.freeze({
      deliveryId: response.data.id,
      // Resend doesn't distinguish "delivered" from "queued" at
      // the API boundary — every accepted send is `delivered` from
      // our perspective. Bounces / spam events surface via the
      // Resend webhook (future slice).
      status: "delivered" as const,
      recipientKind: input.to.kind,
      sentAt: new Date(),
    });
  }
}

/**
 * Build a thin adapter around the real Resend SDK that conforms
 * to `ResendSendApi`. Kept narrow so the prod constructor and the
 * unit tests share one contract.
 */
function buildDefaultSendApi(apiKey: string): ResendSendApi {
  const client = new Resend(apiKey);
  return {
    async send(input) {
      const result = await client.emails.send({
        from: input.from,
        to: [...input.to],
        subject: input.subject,
        text: input.text,
        html: input.html,
        headers: { ...input.headers },
      });
      return {
        data: result.data ?? null,
        error: result.error ?? null,
      };
    },
  };
}

/**
 * Render the right template for the input id. Today there's one
 * template the worker fires; adding another is one more case here
 * and one more renderer file. We narrow context at the renderer
 * boundary (each renderer asserts its own required-keys shape).
 */
function renderTemplate(
  templateId: NotificationSendInput["template"],
  context: Readonly<Record<string, unknown>>
): { subject: string; text: string; html: string } {
  switch (templateId) {
    case "REPORT_RUN_COMPLETED_V1": {
      const narrowed = coerceReportCompletedContext(context);
      return renderReportCompletedEmail(narrowed);
    }
    default:
      // Defensive: the channel guards have already validated that
      // the recipient kind matches the template's channelKinds,
      // but a template the registry says is `email`-capable
      // without a renderer here is a wiring bug — surface it
      // loudly rather than send a blank email.
      throw new errors.InternalError({
        code: "NOTIFICATION_RENDERER_MISSING",
        message: `ResendNotificationChannel has no renderer for template "${templateId}".`,
        metadata: { templateId },
      });
  }
}

function coerceReportCompletedContext(
  ctx: Readonly<Record<string, unknown>>
): ReportCompletedRenderInput {
  const rs = ctx["runStatus"];
  if (rs !== "SUCCEEDED" && rs !== "FAILED" && rs !== "SKIPPED") {
    throw new errors.ValidationError({
      code: "NOTIFICATION_CONTEXT_INVALID",
      message: "REPORT_RUN_COMPLETED_V1 context: runStatus must be SUCCEEDED/FAILED/SKIPPED",
      metadata: { receivedRunStatus: typeof rs === "string" ? rs : typeof rs },
    });
  }
  return {
    scheduleName: String(ctx["scheduleName"]),
    reportTitle: String(ctx["reportTitle"]),
    runStatus: rs,
    windowFromIso: String(ctx["windowFromIso"]),
    windowToIso: String(ctx["windowToIso"]),
    generatedAtIso: String(ctx["generatedAtIso"]),
    rowCount: Number(ctx["rowCount"] ?? 0),
    aggregates: (ctx["aggregates"] as Readonly<Record<string, number>>) ?? {},
    dashboardLink: String(ctx["dashboardLink"]),
    ...(typeof ctx["downloadLink"] === "string"
      ? { downloadLink: ctx["downloadLink"] as string }
      : {}),
    ...(typeof ctx["errorCode"] === "string" ? { errorCode: ctx["errorCode"] as string } : {}),
  };
}
