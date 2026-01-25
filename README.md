# Better Lead Processor

Serverless Lambda function to process and map unstructured lead data to Better CRM format using LLM (OpenAI + LangChain).

## Architecture

- **API Gateway**: REST API endpoints for receiving lead data
- **Lambda**: Single function handling all processing logic
- **Secrets Manager**: Stores franchise configurations and LLM API key
- **SES**: Email notifications on processing failures
- **OpenAI + LangChain**: Intelligent data mapping from unstructured to structured format

## Tech Stack

- **Runtime**: Node.js 24.x
- **Language**: TypeScript
- **LLM**: OpenAI (via LangChain)
- **Validation**: Zod
- **Infrastructure**: AWS SAM (Serverless Application Model)
- **Logging**: Structured JSON logging for CloudWatch

## Project Structure

```
better-lead-processor/
├── src/
│   ├── index.ts                 # Main Lambda handler
│   ├── types/                   # TypeScript types and Zod schemas
│   ├── services/                # Business logic services
│   │   ├── secrets-manager.ts   # Config/secret retrieval
│   │   ├── better-crm.ts        # Better CRM API client
│   │   ├── llm-mapper.ts        # LLM-based data mapping
│   │   └── email.ts             # SES email notifications
│   └── utils/                   # Utility functions
│       ├── logger.ts            # Structured JSON logging
│       ├── postal-code.ts       # Postal code extraction
│       └── retry.ts              # Retry with exponential backoff
├── local-configs/               # Local config files for testing
├── events/                      # Test events for SAM local
├── template.yaml                # SAM template
└── package.json
```

## Setup

### Prerequisites

- Node.js 24.x
- pnpm 9.0.0+ (`npm install -g pnpm`)
- AWS SAM CLI
- AWS CLI configured

### Installation

```bash
pnpm install
```

### Build

```bash
pnpm build
```

## Local Development

### 1. Create Local Config Files

Copy example configs and update with your values:

```bash
cp local-configs/app-config.json.example local-configs/app-config.json
cp local-configs/lice-squad/barrie.json.example local-configs/lice-squad/barrie.json
```

Edit the config files with your actual credentials and API keys.

### 2. Test Locally

```bash
# Build TypeScript
pnpm build

# Invoke function locally
sam local invoke LeadProcessorFunction -e events/test-event-endpoint1.json

# Start local API Gateway
sam local start-api
```

Then test with:

```bash
curl -X POST http://localhost:3000/api/v1/better-lead-processor/lice-squad/barrie \
  -H "Content-Type: application/json" \
  -H "X-API-Key: 550e8400-e29b-41d4-a716-446655440000" \
  -d '{
    "firstName": "John",
    "lastName": "Doe",
    "email": "john.doe@example.com",
    "phone": "+1-555-123-4567",
    "postalCode": "L4M 1A1"
  }'
```

## Deployment

### Build and Deploy

```bash
# Build TypeScript
pnpm build

# Build SAM application
sam build

# Deploy
sam deploy --guided
```

## API Endpoints

### Endpoint 1: Direct Franchise Processing

```
POST /api/v1/better-lead-processor/{franchisor-name}/{franchise-name}
```

**Headers:**
- `X-API-Key` or `api_key` query parameter

**Body:** Unstructured lead data (JSON)

**Example:**
```json
{
  "firstName": "John",
  "lastName": "Doe",
  "email": "john.doe@example.com",
  "phone": "+1-555-123-4567",
  "postalCode": "L4M 1A1"
}
```

### Endpoint 2: Postal Code to Franchise Mapping

```
POST /api/v1/better-lead-processor/{franchisor-name}
```

**Note:** This endpoint requires postal code in the request body and will map to the appropriate franchise based on postal code mapping configuration.

## Configuration

### Secrets Manager Structure

**Franchise Config:**
```
better-lead-processor/franchise/{franchisor-name}/{franchise-name}/config
```

**System Config:**
```
better-lead-processor/llm-api-key
```

### Config Schema

See `local-configs/*.json.example` for the full configuration structure.

## Logging

Logs are output in structured JSON format for CloudWatch Logs Insights:

```json
{
  "timestamp": "2024-01-01T12:00:00.000Z",
  "level": "INFO",
  "message": "Lead processed successfully",
  "requestId": "abc123",
  "franchisorName": "lice-squad",
  "franchiseName": "barrie",
  "leadId": 12345
}
```

## Error Handling

- **400**: Bad Request (validation errors)
- **401**: Unauthorized (invalid API key)
- **403**: Forbidden (franchise not active)
- **500**: Internal Server Error

On processing failures, email notifications are sent to configured addresses (if enabled).

## Testing

```bash
pnpm test
```

## Code Style

- TypeScript with strict mode
- ESLint for linting
- Prettier for formatting
- Structured logging
- Error handling with retries

## License

ISC

