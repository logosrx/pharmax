---
name: verify-pharmax-production
description: Verify and diagnose Pharmax production on AWS — SSO auth, Aurora/RDS health, ECS service health, CloudWatch crash diagnosis, DB connection-role and RLS posture, and in-VPC SQL probes via ECS Exec or a one-off Fargate task. Use when asked to "check prod", "is prod connected/healthy", why an ECS service is down or crash-looping, whether the production database is reachable, or whether RLS is actually enforced in production.
---

# Verify Pharmax Production (AWS)

Operational, **read-only-first** workflow for inspecting the Pharmax prod
stack. Confirm facts before changing anything; production mutations go
through the approval-gated paths, never ad-hoc from a laptop.

## Non-negotiable rules

- **Never print secret values.** Secret URLs, passwords, API keys must
  never reach stdout/logs. To check a secret is populated, print its
  LENGTH only. Reading any secret _value_ (even to parse a non-secret
  field like a connection role) is a sensitive action — expect the
  auto-reviewer to gate it and require explicit user approval.
- **Never log PHI.** These commands query infra/control-plane only.
- **No production `terraform apply` from the shell.** Use the
  approval-gated `terraform-apply.yml` GitHub Environment workflow.
- **No interactive `sudo`** in the agent shell (it hangs). If a step
  needs sudo (e.g. installing `session-manager-plugin`), hand the exact
  command to the user.
- Start every cloud command session with the env below so output isn't
  swallowed by the AWS CLI pager.

## Environment

```bash
export AWS_PROFILE=pharmax-prod AWS_REGION=us-east-1 AWS_PAGER=""
```

- Account: `172800116354` · Region: `us-east-1` · Stack prefix: `pharmax-prod-ue1`
- If `aws sts get-caller-identity` fails with "Token has expired", the
  user must re-auth (interactive): `aws sso login --profile pharmax-prod`.

## Known resource names

| Thing          | Name                                              |
| -------------- | ------------------------------------------------- |
| Aurora cluster | `pharmax-prod-ue1-aurora`                         |
| ECS cluster    | `pharmax-prod-ue1-cluster`                        |
| ECS services   | `pharmax-prod-ue1-web`, `-worker`, `-print-agent` |
| Log groups     | `/ecs/pharmax-prod-ue1/{web,worker,print-agent}`  |
| Secret prefix  | `pharmax-prod-ue1/`                               |

## Workflow

Copy and track:

```
- [ ] 1. Identity (correct account, not expired)
- [ ] 2. Aurora cluster status
- [ ] 3. Secrets present + populated (length only)
- [ ] 4. ECS service health (running vs desired)
- [ ] 5. Diagnose any 0-running service (events → logs)
- [ ] 6. DB connection-role / RLS posture (if asked)
```

### 1. Identity

```bash
aws sts get-caller-identity --output json
```

### 2. Aurora cluster

```bash
aws rds describe-db-clusters --query \
 'DBClusters[].{id:DBClusterIdentifier,status:Status,engine:EngineVersion,multiAZ:MultiAZ,members:length(DBClusterMembers)}' \
 --output table
```

Healthy = `status: available`, Multi-AZ `true`, ≥2 members (writer + reader).

### 3. Secrets — present and populated (LENGTH ONLY)

```bash
aws secretsmanager list-secrets \
  --query "SecretList[?starts_with(Name,'pharmax-prod-ue1/')].Name" --output text | tr '\t' '\n' | sort

for s in database-url direct-url reporting-database-url; do
  len=$(aws secretsmanager get-secret-value --secret-id "pharmax-prod-ue1/$s" \
        --query 'length(SecretString)' --output text 2>&1)
  printf '  %-26s -> %s\n' "$s" "$len"   # a number = populated; error = absent/empty
done
```

`length(SecretString)` returns only the integer length — never the value.

### 4. ECS service health

```bash
aws ecs describe-services --cluster pharmax-prod-ue1-cluster \
  --services pharmax-prod-ue1-web pharmax-prod-ue1-worker pharmax-prod-ue1-print-agent \
  --query 'services[].{name:serviceName,desired:desiredCount,running:runningCount,status:status}' \
  --output table
```

`running < desired` (especially `running: 0`) = a crash loop or stalled
deployment → go to step 5.

### 5. Diagnose a 0-running service

