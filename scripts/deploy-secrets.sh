#!/bin/bash

# Deploy Production Configs to AWS Secrets Manager
# Usage: ./deploy-secrets.sh [SECRET_NAME] [--dry-run]
#   SECRET_NAME  Optional. Deploy only this secret (e.g. app-config, lice-squad, ygm).
#                Without it, deploys app-config and all franchisor configs.
#   --dry-run    Show what would be deployed without making changes.

set -e

DRY_RUN=false
SECRET_NAME=""
SECRET_PREFIX="better-lead-processor"
PROD_CONFIGS_DIR="prod-configs"

# Parse arguments
for arg in "$@"; do
  if [[ "$arg" == "--dry-run" ]]; then
    DRY_RUN=true
  elif [[ -n "$arg" && -z "$SECRET_NAME" ]]; then
    SECRET_NAME="$arg"
  fi
done

if [[ "$DRY_RUN" == true ]]; then
  echo "🔍 DRY RUN MODE - No changes will be made"
fi

# If user passed full secret name (e.g. better-lead-processor/lice-squad), use the suffix
if [[ "$SECRET_NAME" == "$SECRET_PREFIX"/* ]]; then
  SECRET_NAME="${SECRET_NAME#$SECRET_PREFIX/}"
fi

# Check AWS credentials
if ! aws sts get-caller-identity &>/dev/null; then
  echo "❌ Error: AWS credentials not configured"
  exit 1
fi

# Get AWS region and account
AWS_REGION=$(aws configure get region || echo "us-east-1")
AWS_ACCOUNT=$(aws sts get-caller-identity --query Account --output text)

echo "📦 Deploying secrets to AWS Secrets Manager"
echo "   Region: $AWS_REGION"
echo "   Account: $AWS_ACCOUNT"
echo "   Prefix: $SECRET_PREFIX"
echo ""

# Check if prod-configs directory exists
if [[ ! -d "$PROD_CONFIGS_DIR" ]]; then
  echo "❌ Error: $PROD_CONFIGS_DIR directory not found"
  exit 1
fi

# Confirm before making changes (skip in dry-run)
if [[ "$DRY_RUN" != true ]]; then
  if [[ -n "$SECRET_NAME" ]]; then
    echo "Will deploy secret: $SECRET_PREFIX/$SECRET_NAME"
  else
    echo "Will deploy all secrets (app-config + all franchisor configs)"
  fi
  echo ""
  read -r -p "Continue? [y/N] " reply
  if [[ ! "$reply" =~ ^[yY]$ ]]; then
    echo "Aborted."
    exit 0
  fi
  echo ""
fi

# Deploy app-config
deploy_config() {
  local config_file=$1
  local secret_name=$2
  
  if [[ ! -f "$config_file" ]]; then
    echo "⚠️  Skipping $config_file (not found)"
    return
  fi

  # Validate JSON
  if ! jq empty "$config_file" 2>/dev/null; then
    echo "❌ Error: Invalid JSON in $config_file"
    exit 1
  fi

  local secret_value=$(cat "$config_file")
  
  if [[ "$DRY_RUN" == true ]]; then
    echo "📋 [DRY RUN] Would create/update: $secret_name"
    echo "   File: $config_file"
    echo "   Content preview:"
    echo "$secret_value" | jq '.' | sed 's/^/     /'
    echo ""
    return
  fi

  # Check if secret exists
  if aws secretsmanager describe-secret --secret-id "$secret_name" --region "$AWS_REGION" &>/dev/null; then
    echo "🔄 Updating: $secret_name"
    aws secretsmanager put-secret-value \
      --secret-id "$secret_name" \
      --secret-string "$secret_value" \
      --region "$AWS_REGION" \
      --query 'ARN' \
      --output text
  else
    echo "✨ Creating: $secret_name"
    aws secretsmanager create-secret \
      --name "$secret_name" \
      --secret-string "$secret_value" \
      --region "$AWS_REGION" \
      --tags Key=Environment,Value=production Key=Application,Value=better-lead-processor \
      --query 'ARN' \
      --output text
  fi

  echo "   ✅ Success"
  echo ""
}

if [[ -n "$SECRET_NAME" ]]; then
  # Deploy only the requested secret
  if [[ "$SECRET_NAME" == "app-config" ]]; then
    echo "📄 Deploying app-config..."
    deploy_config "$PROD_CONFIGS_DIR/app-config.json" "$SECRET_PREFIX/app-config"
  else
    config_file="$PROD_CONFIGS_DIR/${SECRET_NAME}.json"
    if [[ ! -f "$config_file" ]]; then
      echo "❌ Error: Config file not found: $config_file"
      exit 1
    fi
    echo "🏢 Deploying franchisor config: $SECRET_NAME..."
    deploy_config "$config_file" "$SECRET_PREFIX/$SECRET_NAME"
  fi
else
  # Deploy app-config
  echo "📄 Processing app-config..."
  deploy_config "$PROD_CONFIGS_DIR/app-config.json" "$SECRET_PREFIX/app-config"

  # Deploy franchisor configs
  echo "🏢 Processing franchisor configs..."
  for franchisor_file in "$PROD_CONFIGS_DIR"/*.json; do
    # Skip app-config (already processed)
    if [[ "$(basename "$franchisor_file")" == "app-config.json" ]]; then
      continue
    fi

    # Skip example files
    if [[ "$(basename "$franchisor_file")" == *.example.json ]]; then
      continue
    fi

    franchisor_name=$(basename "$franchisor_file" .json)
    secret_name="$SECRET_PREFIX/$franchisor_name"

    deploy_config "$franchisor_file" "$secret_name"
  done
fi

if [[ "$DRY_RUN" == true ]]; then
  echo "✅ Dry run complete. No changes were made."
else
  echo "✅ Secret(s) deployed successfully!"
  if [[ -z "$SECRET_NAME" ]]; then
    echo ""
    echo "📋 Deployed secrets:"
    aws secretsmanager list-secrets \
      --filters Key=name,Values="$SECRET_PREFIX" \
      --region "$AWS_REGION" \
      --query 'SecretList[].Name' \
      --output text | tr '\t' '\n' | sed 's/^/   - /'
  fi
fi

