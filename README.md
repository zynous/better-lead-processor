# Better Lead Processor

Serverless Lambda that receives unstructured lead data, maps it to Better CRM format using an LLM (OpenAI + LangChain), and creates leads via the Better CRM API.

---

## 1. Architecture

```
Franchise Client
    ↓
API Gateway (integration.zynous.com)
    ├── Throttling: 50 req/s, burst 100
    └── POST /api/v1/better-lead-processor/{franchisor-name}/{franchise-name}
    └── POST /api/v1/better-lead-processor/{franchisor-name}
    ↓
Lambda: better-lead-processor (reserved concurrency: 20)
    ├── Secrets Manager (config + LLM API key, via Lambda Extension cache)
    ├── LLM (OpenAI + LangChain) — map unstructured → Better CRM schema
    ├── Better CRM API (OAuth2, create lead)
    └── SES (failure notifications only)
```

**Components**

| Component | Role |
|-----------|------|
| **API Gateway** | REST API, custom domain, CORS, stage throttling |
| **Lambda** | Single function: validation, postal-code lookup, LLM mapping, Better CRM, errors |
| **Secrets Manager** | Franchise configs, system/LLM config; read via Parameters & Secrets Lambda Extension |
| **SES** | Email on processing failure (when configured per franchise) |
| **OpenAI + LangChain** | Structured mapping from arbitrary JSON to Better CRM lead shape |

**DoS / rate limiting**

- **API Gateway:** 50 requests/second, burst 100 (stage `MethodSettings`). Excess requests get **429**.
- **Lambda:** `ReservedConcurrentExecutions: 20`. When all 20 are in use, additional requests get **429**.

---

## 2. Tech Stack

| Layer | Technology |
|-------|------------|
| **Runtime** | Node.js 24.x |
| **Language** | TypeScript |
| **LLM** | OpenAI via LangChain (`@langchain/openai`, `@langchain/core`) |
| **Validation** | Zod |
| **Infrastructure** | AWS SAM (Serverless Application Model) |
| **AWS SDK** | `@aws-sdk/client-secrets-manager`, `@aws-sdk/client-ses` |
| **Logging** | Structured JSON (CloudWatch-friendly) |

---

## 3. Project Structure

```
better-lead-processor/
├── src/
│   ├── index.ts                    # Lambda handler: auth, validation, orchestration
│   ├── types.ts                    # Types and Zod schemas (e.g. BetterCRMLeadSchema)
│   ├── validators.ts               # Path/body/lead validation → 400 responses
│   ├── error-messages.ts           # User-facing and email error messages
│   ├── utils.ts                    # Logger, postal-code helpers, retry()
│   ├── handlers/
│   │   ├── index.ts                # Handler exports
│   │   └── lookup-franchise-by-postal-code.ts  # Endpoint-2: postal code → franchise
│   └── services/
│       ├── secrets-manager.ts      # Config/secret load (Extension + fallback, local file for SAM local)
│       ├── better-crm.ts           # OAuth2 + create lead (with retry)
│       ├── llm-mapper.ts           # LLM mapping to Better CRM format
│       └── email.ts                # SES failure notifications
├── events/                         # Test payloads for SAM local
│   ├── common.json
│   └── by_zipcode.json
├── prod-configs/                   # Source for deploy-secrets.sh (gitignored)
│   ├── app-config.json             # System/LLM config
│   └── {franchisor-name}.json      # Per-franchisor config
├── template.yaml                   # SAM: Lambda, API Gateway, domain, throttling, concurrency
├── scripts/
│   ├── deploy-lambda.sh            # Code-only deploy (fast)
│   └── deploy-secrets.sh           # Push prod-configs to Secrets Manager
├── package.json
├── tsconfig.json
└── jest.config.js
```

---

## 4. Build

**Prerequisites:** Node.js 24.x, pnpm 9+, AWS CLI configured, SAM CLI (for local and deploy).

```bash
pnpm install
pnpm build
```

- `pnpm build` compiles TypeScript into `dist/`.
- For deployment: `sam build` (see sections 7 and 8).

---

## 5. Local Development and Lambda Testing

**Config (local only)**  
Create configs that mirror production secrets (do not commit secrets):

- System: e.g. `local-configs/app-config.json` (or equivalent from your `app-config` shape).
- Per franchise: e.g. `local-configs/{franchisor-name}/{franchise-name}.json`.

When `AWS_SAM_LOCAL` is set (or not running in Lambda), the app reads from these local files instead of Secrets Manager.

**Invoke function locally (no API Gateway):**

