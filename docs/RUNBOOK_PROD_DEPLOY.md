# Prod Deploy Runbook

**Audience:** on-call operator or release engineer.
**Purpose:** trigger a prod deploy, verify it, and roll back if something breaks.

---

## Prerequisites

Before triggering any prod deploy:

- You have `quantara-prod` AWS SSO access (profile `quantara-prod` locally, or the GitHub Environment `prod` reviewer role in CI).
- You are a configured required reviewer in **Settings → Environments → prod** on GitHub.
- The SHA you intend to deploy has passed all CI checks on `main` (green).
- The `VERSION` file and `CHANGELOG.md` on `main` reflect the current `[Unreleased]` entries you expect to ship.

---

## 1. Triggering a prod deploy

### 1a. From the GitHub Actions UI

1. Open **Actions → Deploy to Prod** in the `quantara-io/quantara` repo.
2. Click **Run workflow** (top-right of the workflow list).
3. In the dialog:
   - **Branch:** `main`
   - **SHA to deploy** (required): paste the full 40-character SHA you want promoted to prod. This must be a commit that already exists on `main` (i.e. was merged, not a branch tip).
4. Click **Run workflow**.
5. The `deploy-prod` job enters **waiting** state — it uses `environment: prod` which requires a human approval.

### 1b. Approving the deployment

1. You (or another configured reviewer) will receive a GitHub notification or email.
2. Open the waiting workflow run and click **Review deployments**.
3. Tick the `prod` environment checkbox and click **Approve and deploy**.
4. The job proceeds.

> If no reviewer approves within 30 days, the run expires and must be re-triggered.

### 1c. What the workflow does (after approval)

In order:

1. Checks out the specified SHA.
2. Builds the backend and ingestion Lambda zips from source.
3. Authenticates to the prod AWS account via OIDC (`GitHubDeployRoleProd`).
4. Updates each Lambda function code. The canonical list is the `function_name` values declared in `backend/infra/modules/quantara-backend/*.tf` (15 Lambdas):

   ```bash
   # Canonical prod Lambda inventory — keep in sync with section 3 rollback loop.
   LAMBDAS=(
     quantara-prod-aggregator
     quantara-prod-api
     quantara-prod-backfill
     quantara-prod-close-quorum-monitor
     quantara-prod-enrichment
     quantara-prod-events-fanout
     quantara-prod-higher-tf-poller
     quantara-prod-indicator-handler
     quantara-prod-indicator-handler-shadow
     quantara-prod-ingestion
     quantara-prod-news-backfill
     quantara-prod-outcome-handler
     quantara-prod-signals-fanout
     quantara-prod-ws-connect
     quantara-prod-ws-disconnect
   )
   ```

   Note: ratification logic runs inside the `quantara-prod-api` Lambda — there is no separate `ratification-handler` function. If the Phase C workflow (`#284`) adds or removes a Lambda, update both this list and the rollback loop in section 3 in the same PR.

5. Builds and pushes the ingestion Docker image to the prod ECR (`quantara-prod-ingestion`), tagged `latest` and `<sha>`.
6. Forces a new ECS deployment on the `quantara-prod-ingestion` cluster/service.
7. On success: bumps the `N` counter in `VERSION`, appends the `[Unreleased]` block to `CHANGELOG.md` under the new version heading, commits both files to `main`, and pushes a tag `v<version>` at the deployed SHA.

---

## 2. Verifying the deploy

After the workflow turns green (all steps pass):

### Lambda verification

```bash
# Check the deployed SHA for each Lambda (replace prod account id if needed)
aws lambda get-function \
  --function-name quantara-prod-api \
  --profile quantara-prod \
  --query 'Configuration.{CodeSha256:CodeSha256,LastModified:LastModified,Version:Version}' \
  --output table
```

Compare `CodeSha256` to the zip's sha256 to confirm the correct bundle is live.

### API smoke test

```bash
# Replace with the actual prod API Gateway / CloudFront URL
PROD_API_URL="https://api.quantara.io"

curl -s "$PROD_API_URL/health" | jq .
# Expected: {"status":"ok",...}
```

