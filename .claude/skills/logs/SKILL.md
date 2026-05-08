---
name: logs
description: View recent logs from Quantara Lambda or Fargate services
disable-model-invocation: true
argument-hint: [service]
arguments: [service]
allowed-tools: Bash(aws *)
---

# Quantara Logs

View logs for: $service (default: api)

## Services:

- **api** → `/aws/lambda/quantara-dev-api`
- **ingestion** → `/ecs/quantara-dev-ingestion`
- **backfill** → `/aws/lambda/quantara-dev-backfill`
- **enrichment** → `/aws/lambda/quantara-dev-enrichment`
- **news** → `/aws/lambda/quantara-dev-news-backfill`

```bash
aws logs tail /aws/lambda/quantara-dev-api --since 10m --region us-west-2 --profile quantara-dev
```

If $service is "ingestion":

```bash
aws logs tail /ecs/quantara-dev-ingestion --since 10m --region us-west-2 --profile quantara-dev
```

Filter for errors if the user asks for them:

```bash
aws logs tail <log-group> --since 30m --filter-pattern "ERROR" --region us-west-2 --profile quantara-dev
```

Summarize any errors or warnings found.
