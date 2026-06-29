# Running a SQL probe inside the prod VPC

The Aurora cluster is in isolated subnets reachable only from the ECS
task security group, so a laptop can't connect directly. The web/worker
containers are Node images (no `psql`) — query through the app's bundled
Prisma client (`systemPrisma`, the raw/unscoped client). Keep probes
**read-only** (e.g. `pg_roles`, `pg_class`). `$queryRawUnsafe` is fine
for a hard-coded `SELECT` with no interpolation.

## Method A — ECS Exec (needs session-manager-plugin)

Prereq (install is interactive `sudo` — hand to the user, don't run it
in the agent shell):

```bash
brew install --cask session-manager-plugin
# if the cask download succeeded but the install needs a password:
sudo installer -pkg /opt/homebrew/Caskroom/session-manager-plugin/*/session-manager-plugin.pkg -target /
```

Then exec a single non-interactive command on a running web task:

```bash
TASK=$(aws ecs list-tasks --cluster pharmax-prod-ue1-cluster \
  --service-name pharmax-prod-ue1-web --desired-status RUNNING \
  --query 'taskArns[0]' --output text)

aws ecs execute-command --cluster pharmax-prod-ue1-cluster --task "$TASK" \
  --container web --interactive \
  --command "node --input-type=module -e \"import('@pharmax/database').then(async ({systemPrisma})=>{const r=await systemPrisma.\$queryRawUnsafe(\\\"SELECT rolname,rolsuper,rolbypassrls,rolcanlogin FROM pg_roles WHERE rolname LIKE 'pharmax%' ORDER BY rolname\\\");console.log(JSON.stringify(r,null,2));}).then(()=>process.exit(0)).catch(e=>{console.error(String(e));process.exit(1)})\""
```

`enable_execute_command` is already `true` on the services. If exec
fails with an SSM error, the task may predate the flag — force a new
deployment so new tasks launch with the exec agent.

## Method B — one-off Fargate task (no plugin, no sudo)

Reuse the web task definition with a command override; read the result
from CloudWatch. Pull the network config from the running service so the
task lands in the same subnets/SG:

```bash
NET=$(aws ecs describe-services --cluster pharmax-prod-ue1-cluster \
  --services pharmax-prod-ue1-web \
  --query 'services[0].networkConfiguration.awsvpcConfiguration' --output json)
SUBNETS=$(echo "$NET" | python3 -c "import sys,json;print(','.join(json.load(sys.stdin)['subnets']))")
SG=$(echo "$NET" | python3 -c "import sys,json;print(','.join(json.load(sys.stdin)['securityGroups']))")

aws ecs run-task --cluster pharmax-prod-ue1-cluster --launch-type FARGATE \
  --task-definition pharmax-prod-ue1-web \
  --started-by rls-posture-check \
  --network-configuration "awsvpcConfiguration={subnets=[$SUBNETS],securityGroups=[$SG],assignPublicIp=DISABLED}" \
  --overrides '{"containerOverrides":[{"name":"web","command":["node","--input-type=module","-e","import(\"@pharmax/database\").then(async ({systemPrisma})=>{const r=await systemPrisma.$queryRawUnsafe(\"SELECT rolname,rolsuper,rolbypassrls FROM pg_roles WHERE rolname LIKE '\''pharmax%'\'' ORDER BY rolname\");console.log(\"RLS_PROBE\",JSON.stringify(r));}).then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1)})"]}]}' \
  --query 'tasks[0].taskArn' --output text
```

Then find the new task's log stream in `/ecs/pharmax-prod-ue1/web` and
read the line tagged `RLS_PROBE` (see step 5 in SKILL.md for the
log-reading pattern). The task injects `DATABASE_URL` from the same
secret the web service uses, so the probe reflects the real connection
role. The transient task exits on its own.

## Interpreting the result

```
pharmax_admin   rolsuper=f  rolbypassrls=f   -> RLS enforced (good, with FORCE RLS)
pharmax_app     rolsuper=f  rolbypassrls=f   -> RLS-subject role exists (web target)
pharmax_system  rolsuper=f  rolbypassrls=t   -> BYPASSRLS role exists (worker target)
```

If `pharmax_admin` shows `rolsuper=t` or `rolbypassrls=t`, the web tier
is bypassing RLS today — deploy the connection-role split urgently so
web connects as `pharmax_app`.