```bash
pnpm build
sam local invoke LeadProcessorFunction -e events/common.json
# or
sam local invoke LeadProcessorFunction -e events/by_zipcode.json
```

**Local API (simulates API Gateway):**

```bash
sam local start-api
# Default: http://localhost:3000
```

Example request:

```bash
curl -s -w "\n\nHTTP %{http_code}\n" -X POST "https://integration.zynous.com/api/v1/better-lead-processor/lice-squad/barrie" \
  -H "Content-Type: application/json" \
  -H "X-API-Key: 550e8400-e29b-41d4-a716-546655440000" \
  -d '{"firstName":"Test","lastName":"User","email":"test@example.com","phone":"416-555-0100"}'
```

Use the same path and body shape as production; only the base URL and (for local) API key in config differ.

---

## 6. Secret Update

Secrets live in AWS Secrets Manager. Source of truth for updates: JSON files in `prod-configs/`.

**Deploy all secrets (create/update from `prod-configs/`):**

```bash
./scripts/deploy-secrets.sh
```

**Dry run (no writes):**

```bash
./scripts/deploy-secrets.sh --dry-run
```

**Secret names**

- System/LLM: `better-lead-processor/app-config`
- Franchisor: `better-lead-processor/{franchisor-name}` (one secret per franchisor file in `prod-configs/`)

The script validates JSON and creates or updates each secret. Lambda reads via the Parameters and Secrets Lambda Extension (cached in the container).

**Other ways to update a secret:** AWS Console → Secrets Manager → select secret → Edit; or CLI: `aws secretsmanager put-secret-value --secret-id better-lead-processor/<name> --secret-string file://prod-configs/<file>.json`

---

## 7. Entire Infra Update

Use this when you change `template.yaml` (e.g. memory, timeout, routes, throttling, concurrency, domain, WAF).

**Pre-deploy checklist (first time)**

- **AWS:** Account with IAM permissions; S3 bucket for SAM artifacts (e.g. `zynous-blp-artifacts-prod`); Route53 hosted zone for your domain; ACM certificate; AWS CLI and SAM CLI installed and configured.
- **Config:** Populate `prod-configs/app-config.json` and `prod-configs/{franchisor-name}.json`; do not commit them (gitignored). Validate JSON: `jq empty prod-configs/app-config.json prod-configs/*.json`.
- **Code:** `pnpm build`, `pnpm test`, `pnpm lint`.

**Deploy steps**

```bash
./scripts/deploy-secrets.sh --dry-run   # optional
./scripts/deploy-secrets.sh             # deploy secrets first
pnpm build
sam build                               # or sam build --use-container if needed
sam deploy                              # or sam deploy --guided first time
```

**What SAM deploy does:** Creates/updates S3 artifacts, CloudFormation stack, Lambda (512MB), API Gateway, custom domain, Route53 record, IAM. Typically 3–5 minutes.

**Verify**

```bash
aws cloudformation describe-stacks --stack-name better-lead-processor
# Then smoke test (see §8) and:
sam logs --stack-name better-lead-processor --tail
```

---

## 8. Lambda Update (Code Only)

When only application code or dependencies change (no `template.yaml` changes), use the fast path:

```bash
./scripts/deploy-lambda.sh
```

The script builds TypeScript, runs `sam build`, then `sam deploy --no-confirm-changeset`. Much faster than a full infra deploy (~tens of seconds). Do not use this if you changed throttling, concurrency, or other resources in `template.yaml`; use section 7 instead.

**When to use what**

| Scenario | Command | Time |
|----------|---------|------|
| First deploy or infra/template changes | `sam build && sam deploy` | 3–5 min |
| Code or dependency change only | `./scripts/deploy-lambda.sh` | ~10–30 s |
| Config/API keys only | `./scripts/deploy-secrets.sh` | ~5 s |

**Smoke test after deploy**

```bash
# Endpoint 1 (direct franchise)
curl -X POST https://integration.zynous.com/api/v1/better-lead-processor/lice-squad/barrie \
  -H "Content-Type: application/json" \
  -H "X-API-Key: YOUR_API_KEY" \
  -d '{"firstName":"Test","lastName":"User","email":"test@example.com"}'

# Endpoint 2 (postal code lookup)
curl -X POST https://integration.zynous.com/api/v1/better-lead-processor/lice-squad \
  -H "Content-Type: application/json" \
  -H "X-API-Key: YOUR_API_KEY" \
  -d '{"firstName":"Jane","lastName":"Smith","email":"jane@example.com","postalCode":"L4M"}'

# Endpoint 1 (direct franchise) using key in query 
curl -X POST "https://integration.zynous.com/api/v1/better-lead-processor/lice-squad/barrie?api_key=YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"firstName":"Alice","lastName":"QueryKey","email":"alice@example.com"}'

# Endpoint 2 (postal code lookup) using key in query
curl -X POST "https://integration.zynous.com/api/v1/better-lead-processor/lice-squad?api_key=YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"firstName":"Jane","lastName":"Smith","email":"jane@example.com","postalCode":"L4M"}'


sam logs --stack-name better-lead-processor --tail
# Errors only: sam logs --stack-name better-lead-processor --tail --filter ERROR
```

