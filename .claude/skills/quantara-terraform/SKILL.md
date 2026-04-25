---
name: quantara-terraform
description: Make infrastructure changes in backend/infra (DynamoDB tables, SQS queues, Lambda functions, Fargate ingestion, S3, API Gateway, CloudFront). Use when adding/modifying any AWS resource managed by Terraform, updating IAM, changing env vars on the Lambda or ECS task, or rotating SSM-stored secrets. Pairs with the global terraform-skill — this one encodes Quantara's specific layout, naming, and gotchas.
---

# quantara-terraform

Quantara infrastructure is one Terraform module (`backend/infra/modules/quantara-backend/`) consumed twice — once from `backend/infra/dev/main.tf` and once from `backend/infra/prod/main.tf`. State lives in S3 (`quantara-tf-state`) with locks in DynamoDB (`quantara-tf-locks`), both in the management account.

## Layout

```
backend/infra/
├── dev/main.tf         # consumes module, sets dev vars
├── prod/main.tf        # consumes module, sets prod vars
└── modules/quantara-backend/
    ├── main.tf                # locals (prefix), data sources
    ├── variables.tf           # module inputs
    ├── outputs.tf             # api_url, table_names, ecr_repository_url, ...
    ├── dynamodb.tf            # all DynamoDB tables
    ├── lambda.tf              # API Lambda + IAM (build hook included)
    ├── ingestion.tf           # Lambdas for backfill / news-backfill / enrichment
    ├── ingestion-fargate.tf   # VPC + ECS cluster + Fargate streaming service
    ├── api_gateway.tf         # HTTP API in front of the Lambda
    ├── cloudfront.tf          # CDN in front of API Gateway
    ├── sqs.tf                 # enrichment / market_events / enriched_news + DLQs
    └── s3-data.tf             # data archive bucket
```

`local.prefix = "quantara-${var.environment}"` — every resource name is prefixed with this. Every table, queue, bucket, function, role follows `${local.prefix}-<thing>`.

## Conventions

