// Web-tier delivery adapter for provider-portal setup links
// (ADR-0033, slice 2) — implements the `@pharmax/providers`
// `PortalSetupMailer` port for the ops review-queue approval path.
// The worker has its own twin (apps/worker/src/portal-setup-mailer.ts)
// for the automated proofing-PASS path.
//
// Same posture as `../auth/password-reset-mailer.ts`: the raw token
// is delivered here and nowhere else persisted; a DIRECT Resend send
// for a PHI-free transactional email; dev logs the magic link;
// production warns (without the token) when delivery isn't wired.

import "server-only";

import type { PortalSetupDelivery, PortalSetupMailer } from "@pharmax/providers";
import { Resend } from "resend";

import { env } from "../env.js";
import { logger } from "../logger.js";

const log = logger.child({ component: "portal-setup-mailer" });

function buildLink(delivery: PortalSetupDelivery): string {
  const base = env.APP_BASE_URL ?? "http://localhost:3000";
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

    if (process.env["NODE_ENV"] !== "production") {
      // Dev magic-link (console copy-paste pattern; never in prod).
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
      // Surface without the token. Best-effort — ops can resend.
      log.error("portal_setup_mailer.send_failed", {
        portalAccountId: delivery.portalAccountId,
        organizationId: delivery.organizationId,
        error: cause,
      });
    }
  },
};