---

## 9. Error Handling

**HTTP and semantics**

- **400** — Validation: bad path, invalid JSON, invalid lead data (e.g. missing required fields). Body includes `error`, `error_type`, `processed_at`.
- **401** — Invalid or missing API key (`X-API-Key` or `api_key` query).
- **403** — Franchise not active.
- **404** — Postal-code endpoint: postal code not in mapping or mapping not supported.
- **429** — Throttling (API Gateway or Lambda concurrency); retry with backoff.
- **500** — Internal error. Response body never exposes internals; message is generic. Details only in logs and, if configured, failure emails.

**Implementation**

- User-facing and email text come from `src/error-messages.ts` (e.g. `ERROR_MESSAGES.*`, `getUserFriendlyErrorReason()`). Handlers and services return these instead of raw errors.
- Validation lives in `validators.ts` and path/body/lead checks in `index.ts`; failures return the appropriate 4xx with a structured JSON body.
- On uncaught errors, the handler logs the real error, optionally sends an SES failure notification (if enabled for that franchise), and responds with a generic 500 message.

---

## 10. Retries (Lambda and LLM)

**Lambda (our code)**

- **Better CRM**
  - **OAuth token request:** Wrapped in `retry()` in `utils.ts` (default: 3 attempts, exponential backoff from 1s, max delay 30s).
  - **Create lead:** Same `retry()` with `maxRetries: 3`, `initialDelayMs: 1000`.
- **Secrets Manager:** No retry; fail fast. Lambda Extension cache reduces calls.
- **LLM (OpenAI):** No application-level retry wrapper in this repo. Transient failures surface as 500; optional failure email if configured.

**LLM side**

- LangChain/OpenAI client may perform its own retries (e.g. on 429 or network errors). We do not add an extra retry layer around `LLMMapperService.mapLeadData()`; if you need stricter guarantees, you can wrap the LLM call in `retry()` from `utils.ts` with a small `maxRetries` (e.g. 2).

**Retry helper**

- `src/utils.ts`: `retry(fn, options?)` with `maxRetries`, `initialDelayMs`, `maxDelayMs`, `backoffMultiplier`. Used by Better CRM OAuth and create-lead.

---

## API Endpoints (Summary)

**Endpoint 1 — Direct franchise**

```http
POST /api/v1/better-lead-processor/{franchisor-name}/{franchise-name}
X-API-Key: <key>   (or ?api_key=<key>)
Content-Type: application/json
```

**Endpoint 2 — Postal code → franchise**

```http
POST /api/v1/better-lead-processor/{franchisor-name}
```

Request body must include something that can be interpreted as a postal code (e.g. `postalCode`, `postal_code`, `zip`); the handler maps it to a franchise using config and then runs the same pipeline as endpoint 1.

---

## Configuration (Secrets / prod-configs)

- **System:** `better-lead-processor/app-config` — `llm_api_key`, `llm_provider`, `aws_region`, `ses_from_email`, `logging.level` (DEBUG, INFO, WARN, ERROR).
- **Franchisor:** `better-lead-processor/{franchisor-name}` — `franchisor_name`, `api_key`, `active`, `locations` (each: `franchise_name`, `postal_code_mapping`), `credentials` (Better CRM client_id, client_secret, base_url, oauth_endpoint), `config.notification_settings` (email_on_failure, notification_emails), `config.llm_settings` (model, temperature).

See `prod-configs/` for full examples. Do not commit secrets; validate with `jq empty prod-configs/*.json` before deploy-secrets.

---

## Logging

Structured JSON to CloudWatch (e.g. `timestamp`, `level`, `message`, `requestId`, `franchisorName`, `franchiseName`). No secrets or raw error objects in responses; internal details only in logs.

---

## Troubleshooting

**Deployment fails**

```bash
sam deploy --debug
aws cloudformation describe-stack-events --stack-name better-lead-processor
```

