// Worker-tier delivery adapter for provider-portal setup links
// (ADR-0033, slice 2) — the worker twin of apps/web's
// `password-reset-mailer.ts`, implementing the `@pharmax/providers`
// `PortalSetupMailer` port.
//
// The raw setup token is a bearer secret: it is delivered here and
// nowhere else — never written to command_log / event_outbox (the
// issuing command redacts it).
//
// Transport: a DIRECT Resend send. This is a PHI-free transactional
// email (prescriber office contact + a link), the same posture as
// the auth credential-setup mails — deliberately not routed through
// the `@pharmax/notifications` channel/ledger.
//
// Delivery status:
//   - dev / test: logs the setup link (magic-link-in-console
//     pattern) so the flow is testable without a mail provider.
//   - production: sends via Resend when RESEND_API_KEY +
//     NOTIFICATION_FROM_EMAIL are set; otherwise warns (WITHOUT the
//     token) so a misconfig is observable rather than silent.

import type { PortalSetupDelivery, PortalSetupMailer } from "@pharmax/providers";
import { Resend } from "resend";

import { env } from "./env.js";
import { logger } from "./logger.js";

const log = logger.child({ component: "portal-setup-mailer" });

function buildLink(delivery: PortalSetupDelivery): string {
  const base = env.PORTAL_BASE_URL ?? env.OPS_CONSOLE_BASE_URL;
  return `${base}/portal/setup?token=${encodeURIComponent(delivery.rawToken)}`;
}

function renderEmail(
  delivery: PortalSetupDelivery,
  link: string
): { subject: string; html: string; text: string } {
  const expires = delivery.expiresAt.toUTCString();
  return {
    subject: "Your provider portal access is approved",
    text: `Hello ${delivery.displayName},\n\nYour provider application was approved. Set your portal password to activate your account:\n\n${link}\n\nThis link expires ${expires}. If you weren't expecting this, ignore this email.`,
    html: [
      `<div style="font-family:Inter,system-ui,sans-serif;max-width:480px;margin:0 auto;color:#1a1a1a">`,
      `<h1 style="font-size:20px">Your provider portal access is approved</h1>`,
      `<p>Hello ${delivery.displayName},</p>`,
      `<p>Your provider application was approved. Set your portal password to activate your account.</p>`,
      `<p style="margin:24px 0"><a href="${link}" style="background:#6b66f1;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;display:inline-block">Set your password</a></p>`,
      `<p style="font-size:13px;color:#666">This link expires ${expires}. If you weren't expecting this, you can ignore this email.</p>`,
      `</div>`,
    ].join(""),
  };
}

let resendClient: Resend | null = null;
function getResend(): Resend | null {
  if (typeof env.RESEND_API_KEY !== "string" || env.RESEND_API_KEY.length === 0) return null;
  if (resendClient === null) resendClient = new Resend(env.RESEND_API_KEY);
  return resendClient;
}

export const portalSetupMailer: PortalSetupMailer = {
  async sendPortalSetup(delivery: PortalSetupDelivery): Promise<void> {
    const link = buildLink(delivery);

    if (env.NODE_ENV !== "production") {
      // Dev magic-link: token intended to be copy-pasted from the
      // console during local testing. Never reached in production.
      log.info("portal_setup_mailer.dev_link", {
        portalAccountId: delivery.portalAccountId,
        organizationId: delivery.organizationId,
        url: link,
      });
      return;
    }

    const resend = getResend();
    const from = env.NOTIFICATION_FROM_EMAIL;
    if (resend === null || typeof from !== "string" || from.length === 0) {
      log.warn("portal_setup_mailer.delivery_not_wired", {
        portalAccountId: delivery.portalAccountId,
        organizationId: delivery.organizationId,
        reason: "RESEND_API_KEY or NOTIFICATION_FROM_EMAIL unset",
      });
      return;
    }

    const rendered = renderEmail(delivery, link);
    try {
      await resend.emails.send({
        from,
        to: delivery.email,
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
      });
      log.info("portal_setup_mailer.sent", {
        portalAccountId: delivery.portalAccountId,
        organizationId: delivery.organizationId,
      });
    } catch (cause) {
      // Surface without the token; the drain treats delivery as
      // best-effort.
      log.error("portal_setup_mailer.send_failed", {
        portalAccountId: delivery.portalAccountId,
        organizationId: delivery.organizationId,
        error: cause,
      });
    }
  },
};
