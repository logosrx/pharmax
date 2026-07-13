// Web-tier delivery adapter for credential-setup links (ADR-0030).
//
// Implements the `@pharmax/auth` `PasswordResetMailer` port for both
// flows (invite + password reset). The raw token is delivered here and
// nowhere else persisted — it is never written to command_log / outbox.
//
// Transport: a DIRECT Resend send for these two PHI-free transactional
// emails. We deliberately do NOT route them through the
// `@pharmax/notifications` channel/ledger — that channel's Resend
// adapter lives in apps/worker with its own renderers, and these auth
// messages are low-volume, operator-facing, and PHI-free. (If delivery
// tracking in `notification_delivery` is later wanted, promote the
// Resend channel to a shared package and switch this adapter to it.)
//
// Delivery status:
//   - dev / test: logs the setup link (the "magic link in the console"
//     pattern) so the flow is testable without a mail provider. The
//     token appears ONLY in dev logs, never in production.
//   - production: sends via Resend when RESEND_API_KEY +
//     NOTIFICATION_FROM_EMAIL are set; otherwise warns (WITHOUT the
//     token) so a misconfig is observable rather than silent.

import "server-only";

import type { PasswordResetDelivery, PasswordResetMailer } from "@pharmax/auth";
import { Resend } from "resend";

import { env } from "../env.js";
import { logger } from "../logger.js";

function baseUrl(): string {
  return env.APP_BASE_URL ?? "http://localhost:3000";
}

function buildLink(delivery: PasswordResetDelivery): string {
  const path = delivery.kind === "invite" ? "/accept-invite" : "/reset-password";
  return `${baseUrl()}${path}?token=${encodeURIComponent(delivery.rawToken)}`;
}

interface RenderedEmail {
  readonly subject: string;
  readonly html: string;
  readonly text: string;
}

function renderEmail(delivery: PasswordResetDelivery, link: string): RenderedEmail {
  const expires = delivery.expiresAt.toUTCString();
  if (delivery.kind === "invite") {
    return {
      subject: "You're invited to Pharmax",
      text: `You've been invited to Pharmax. Set your password to activate your account:\n\n${link}\n\nThis link expires ${expires}. If you weren't expecting this, ignore this email.`,
      html: emailShell(
        "You're invited to Pharmax",
        `<p>You've been invited to the Pharmax operations console. Set your password to activate your account.</p>`,
        "Set your password",
        link,
        `This link expires ${expires}. If you weren't expecting this, you can ignore this email.`
      ),
    };
  }
  return {
    subject: "Reset your Pharmax password",
    text: `A password reset was requested for your Pharmax account. Set a new password:\n\n${link}\n\nThis link expires ${expires}. If you didn't request this, ignore this email — your password is unchanged.`,
    html: emailShell(
      "Reset your Pharmax password",
      `<p>A password reset was requested for your Pharmax account.</p>`,
      "Reset password",
      link,
      `This link expires ${expires}. If you didn't request this, ignore this email — your password is unchanged.`
    ),
  };
}

function emailShell(
  heading: string,
  intro: string,
  cta: string,
  link: string,
  footer: string
): string {
  return [
    `<div style="font-family:Inter,system-ui,sans-serif;max-width:480px;margin:0 auto;color:#1a1a1a">`,
    `<h1 style="font-size:20px">${heading}</h1>`,
    intro,
    `<p style="margin:24px 0"><a href="${link}" style="background:#6b66f1;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;display:inline-block">${cta}</a></p>`,
    `<p style="font-size:13px;color:#666">${footer}</p>`,
    `</div>`,
  ].join("");
}

let resendClient: Resend | null = null;
function getResend(): Resend | null {
  if (typeof env.RESEND_API_KEY !== "string" || env.RESEND_API_KEY.length === 0) return null;
  if (resendClient === null) resendClient = new Resend(env.RESEND_API_KEY);
  return resendClient;
}

export const notificationPasswordResetMailer: PasswordResetMailer = {
  async sendPasswordReset(delivery: PasswordResetDelivery): Promise<void> {
    const link = buildLink(delivery);

    if (process.env["NODE_ENV"] !== "production") {
      // Dev magic-link: token intended to be copy-pasted from the
      // console during local testing. Never reached in production.
      logger.info("auth.mailer.dev_link", {
        kind: delivery.kind,
        userId: delivery.userId,
        organizationId: delivery.organizationId,
        url: link,
      });
      return;
    }

    const resend = getResend();
    const from = env.NOTIFICATION_FROM_EMAIL;
    if (resend === null || typeof from !== "string" || from.length === 0) {
      logger.warn("auth.mailer.delivery_not_wired", {
        kind: delivery.kind,
        userId: delivery.userId,
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
      logger.info("auth.mailer.sent", {
        kind: delivery.kind,
        userId: delivery.userId,
        organizationId: delivery.organizationId,
      });
    } catch (cause) {
      // Surface without the token. The caller (invite route onSuccess /
      // requestPasswordReset) treats delivery as best-effort.
      logger.error("auth.mailer.send_failed", {
        kind: delivery.kind,
        userId: delivery.userId,
        organizationId: delivery.organizationId,
        error: cause,
      });
    }
  },
};
