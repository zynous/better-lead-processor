#!/usr/bin/env bash
# Get count of leads that used the LLM for a given month (billing).
# One count = one successful LLM mapping (regardless of CRM accept/reject).
# Usage: ./scripts/get-llm-lead-count.sh [YYYY-MM]
# If YYYY-MM is omitted, uses current month (UTC).

set -e
MONTH="${1:-$(date -u +%Y-%m)}"

if [[ ! "$MONTH" =~ ^[0-9]{4}-[0-9]{2}$ ]]; then
  echo "Usage: $0 [YYYY-MM]" >&2
  echo "Example: $0 2026-02" >&2
  exit 1
fi

START="${MONTH}-01T00:00:00Z"
# Last day of month (next month minus one day)
# 10# forces decimal so months like 08/09 are not treated as octal
MONTH_NUM=$((10#${MONTH:5:2}))
if [[ "$MONTH_NUM" -eq 12 ]]; then
  END="$((${MONTH:0:4}+1))-01-01T00:00:00Z"
else
  END="${MONTH:0:4}-$(printf '%02d' $((MONTH_NUM + 1)))-01T00:00:00Z"
fi

TOTAL=$(aws cloudwatch get-metric-statistics \
  --namespace BetterLeadProcessor \
  --metric-name LLMLeadProcessed \
  --start-time "$START" \
  --end-time "$END" \
  --period 86400 \
  --statistics Sum \
  --query 'sum(Datapoints[*].Sum)' \
  --output text 2>/dev/null || echo "")

if [[ -z "$TOTAL" || "$TOTAL" == "None" || "$TOTAL" == "null" ]]; then
  echo "Month: $MONTH  LLMLeadProcessed: 0"
  exit 0
fi

# Sum may be float; show as integer
echo "Month: $MONTH  LLMLeadProcessed: ${TOTAL%.*}"
exit 0
