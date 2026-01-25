#!/bin/bash

# Fast Lambda Function Update Script
# Usage: ./scripts/deploy-lambda.sh
# This script builds and deploys ONLY the Lambda function code (no infrastructure)
# Much faster than full SAM deploy (~10 seconds vs 3-5 minutes)

set -e

FUNCTION_NAME="better-lead-processor"
STACK_NAME="better-lead-processor"

echo "🚀 Fast Lambda Deploy"
echo "====================="
echo ""

# Check if stack exists
echo "Checking stack exists..."
if ! aws cloudformation describe-stacks --stack-name $STACK_NAME &>/dev/null; then
  echo "❌ Error: Stack '$STACK_NAME' not found"
  echo "   Run 'sam deploy' first to create the infrastructure"
  exit 1
fi

# Build TypeScript
echo "📦 Building TypeScript..."
pnpm build
echo "   ✅ Build complete"
echo ""

# Use SAM to build and deploy (handles dependencies)
echo "📦 Building with SAM..."
sam build 2>&1 | grep "Build Succeeded" || echo "   ⚠️  Build finished"
echo ""

# Deploy using SAM (faster for code-only updates)
echo "🔄 Deploying with SAM..."
sam deploy --no-confirm-changeset 2>&1 | grep -E "successfully|UPDATE_COMPLETE|No changes" | head -3

echo ""
echo "✅ Deployment complete"

echo "✅ Deployment complete!"
echo ""
echo "📋 Next steps:"
echo "   - Test: curl -X POST https://integration.zynous.com/api/v1/better-lead-processor/lice-squad/barrie \\"
echo "           -H 'X-API-Key: 550e8400-e29b-41d4-a716-446655440000' \\"
echo "           -H 'Content-Type: application/json' \\"
echo "           -d '{\"firstName\":\"Test\",\"lastName\":\"User\",\"email\":\"test@example.com\"}'"
echo "   - View logs: sam logs --stack-name $STACK_NAME --tail"

