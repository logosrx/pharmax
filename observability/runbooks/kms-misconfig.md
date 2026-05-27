# Runbook: KMS error budget exhausted

> Triggered by: `KmsErrorBudgetExhausted`. **Any** KMS failure trips
> this — there is no graceful-degradation path because PHI envelope
> encryption + audit MAC depend on KMS.

## Symptoms

- `pharmax_kms_operation_errors_total` non-zero in the last 5m.
- Pharmacy operators can't open patient records (decrypt fails).
- New orders cannot intake (encrypt fails on PHI columns).
- `daily-merkle-root-loop` reports `failed > 0` (manifest signing).
- Worker boot fails at the `AwsKmsAdapter.validate()` step — see
  `apps/worker/src/main.ts`.

## Likely causes

1. **IAM role drift.** The ECS task role lost `kms:GenerateDataKey`,
   `kms:Decrypt`, `kms:GenerateMac`, or `kms:DescribeKey` on one of the
   tenant keys. Most common after a permissions refactor.
2. **Key disabled / scheduled for deletion.** Someone disabled a key in
   the AWS console. Or a tenant offboarding shred started but the
   shred window has not elapsed.
3. **Region outage.** Rare; AWS KMS is highly available, but it does
   happen.
4. **Clock skew.** Container clock skewed > 15min from real time; KMS
   rejects the SigV4 signature.
5. **Wrong key id.** Env var `AUDIT_DATA_KEY_ID` or
   `AUDIT_SEARCH_KEY_ID` points at a key that doesn't exist or is in
   a different account.

## Investigation

1. Open Grafana **Platform Health** → "KMS" panel (alert source).
   Identify the failing `operation` (`generate_data_key`, `decrypt`,
   `generate_mac`, `describe_key`).
2. Get a sample Sentry error. The exception will name the KMS key id
   in the failure cause.
3. Confirm key status via AWS CLI:

   ```bash
   aws kms describe-key --key-id <key-id>
   # Look at: KeyState (should be "Enabled")
   #          DeletionDate (should not be set)
   #          KeyUsage     (must match operation: ENCRYPT_DECRYPT or GENERATE_VERIFY_MAC)
   ```

4. Confirm IAM permissions:

   ```bash
   aws sts get-caller-identity
   # (when assumed via the ECS task role)

   aws iam simulate-principal-policy \
     --policy-source-arn arn:aws:iam::<acct>:role/<task-role> \
     --action-names kms:GenerateDataKey kms:Decrypt kms:GenerateMac kms:DescribeKey \
     --resource-arns <key-arn>
   ```

5. Check clock skew on the running container:

   ```bash
   docker exec <container> date -u
   # Compare to: date -u (on a known-good host or `curl -sI google.com | grep -i date`)
   ```

6. Confirm the configured key id is right:

   ```bash
   docker exec <container> printenv AUDIT_DATA_KEY_ID AUDIT_SEARCH_KEY_ID
   ```

## Mitigation

- **IAM drift** — re-attach the KMS policy. Verify by re-running
  `simulate-principal-policy`. Restart the affected task to clear any
  cached credentials.
- **Key disabled** — enable it (`aws kms enable-key`). If it was
  scheduled for deletion in error, cancel deletion
  (`aws kms cancel-key-deletion`).
- **Region outage** — wait. There is no failover for envelope keys; we
  do not multi-region these. The Phase-4 region-pinning is the conscious
  trade-off.
- **Clock skew** — sync NTP. ECS Fargate tasks inherit host time but
  bare EC2 needs `chrony` / `ntpd` running.
- **Wrong key id** — fix the env var; redeploy. Until the redeploy
  lands, the platform is offline for that tenant — there is no
  workaround.

## Severity calibration

- One transient `KmsErrorBudgetExhausted` that auto-resolves → warning;
  ticket only.
- Sustained > 5 min → page on-call. Pharmacy work is blocked.
- Combined with `AuditChainVerifierFailing` or `AuditManifestStale` →
  declare SEV1; the privacy officer must be informed.

## Escalation path

- Page on-call → ECS / IAM owner → privacy officer (if PHI cannot be
  decrypted for live operators).
- Notify customer success if any tenant is blocked for > 15 minutes.

## Post-mortem

Mandatory for any KMS incident that blocked tenant work. Required
sections:

- Timeline including IAM change history (CloudTrail event ids).
- Whether PHI decryption failed for any active session.
- Whether the audit MAC chain regressed (verifier was running; what
  did it show).
