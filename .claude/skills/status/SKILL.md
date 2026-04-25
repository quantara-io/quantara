---
name: status
description: Check Quantara system status — ECS, Lambda, DynamoDB counts, SQS depths
disable-model-invocation: true
allowed-tools: Bash(aws *) Bash(curl *)
---

# Quantara System Status

Check all services in the dev environment.

## 1. API Health
```bash
curl -s https://d3tavvh2o76dc5.cloudfront.net/health
```

## 2. ECS Fargate Ingestion
```bash
aws ecs describe-services --cluster quantara-dev-ingestion --services quantara-dev-ingestion --region us-west-2 --profile quantara-dev --query 'services[0].{status:status,running:runningCount,desired:desiredCount}'
```

## 3. DynamoDB Record Counts
```bash
for table in prices candles news-events ingestion-metadata signals users; do
  COUNT=$(aws dynamodb scan --table-name quantara-dev-$table --select COUNT --profile quantara-dev --region us-west-2 --query 'Count' --output text 2>/dev/null)
  echo "$table: $COUNT"
done
```

## 4. SQS Queue Depths
```bash
for queue in enrichment market-events enriched-news enrichment-dlq market-events-dlq enriched-news-dlq; do
  MSGS=$(aws sqs get-queue-attributes --queue-url https://sqs.us-west-2.amazonaws.com/442725244722/quantara-dev-$queue --attribute-names ApproximateNumberOfMessages --profile quantara-dev --region us-west-2 --query 'Attributes.ApproximateNumberOfMessages' --output text 2>/dev/null)
  echo "$queue: $MSGS messages"
done
```

## 5. Recent Fargate Logs
```bash
aws logs tail /ecs/quantara-dev-ingestion --since 5m --region us-west-2 --profile quantara-dev 2>&1 | tail -10
```

Summarize as a table with green/red status indicators.