**Lambda errors**

```bash
sam logs --stack-name better-lead-processor --tail
sam logs --stack-name better-lead-processor --tail --filter ERROR
```

**Secrets not found**

```bash
aws secretsmanager list-secrets --filters Key=name,Values=better-lead-processor
aws secretsmanager get-secret-value --secret-id better-lead-processor/app-config
```

**Custom domain not resolving**

```bash
aws route53 list-resource-record-sets --hosted-zone-id YOUR_ZONE_ID
aws apigateway get-domain-name --domain-name integration.zynous.com
```

---

## Rollback

Remove the stack (keeps S3 artifacts):

```bash
sam delete
# or
aws cloudformation delete-stack --stack-name better-lead-processor
```

---

## Cost (typical)

- **Lambda:** 512MB, ~\$0.0000083/s; reserved concurrency caps max cost.
- **API Gateway:** ~\$3.50 per million requests.
- **Secrets Manager:** ~\$0.40/month per secret.
- **Total:** ~\$10–30/month at low volume (usage-dependent).

---

## Monitoring

**CloudWatch metrics**

```bash
aws cloudwatch get-metric-statistics \
  --namespace AWS/Lambda --metric-name Invocations \
  --dimensions Name=FunctionName,Value=better-lead-processor \
  --start-time 2024-01-01T00:00:00Z --end-time 2024-01-02T00:00:00Z \
  --period 3600 --statistics Sum
```

**Log Insights (examples)**

```
fields @timestamp, @message, level | filter level = "ERROR" | stats count by @message
fields @timestamp, @duration | filter @duration > 5000 | sort @duration desc
```

---

## Usage (request count for billing)

Total requests in the last 30 days (API Gateway and Lambda match; use either for billing).

**API Gateway (Count)**

```bash
START=$(date -u -v-30d +%Y-%m-%dT00:00:00Z 2>/dev/null || date -u -d '30 days ago' +%Y-%m-%dT00:00:00Z)
END=$(date -u +%Y-%m-%dT%H:%M:%SZ)
aws cloudwatch get-metric-statistics \
  --namespace AWS/ApiGateway \
  --metric-name Count \
  --dimensions Name=ApiName,Value=better-lead-processor Name=Stage,Value=production \
  --start-time "$START" --end-time "$END" \
  --period 86400 --statistics Sum --output table


Sample Output:

Period: 2025-12-31T00:00:00Z to 2026-01-30T14:37:21Z
--------------------------------------------------
|               GetMetricStatistics              |
+-----------------------+------------------------+
|  Label                |  Count                 |
+-----------------------+------------------------+
||                  Datapoints                  ||
|+------+-----------------------------+---------+|
||  Sum |          Timestamp          |  Unit   ||
|+------+-----------------------------+---------+|
||  16.0|  2026-01-24T00:00:00+00:00  |  Count  ||
||  12.0|  2026-01-25T00:00:00+00:00  |  Count  ||
|+------+-----------------------------+---------+|
```


**Lambda (Invocations)**

```bash
START=$(date -u -v-30d +%Y-%m-%dT00:00:00Z 2>/dev/null || date -u -d '30 days ago' +%Y-%m-%dT00:00:00Z)
END=$(date -u +%Y-%m-%dT%H:%M:%SZ)
aws cloudwatch get-metric-statistics \
  --namespace AWS/Lambda --metric-name Invocations \
  --dimensions Name=FunctionName,Value=better-lead-processor \
  --start-time "$START" --end-time "$END" \
  --period 86400 --statistics Sum --output table

--------------------------------------------------
|               GetMetricStatistics              |
+-----------------+------------------------------+
|  Label          |  Invocations                 |
+-----------------+------------------------------+
||                  Datapoints                  ||
|+------+-----------------------------+---------+|
||  Sum |          Timestamp          |  Unit   ||
|+------+-----------------------------+---------+|
||  16.0|  2026-01-24T00:00:00+00:00  |  Count  ||
||  12.0|  2026-01-25T00:00:00+00:00  |  Count  ||
|+------+-----------------------------+---------+|
```


Datapoints are per day (period 86400). Sum the `Sum` column for total requests in the range. For a fixed calendar month, set `START` and `END` manually (e.g. `START=2026-01-01T00:00:00Z`, `END=2026-02-01T00:00:00Z`).

---

## Testing

```bash
pnpm test
```

---

## Code Style

- TypeScript strict mode, ESLint, Prettier.
- No committed secrets; `prod-configs/` and sensitive files are gitignored.

---

## License

ISC
