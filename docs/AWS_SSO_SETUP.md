# AWS SSO Setup — Quantara

## Prerequisites

- AWS CLI v2 installed (`brew install awscli`)
- Access to Quantara AWS Organization (Identity Center)

## 1. Configure SSO Profiles

Run this to create all three profiles:

```bash
cat >> ~/.aws/config << 'EOF'

[profile quantara-management]
sso_session = quantara
sso_account_id = 489922707011
sso_role_name = AdministratorAccess
region = us-west-2
output = json

[profile quantara-dev]
sso_session = quantara
sso_account_id = 442725244722
sso_role_name = AdministratorAccess
region = us-west-2
output = json

[profile quantara-prod]
sso_session = quantara
sso_account_id = 351666231984
sso_role_name = AdministratorAccess
region = us-west-2
output = json

[sso-session quantara]
sso_start_url = https://d-9067da5ecc.awsapps.com/start
sso_region = us-west-2
sso_registration_scopes = sso:account:access
EOF
```

## 2. Login

```bash
aws sso login --profile quantara-management
```

This opens a browser window. Sign in with your Identity Center credentials. Once authenticated, all three profiles (management, dev, prod) share the same SSO session.

## 3. Verify

```bash
# Management account
aws sts get-caller-identity --profile quantara-management

# Dev account
aws sts get-caller-identity --profile quantara-dev

# Prod account
aws sts get-caller-identity --profile quantara-prod
```

Each should return the correct account ID.

## 4. Switch Between Accounts

No need to login again — just use the `--profile` flag:

```bash
aws dynamodb list-tables --profile quantara-dev --region us-west-2
aws s3 ls --profile quantara-prod --region us-west-2
aws organizations list-accounts --profile quantara-management
```

## 5. Re-login When Token Expires

SSO tokens expire after ~8 hours. When you see "Token has expired":

```bash
aws sso login --profile quantara-management
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
https://d-9067da5ecc.awsapps.com/start
```

You can also open this in a browser to access the AWS Console for any account.