### ECS service check

```bash
aws ecs describe-services \
  --cluster quantara-prod-ingestion \
  --services quantara-prod-ingestion \
  --profile quantara-prod \
  --query 'services[0].{running:runningCount,desired:desiredCount,status:status,deployments:deployments[*].{id:id,status:status,taskDefinition:taskDefinition}}' \
  --output json
```

Wait until `runningCount == desiredCount` and there is only one deployment with status `PRIMARY`.

### CloudWatch — first 30 minutes

- Open **CloudWatch → Log groups → /aws/lambda/quantara-prod-api** and watch for errors.
- Check the SQS queue depths: `quantara-prod-enrichment`, `quantara-prod-enriched-news`. A sudden spike indicates the enrichment Lambda is failing to drain.
- Check the billing alarm (if configured) — it should not fire on a normal deploy cycle.

---

## 3. Rolling back — Lambda

Lambda rollback is a re-deploy of the previous version's zip. Every successful deploy is tagged in git (`v2026.05.0`, etc.). The previous tag's artifacts were uploaded as a CI artifact and can be re-deployed.

### Step-by-step Lambda rollback

1. Find the previous release tag:

   ```bash
   git tag --sort=-creatordate | head -5
   # e.g.: v2026.05.1, v2026.05.0, ...
   ROLLBACK_TAG=v2026.05.0
   ```

2. Find the commit SHA for that tag:

   ```bash
   git rev-list -n 1 "$ROLLBACK_TAG"
   ```

3. Trigger the **Deploy to Prod** workflow again (section 1a above) with that SHA as the input. The workflow builds from the tagged source and redeploys to all Lambdas.

   Alternatively, if the CI artifact is still within its retention window (30 days), download `lambda-zips` from the tagged commit's workflow run and push directly:

   ```bash
   ROLLBACK_SHA=$(git rev-list -n 1 "$ROLLBACK_TAG")

   # Download the artifact from the correct run (requires gh cli)
   RUN_ID=$(gh run list \
     --branch main \
     --workflow ci.yml \
     --json databaseId,headSha \
     --jq ".[] | select(.headSha == \"$ROLLBACK_SHA\") | .databaseId" \
     | head -1)

   gh run download "$RUN_ID" --name lambda-zips --dir /tmp/rollback-zips

   # Canonical prod Lambda inventory — must match the LAMBDAS array in section 1c.
   # The artifact zip for each function is named after the suffix (e.g. quantara-prod-api → api.zip).
   LAMBDAS=(
     quantara-prod-aggregator
     quantara-prod-api
     quantara-prod-backfill
     quantara-prod-close-quorum-monitor
     quantara-prod-enrichment
     quantara-prod-events-fanout
     quantara-prod-higher-tf-poller
     quantara-prod-indicator-handler
     quantara-prod-indicator-handler-shadow
     quantara-prod-ingestion
     quantara-prod-news-backfill
     quantara-prod-outcome-handler
     quantara-prod-signals-fanout
     quantara-prod-ws-connect
     quantara-prod-ws-disconnect
   )

   for FN in "${LAMBDAS[@]}"; do
     SUFFIX="${FN#quantara-prod-}"
     aws lambda update-function-code \
       --function-name "$FN" \
       --zip-file "fileb:///tmp/rollback-zips/${SUFFIX}.zip" \
       --profile quantara-prod
   done
   ```

4. Verify each function is healthy (section 2 above).

---

## 4. Rolling back — Fargate (ECS)

Fargate rollback = force a redeploy using the previous Docker image tag. Every deploy tags the ECR image with the git SHA.

### Step-by-step ECS rollback

1. Find the rollback tag (same as Lambda step above):

   ```bash
   ROLLBACK_TAG=v2026.05.0
   ROLLBACK_SHA=$(git rev-list -n 1 "$ROLLBACK_TAG")
   ```

