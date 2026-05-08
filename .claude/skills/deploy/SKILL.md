---
name: deploy
description: Deploy Quantara backend and ingestion to AWS dev environment
disable-model-invocation: true
argument-hint: [target]
arguments: [target]
allowed-tools: Bash(terraform *) Bash(aws *) Bash(npm *) Bash(docker *)
---

# Deploy to dev

Target: $target (default: all)

## Steps

1. **SSO check** — verify AWS credentials are valid

   ```bash
   aws sts get-caller-identity --profile quantara-dev --region us-west-2
   ```

   If this fails, ask the user to run `aws sso login`.

2. **Typecheck**

   ```bash
   cd /Users/nate/aldero.io/quantara && npm run typecheck --workspaces
   ```

3. **Deploy via Terraform**

   ```bash
   cd /Users/nate/aldero.io/quantara/backend/infra/dev && terraform apply -auto-approve
   ```

4. **Verify**
   ```bash
   curl -s https://d3tavvh2o76dc5.cloudfront.net/health
   ```

If $target is "docker" or "fargate", also rebuild and push the Docker image:

```bash
cd /Users/nate/aldero.io/quantara
aws ecr get-login-password --region us-west-2 --profile quantara-dev | docker login --username AWS --password-stdin 442725244722.dkr.ecr.us-west-2.amazonaws.com
docker build --platform linux/arm64 --provenance=false -f ingestion/Dockerfile -t 442725244722.dkr.ecr.us-west-2.amazonaws.com/quantara-dev-ingestion:latest .
docker push 442725244722.dkr.ecr.us-west-2.amazonaws.com/quantara-dev-ingestion:latest
aws ecs update-service --cluster quantara-dev-ingestion --service quantara-dev-ingestion --force-new-deployment --region us-west-2 --profile quantara-dev
```

Do not proceed if typecheck fails.
