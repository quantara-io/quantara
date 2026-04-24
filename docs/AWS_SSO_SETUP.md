# AWS SSO Setup — Quantara

## Prerequisites

- AWS CLI v2 installed (`brew install awscli`)
- Access to Quantara AWS Organization (Identity Center)

## 1. Configure SSO Profiles

Run this to create all profiles (uses inline SSO fields for max compatibility):

```bash
cat >> ~/.aws/config << 'EOF'

[default]
sso_start_url = https://d-9267dc8051.awsapps.com/start
sso_region = us-west-2
sso_account_id = 442725244722
sso_role_name = AdministratorAccess
region = us-west-2
output = json

[profile quantara-management]
sso_start_url = https://d-9267dc8051.awsapps.com/start
sso_region = us-west-2
sso_account_id = 489922707011
sso_role_name = AdministratorAccess
region = us-west-2
output = json

[profile quantara-dev]
sso_start_url = https://d-9267dc8051.awsapps.com/start
sso_region = us-west-2
sso_account_id = 442725244722
sso_role_name = AdministratorAccess
region = us-west-2
output = json

[profile quantara-prod]
sso_start_url = https://d-9267dc8051.awsapps.com/start
sso_region = us-west-2
sso_account_id = 351666231984
sso_role_name = AdministratorAccess
region = us-west-2
output = json
EOF
```

## 2. Login

```bash
aws sso login
```

This opens a browser window. Sign in with your Identity Center credentials. The default profile is **dev**.

To login with a specific profile:
```bash
aws sso login --profile quantara-management
```

## 3. Verify

```bash
# Default (dev)
aws sts get-caller-identity

# Management account
aws sts get-caller-identity --profile quantara-management

# Prod account
aws sts get-caller-identity --profile quantara-prod
```

Each should return the correct account ID.

## 4. Switch Between Accounts

No need to login again — just use the `--profile` flag:

```bash
aws dynamodb list-tables --profile quantara-dev
aws s3 ls --profile quantara-prod
aws organizations list-accounts --profile quantara-management
```

Without `--profile`, commands use the **dev** account (default).

## 5. Re-login When Token Expires

SSO tokens expire after ~8 hours. When you see "Token has expired":

```bash
aws sso login
```

## 6. Terraform

Terraform uses the `quantara-management` profile to assume roles into dev/prod:

```bash
cd backend/infra/dev
terraform init
terraform plan -var-file=secrets.tfvars
terraform apply -var-file=secrets.tfvars -auto-approve
```

The `secrets.tfvars` file contains Alpaca API keys (gitignored). Get it from the existing machine or recreate:

```hcl
alpaca_key_id     = "<get from SSM or existing machine>"
alpaca_secret_key = "<get from SSM or existing machine>"
```

## Account IDs

| Account | ID | Purpose |
|---------|-----|---------|
| Management | 489922707011 | Org management, Terraform state, IAM Identity Center |
| Dev | 442725244722 | Development environment |
| Prod | 351666231984 | Production environment |

## SSO Start URL

```
https://d-9267dc8051.awsapps.com/start
```

You can also open this in a browser to access the AWS Console for any account.
