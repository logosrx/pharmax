// Typed errors for the EasyPost webhook pipeline.
//
// Modeled on `@pharmax/platform-core/billing`'s error surface so the
// HTTP transport and the worker drain branch on outcome without
// try/catch around untyped errors.

export class EasyPostWebhookEventNotFoundError extends Error {
  public readonly code = "EASYPOST_WEBHOOK_EVENT_NOT_FOUND";
  constructor(externalEventId: string) {
    super(`EasyPost webhook event not found: ${externalEventId}`);
    this.name = "EasyPostWebhookEventNotFoundError";
  }
}
