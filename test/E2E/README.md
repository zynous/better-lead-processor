# E2E LLM To Better Validation

This suite validates the deployed LLM mapping path for the test location configured in Secrets Manager secret `better-lead-processor/deep`:

```text
input case -> deployed API -> Lambda -> LLM mapper -> post-process -> Better/BPro
```

The runner reads `franchisor_name`, the franchise key, `api_key`, and lead overrides from the secret, builds the deployed API path, then polls CloudWatch Logs for the async Lambda invocation. It validates the actual payload logged as sent to Better and the BPro `201` create-lead response.

## Files

| File | Purpose |
|------|---------|
| `input-cases.json` | Sanitized live E2E inputs and deterministic expectations. |
| `llm-judge-rubric.json` | Criteria used by the optional LLM judge. |
| `run-e2e.js` | Deployed E2E runner. |
| `e2e-results.json` | Generated results file after a run. |

## Prerequisites

- AWS CLI configured for the account that owns `/aws/lambda/better-lead-processor`.
- The deployed Secrets Manager secret `better-lead-processor/deep` must include `franchisor_name`, `api_key`, at least one franchise, and the expected lead overrides.
- The runner reads target config directly from `better-lead-processor/deep`, matching the deployed handler's franchisor secret flow.
- For judge mode, set `OPENAI_API_KEY` or have `local-configs/app-config.json` with `llm_api_key`.

## Run

From the project root:

```bash
pnpm build
pnpm run test:e2e -- --dry-run
pnpm run test:e2e
```

Optional:

```bash
node test/E2E/run-e2e.js --case=nested-contact-full-address
node test/E2E/run-e2e.js --no-judge
node test/E2E/run-e2e.js --timeout-ms=180000
```

`--no-judge` skips the OpenAI judge and only uses deterministic checks plus CloudWatch/BPro evidence.

## What Passes

Each runnable case must:

- Return `202` from the deployed API with a `request_id`.
- Produce a CloudWatch `Payload sent to Better CRM lead API` log in the matching async invocation.
- Produce a `Better CRM create-lead response` log with `response.code === 201`.
- Include the configured `llm-test` lead overrides: `source_id`, email/SMS flags, call permission, and marketing email permission.
- Avoid known BPro rejection shapes: invalid email, empty phone formatted value, incomplete address object, and `interaction`.
- Pass the LLM judge unless `--no-judge` is used.

The fixtures are inspired by recent CloudWatch input shapes, but names, emails, phones, and addresses are synthetic.