2. Retrieve the ECR repo URL:

   ```bash
   ECR_URL=$(aws ecr describe-repositories \
     --repository-names quantara-prod-ingestion \
     --profile quantara-prod \
     --query 'repositories[0].repositoryUri' \
     --output text)
   ```

3. Confirm the rollback image exists in ECR:

   ```bash
   aws ecr describe-images \
     --repository-name quantara-prod-ingestion \
     --image-ids imageTag="$ROLLBACK_SHA" \
     --profile quantara-prod \
     --query 'imageDetails[0].{digest:imageDigest,pushedAt:imagePushedAt}'
   ```

4. Re-tag that image as `latest` and push it back (this does not re-build anything — it's just a tag operation):

   ```bash
   # Login
   aws ecr get-login-password --profile quantara-prod --region us-west-2 \
     | docker login --username AWS --password-stdin "$ECR_URL"

   # Pull the rollback image
   docker pull "${ECR_URL}:${ROLLBACK_SHA}"

   # Re-tag as latest
   docker tag "${ECR_URL}:${ROLLBACK_SHA}" "${ECR_URL}:latest"

   # Push
   docker push "${ECR_URL}:latest"
   ```

5. Force a new ECS deployment so running tasks pick up the `latest` image:

   ```bash
   aws ecs update-service \
     --cluster quantara-prod-ingestion \
     --service quantara-prod-ingestion \
     --force-new-deployment \
     --profile quantara-prod \
     --region us-west-2
   ```

6. Monitor the service until old tasks drain and new tasks are running (section 2 ECS check above).

> **Note:** ECS tasks run `desiredCount: 0` in prod initially. If you're rolling back a service that was deliberately scaled to zero, do not accidentally set `desiredCount: 1` during rollback unless prod data quality has been verified (see open question #2 in issue #113).

---

## 5. On-call expectations during deploy

| Time                  | Action                                                                                           |
| --------------------- | ------------------------------------------------------------------------------------------------ |
| T-0 (trigger)         | Notify `#prod-deploys` Slack channel (if configured) with the SHA and release tag being deployed |
| T-0 to T+10           | Watch the workflow run — approve the environment gate promptly                                   |
| T+10 (workflow green) | Run smoke tests (section 2)                                                                      |
| T+10 to T+30          | Watch CloudWatch logs for error spikes, SQS queue depth anomalies, and billing alarm             |
| T+30 (all clear)      | Post confirmation to `#prod-deploys`; deploy is complete                                         |
| T+30+ (incident)      | Follow rollback steps (sections 3 or 4); post incident timeline; file a retro issue              |

### Rollback decision threshold

Roll back immediately if any of the following occur in the 30 minutes post-deploy:

- 5xx error rate on `quantara-prod-api` exceeds 5% over a 5-minute window in CloudWatch.
- Any Lambda function reports an invocation error rate > 1% over a 5-minute window.
- SQS dead-letter queue (`quantara-prod-enrichment-dlq`) receives any messages.
- The billing alarm fires (indicates a runaway LLM loop).

---

## 6. Rollback drill (pre-prod-go-live)

Before the first real prod deploy, run this drill in **dev**:

1. Deploy the current `main` HEAD to dev (`deploy-code-dev` already runs on every merge — confirm it's green).
2. Make a trivial commit to `main` (e.g. bump a comment). Let CI deploy it to dev. Note the new dev Lambda SHA.
3. Use the rollback procedure (section 3) to roll dev back to the previous SHA.
4. Confirm the previous code is running (via `get-function` SHA check and smoke test).
5. Record any friction points. File a follow-up issue if the runbook needed adjustment.

---

## 7. References

- Issue #113 — prod deploy workflow meta-issue (trigger model, versioning decision, open questions)
- `CHANGELOG.md` — version history
- `VERSION` — current prod version
- `.github/workflows/deploy-prod.yml` — the actual workflow (to be created in Phase C)
- `backend/infra/prod/` — prod Terraform stack (to be fully populated in Phase A)
- `docs/AWS_SSO_SETUP.md` — how to configure `quantara-prod` AWS profile locally
