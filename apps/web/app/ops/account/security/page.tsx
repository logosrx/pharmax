// /ops/account/security — the operator's own second-factor settings
// (ADR-0036).
//
// Self-service surface: shows the account's authenticator state (TOTP,
// security keys, remaining recovery codes) and hosts the WebAuthn
// registration ceremony. No RBAC permission gate — every operator
// manages their own factors; the data loader is self-scoped to the
// session's userId.

import { PageHeader, Section } from "../../../../src/components/ui/page.js";
import { Table, THead, TH, TBody, TR, TD } from "../../../../src/components/ui/data.js";
import { Badge } from "../../../../src/components/ui/badge.js";
import { EmptyState } from "../../../../src/components/ui/feedback.js";
import { AccountNav } from "../../../../src/components/account/account-nav.js";
import { WebAuthnRegister } from "../../../../src/components/auth/webauthn-register.js";
import { resolveOperatorTenancyContext } from "../../../../src/server/auth/resolve-tenancy.js";
import { getAccountSecurity } from "../../../../src/server/ops/get-account-security.js";

function formatDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export default async function AccountSecurityPage() {
  const session = await resolveOperatorTenancyContext();
  if (!session.ok) return null;

  const security = await getAccountSecurity({
    organizationId: session.tenancy.organizationId,
    userId: session.tenancy.actor.userId,
  });

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Account"
        title="Security"
        description="Second factors protecting your sign-in."
      />

      <AccountNav />

      <Section title="Authenticator app">
        {security.totpEnrolled ? (
          <p className="text-sm text-fg">
            <Badge tone="success">enrolled</Badge>{" "}
            <span className="text-fg-muted">
              A time-based one-time-code app is active on this account.
            </span>
          </p>
        ) : (
          <p className="text-sm text-fg-muted">No authenticator app is enrolled.</p>
        )}
      </Section>

      <Section title="Security keys & passkeys">
        {security.webAuthnCredentials.length === 0 ? (
          <EmptyState
            icon="key"
            title="No security keys registered"
            description="Register a hardware key or platform passkey below for phishing-resistant sign-in."
          />
        ) : (
          <Table>
            <THead>
              <TR>
                <TH>Name</TH>
                <TH>Registered</TH>
                <TH>Last used</TH>
              </TR>
            </THead>
            <TBody>
              {security.webAuthnCredentials.map((credential) => (
                <TR key={credential.id}>
                  <TD>{credential.label}</TD>
                  <TD>{formatDay(credential.createdAt)}</TD>
                  <TD>
                    {credential.lastUsedAt === null ? (
                      <span className="text-fg-muted">never</span>
                    ) : (
                      formatDay(credential.lastUsedAt)
                    )}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
        <div className="mt-4">
          <WebAuthnRegister />
        </div>
      </Section>

      <Section title="Recovery codes">
        <p className="text-sm text-fg-muted">
          {security.unusedRecoveryCodes > 0 ? (
            <>
              <span className="font-medium text-fg">{security.unusedRecoveryCodes}</span> unused
              recovery code{security.unusedRecoveryCodes === 1 ? "" : "s"} remaining. Each code
              works once.
            </>
          ) : (
            "No recovery codes on file. They are minted when you enroll your first authenticator."
          )}
        </p>
      </Section>
    </div>
  );
}