- **Region:** `us-west-2` (only).
- **Provider auth:** management profile assumes `OrganizationAccountAccessRole` into the dev or prod account. Never run terraform with the dev/prod profile directly.
- **Default tags:** `Project=quantara`, `Environment=<env>`, `ManagedBy=terraform` — don't re-tag at the resource level.
- **All DynamoDB tables:** `billing_mode = "PAY_PER_REQUEST"`, `server_side_encryption.enabled = true`, `point_in_time_recovery.enabled = true`. Add `ttl` if items expire.
- **All SQS queues:** paired with a `*_dlq`, retention 4 days on the live queue / 14 days on DLQ, `maxReceiveCount = 3`.
- **Architecture:** ARM64 for Lambdas (`architectures = ["arm64"]`) and ECS tasks (`runtime_platform.cpu_architecture = "ARM64"`).
- **Runtime:** `nodejs24.x`.
- **No resource-level `force_destroy = true`** except on ECR (where it's intentional).

## Adding a new DynamoDB table

1. Append a `resource "aws_dynamodb_table" "..."` block in `dynamodb.tf`. Match the existing pattern (PAY_PER_REQUEST, encryption, PITR).
2. If the table is read/written by the API Lambda, add its ARN (and `/index/*` if it has GSIs) to `aws_iam_role_policy.lambda_dynamodb` in `lambda.tf`. **Forgetting this is the most common bug.**
3. If it's used by the Fargate ingestion service, add it to `aws_iam_role_policy.ingestion_ecs_dynamodb` in `ingestion-fargate.tf`.
4. Add a `TABLE_<NAME>` env var to the consumer's environment block (Lambda's `environment.variables` or the ECS task definition's `environment` array). The application code reads `process.env.TABLE_<NAME>` with a fallback to `${TABLE_PREFIX}<name>` — the env var is what production uses.
5. Add the table name to the `table_names` output in `outputs.tf`.

## Adding a new SQS queue

In `sqs.tf`, create both `${prefix}-<name>` and `${prefix}-<name>-dlq`. Then:

- Producer permission: extend `aws_iam_role_policy.ingestion_ecs_sqs` (Fargate) or add a Lambda IAM block.
- Consumer permission + event source mapping: in `ingestion.tf` if it triggers a Lambda.
- Inject the queue URL via env var: `<NAME>_QUEUE_URL = aws_sqs_queue.<name>.url` on the producer.
- Add to the `sqs_queue_urls` output.

## Adding a new Lambda

`lambda.tf` is the API Lambda; ingestion-side handlers live in `ingestion.tf`. The build hook (`terraform_data.build` + `archive_file`) re-builds when any `src/**/*.ts` changes — don't duplicate it, it covers the whole `app_source_dir`.

For a new ingestion Lambda: copy an existing block from `ingestion.tf`, point it at the right `dist/<name>.js`, attach role policies for the resources it touches, add an event source (SQS, schedule, etc.).

## Fargate ingestion service

`ingestion-fargate.tf` is the long-running streaming service. Two important details:

- The image is `${ecr}.repository_url}:latest` and **deploys via CI** (`docker build → docker push → aws ecs update-service --force-new-deployment`). Terraform creates the cluster/service/task definition; CI rolls the image. If you change the task definition, the next deploy picks up the new revision.
- `desired_count = 1` is **not** in the lifecycle ignore list anymore (this was a recent fix — see commit `9b688af`). Don't add `ignore_changes = [desired_count]` — it masks drift.

To change CPU/memory: `var.fargate_cpu` / `var.fargate_memory` (defaults 256 / 512). Bump in the module's `variables.tf` defaults or override in `dev/main.tf` / `prod/main.tf`.

## SSM secrets

Secrets live in SSM Parameter Store under `/quantara/<env>/...`:

| Param | Reader |
|---|---|
| `/quantara/<env>/aldero-m2m-client-id` | API Lambda |
| `/quantara/<env>/aldero-client-secret` | API Lambda (SecureString) |
| `/quantara/<env>/oauth-state-secret` | API Lambda (SecureString) |
| `/quantara/<env>/api-keys/<client>` | API Lambda (SecureString) |
| `/quantara/<env>/docs-allowed-ips` | API Lambda |
| `/quantara/<env>/cryptopanic-api-key` | Ingestion (SecureString) |
| `/quantara/<env>/alpaca/key-id`, `/quantara/<env>/alpaca/secret-key` | Fargate (via ECS `secrets`, SecureString) |

The API Lambda IAM grants `ssm:GetParameter*` on `/quantara/<env>/*` (lambda.tf, `lambda_ssm` policy). The Fargate execution role has narrower grants (only the Alpaca params) — extend `local.alpaca_ssm_param_arns` and the `ingestion_ecs_execution_alpaca_ssm` policy if you add new ECS-exposed secrets.

Rotate a secret without redeploying:
```bash
aws ssm put-parameter --profile quantara-dev --region us-west-2 \
  --name '/quantara/dev/<param>' --type SecureString --value '<new>' --overwrite
```
The Lambda re-reads after its 5-minute cache TTL. The Fargate `secrets` block resolves on container start, so rotate + `aws ecs update-service --force-new-deployment` for that.

## Plan / apply

```bash
cd backend/infra/dev   # or prod
terraform init
terraform plan         # always read this carefully
terraform apply -auto-approve
```

The dev account ID is `442725244722`. Prod is `351666231984`. Management is `489922707011`. `aws sso login` first if your token expired.

## Don'ts

- Don't run `terraform apply` against prod without explicit user confirmation. Even in dev, surface the plan first.
- Don't add `lifecycle { ignore_changes = [desired_count] }` on the Fargate service. Drift is a signal, not noise (see `9b688af`).
- Don't create resources outside the module — both environments must stay symmetric.
- Don't hardcode account IDs or region in resource bodies — use `data.aws_caller_identity.current.account_id` and `var.aws_region`.
- Don't rename a resource without `terraform state mv` — Terraform will recreate, and DynamoDB tables don't recover from that.
- Don't switch a table off `PAY_PER_REQUEST` without a clear reason — provisioned throughput needs autoscaling config and surveillance.
