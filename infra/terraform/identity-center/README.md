# IAM Identity Center (workforce SSO + MFA)

Standalone Terraform root that provisions how **engineers/operators** sign in
to the AWS accounts (console + CLI). This is distinct from the Pharmax app's
end-user authentication, which is Clerk.

It is applied **once**, from the AWS Organizations **management or
delegated-admin account**, in the region where the IAM Identity Center
instance lives. It is intentionally separate from the per-env-region workload
stacks (IdC is an org-level singleton), mirroring the `bootstrap/` root.

## What it creates

- **Permission sets** (defaults, all MFA-enforced):
  - `Administrator` — `AdministratorAccess`, 1h session.
  - `Engineer` — `PowerUserAccess`, 8h session.
  - `ReadOnly` — `ReadOnlyAccess`, 8h session.
  - `Billing` — `job-function/Billing`, 4h session.
  - `SecurityAudit` — `SecurityAudit`, 8h session.
- A **deny-without-MFA inline policy** on each MFA-required permission set
  (`aws:MultiFactorAuthPresent` is false ⇒ deny all). Defense-in-depth on top
  of the IdC sign-in MFA prompt.
- Optional **group → permission set → account** assignments
  (`account_assignments`).

## One-time prerequisites (cannot be done in Terraform)

1. Enable IAM Identity Center for the organization (console / Organizations).
2. Choose the identity source — the built-in IdC store, or an external IdP
   (Okta/Entra/Google) via SAML + SCIM.
3. In IdC **Settings → Authentication**, require MFA at sign-in (e.g. "Always
   on", context-aware or every sign-in). The inline policy here enforces MFA
   at the authorization layer too, but the prompt is configured there.

## Apply

```bash
cd infra/terraform/identity-center
cp terraform.tfvars.example terraform.tfvars   # edit region + assignments
terraform init
terraform apply
```

Run with credentials for the management / delegated-admin account. State can
stay local for this low-churn root or use a remote backend (see the env
stacks' `backend.tf.example`).

## Notes

- The instance + identity store are **discovered** (`aws_ssoadmin_instances`),
  not created — step 1 above must be complete first.
- `account_assignments` look up groups by **display name**; the groups must
  already exist in the identity store (created in IdC or synced from your IdP).
  Start with an empty list to create the permission sets, then add assignments.