```bash
SVC=pharmax-prod-ue1-worker   # or -web / -print-agent
# Recent deployment events (look for "tasks failed to start"):
aws ecs describe-services --cluster pharmax-prod-ue1-cluster --services "$SVC" \
  --query 'services[0].events[:6].[createdAt,message]' --output text

# Stopped task reasons — NOTE: ECS only retains stopped tasks ~1h, so if
# the last failure was days ago this returns None; use logs instead.
TASK=$(aws ecs list-tasks --cluster pharmax-prod-ue1-cluster --service-name "$SVC" \
       --desired-status STOPPED --query 'taskArns[0]' --output text)
[ "$TASK" != "None" ] && aws ecs describe-tasks --cluster pharmax-prod-ue1-cluster \
  --tasks "$TASK" --query 'tasks[0].{stoppedReason:stoppedReason,containers:containers[].{reason:reason,exitCode:exitCode}}'

# Authoritative cause = the boot log. (Do NOT use --max-items; it appends
# a "None" pagination token to the stream name and breaks get-log-events.)
LG="/ecs/pharmax-prod-ue1/${SVC#pharmax-prod-ue1-}"
STREAM=$(aws logs describe-log-streams --log-group-name "$LG" \
         --order-by LastEventTime --descending --query 'logStreams[0].logStreamName' --output text)
aws logs get-log-events --log-group-name "$LG" --log-stream-name "$STREAM" \
  --limit 40 --no-start-from-head --query 'events[].message' --output text | tail -45
```

### 6. DB connection-role / RLS posture (only if asked)

Two layers — distinguish them explicitly:

**(a) What role the connection string SELECTS** — requires reading the
secret value (gated; get user approval). Parse out only non-secret fields:

```bash
aws secretsmanager get-secret-value --secret-id pharmax-prod-ue1/database-url \
  --query SecretString --output text | python3 -c "
import sys,urllib.parse as u
p=u.urlparse(sys.stdin.read().strip()); q=u.parse_qs(p.query)
print('user',p.username,'| pw',('<redacted, present>' if p.password else None),
      '| host',p.hostname,'| db',p.path.lstrip('/'),'| query',dict(q))"
```

Look for `options=-c role=pharmax_app` (web, RLS-subject) /
`pharmax_system` (worker, BYPASSRLS). If there's no `options`, every
service connects as the master user `pharmax_admin` and the role split
is not deployed.

**(b) Whether the runtime role actually enforces RLS** — needs a query
INSIDE the VPC (the cluster is in isolated subnets, unreachable from a
laptop). Run:

```sql
SELECT rolname, rolsuper, rolbypassrls, rolcanlogin
FROM pg_roles WHERE rolname LIKE 'pharmax%' ORDER BY rolname;
```

Pass = `pharmax_admin` shows `rolsuper=f` AND `rolbypassrls=f` (with
tables `FORCE`-RLS, RLS is enforced). Either being `t` means web is
silently bypassing RLS — escalate.

Two ways to run an in-VPC query — see [in-vpc-queries.md](in-vpc-queries.md).

## Common failure modes seen in this stack

- **ECS task-def env names drift from `apps/*/src/env.ts`.** The worker
  hard-fails to boot if `MERKLE_SIGNER_KMS_KEY_ID`, `AUDIT_ARCHIVE_S3_BUCKET`,
  `AUDIT_ARCHIVE_S3_KMS_KEY_ID` are absent — previously injected under
  wrong names. Always diff the task-def `environment`/`secrets` block in
  `infra/terraform/modules/ecs/main.tf` against the app's `env.ts`.
- **`print-agent` refuses prod** if its bootstrap only wires
  `LocalKmsAdapter` (no `AwsKmsAdapter` path) — a code gap, not config.
- **Applying Terraform does not redeploy a service.** The ECS services
  set `lifecycle { ignore_changes = [task_definition] }`. After an apply
  that registers a new task def, force the rollout:
  `aws ecs update-service --cluster pharmax-prod-ue1-cluster --service <svc> --task-definition <family> --force-new-deployment`.

## Deeper references

- `infra/terraform/README.md` § "Assembling DATABASE_URL" (secret layout, role split)
- `docs/RUNBOOK.md` (incident procedures, Merkle key rotation)
- `docs/operations/production-deployment.md` (OIDC roles, deploy/drift)
