// Registry shape tests. The registry is the typed source of truth
// for "what notifications can we send"; every guard in the channel
// layer derives its behavior from the entries here. These tests
// pin: (1) the id field equals the registry key (no drift),
// (2) the type-narrowing predicate works, (3) listTemplateIds is
// non-empty and stable.

import { describe, expect, it } from "vitest";

import {
  NOTIFICATION_TEMPLATES,
  getTemplate,
  isNotificationTemplateId,
  listTemplateIds,
  type NotificationTemplateId,
} from "./template-registry.js";

describe("template-registry", () => {
  it("every template's `id` equals its registry key", () => {
    for (const key of Object.keys(NOTIFICATION_TEMPLATES)) {
      const definition = NOTIFICATION_TEMPLATES[key as NotificationTemplateId];
      expect(definition.id).toBe(key);
    }
  });

  it("every template defaults to phiAllowed: false (safe-by-default)", () => {
    for (const key of Object.keys(NOTIFICATION_TEMPLATES)) {
      const definition = NOTIFICATION_TEMPLATES[key as NotificationTemplateId];
      expect(definition.phiAllowed).toBe(false);
    }
  });

  it("isNotificationTemplateId narrows known ids and rejects unknowns", () => {
    expect(isNotificationTemplateId("INVOICE_PAYMENT_FAILED_V1")).toBe(true);
    expect(isNotificationTemplateId("not-a-real-template")).toBe(false);
    expect(isNotificationTemplateId(42)).toBe(false);
    expect(isNotificationTemplateId(undefined)).toBe(false);
  });

  it("getTemplate returns the same object referenced in the registry", () => {
    const direct = NOTIFICATION_TEMPLATES.SHIPMENT_ESCALATED_V1;
    expect(getTemplate("SHIPMENT_ESCALATED_V1")).toBe(direct);
  });

  it("listTemplateIds is non-empty and covers every registry key", () => {
    const ids = listTemplateIds();
    expect(ids.length).toBeGreaterThanOrEqual(10);
    expect(ids.slice().sort()).toEqual(Object.keys(NOTIFICATION_TEMPLATES).sort());
  });

  it("every template lists at least one supported recipient kind", () => {
    for (const id of listTemplateIds()) {
      const template = getTemplate(id);
      expect(template.channelKinds.length).toBeGreaterThan(0);
    }
  });
});
