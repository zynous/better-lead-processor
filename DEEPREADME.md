# Better Lead Processor — Quick reference

## How to run locally

1. **Prerequisites:** Node.js 24.x, pnpm. From repo root: `pnpm install` then `pnpm build`.
2. **Config:** Add `local-configs/app-config.json` (e.g. `llm_api_key`, `better_crm_base_url`) and `local-configs/{franchisor}.json` (e.g. `ygm.json` with `franchises.barrie.credentials`). Copy shapes from `prod-configs/` or see main README.
3. **Run:** `node test/test-local.js events/cognito-estimate.json` (or `events/common.json`). Uses `process.cwd()/local-configs/`; run from project root.
4. **Optional:** `sam local invoke LeadProcessorFunction -e events/common.json` or `sam local start-api` for a local API.

## How to deploy to cloud

1. **Secrets:** Put production configs in `prod-configs/` (e.g. `app-config.json`, `{franchisor}.json`). Run `./scripts/deploy-secrets.sh` to push to AWS Secrets Manager.
2. **Build:** `pnpm build` then `sam build` (use `--use-container` if needed).
3. **Deploy:** `sam deploy` (first time: `sam deploy --guided`). Use when changing `template.yaml` (infra, throttling, etc.).
4. **Code-only (faster):** For code/deps only, run `y` instead of steps 2–3.
5. **Verify:** Smoke test the live URL (see README) and `sam logs --stack-name better-lead-processor --tail` if needed.
