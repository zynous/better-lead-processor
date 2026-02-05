/**
 * Run full LLM → post-process → CRM workflow for each input case.
 * Output is probe-style: one line per case (✅/❌ id → status), then summary.
 * Cases with skipForCrmFlow: true are skipped (e.g. required-fields-missing).
 *
 * Prerequisites:
 * - pnpm build
 * - local-configs/app-config.json and local-configs/lice-squad.json (or --franchisor/--franchise)
 *
 * Usage (from project root):
 *   node test/run-llm-crm-tests.js                    # run all (skipping skipForCrmFlow)
 *   node test/run-llm-crm-tests.js <caseId>           # run one case by id (e.g. minimal-camel)
 *   node test/run-llm-crm-tests.js <index>            # run one case by index (e.g. 0)
 *   node test/run-llm-crm-tests.js --case=<id|index>  # same, explicit flag
 *   node test/run-llm-crm-tests.js --dry-run         # list cases only
 *
 * Output:
 *   test/llm-crm-results.json  (full results)
 *   Console: ✅/❌ per case, then "Summary: X passed, Y failed"
 */

const fs = require('fs');
const path = require('path');

const projectRoot = path.join(__dirname, '..');
const localConfigsDir = path.join(projectRoot, 'local-configs');
const testDir = __dirname;

if (!fs.existsSync(path.join(localConfigsDir, 'app-config.json'))) {
  console.error('Missing local-configs/app-config.json. Copy from prod-configs or create for local testing.');
  process.exit(1);
}
if (!fs.existsSync(path.join(localConfigsDir, 'lice-squad.json'))) {
  console.error('Missing local-configs/lice-squad.json. Copy from prod-configs or create for local testing.');
  process.exit(1);
}

const { handler } = require(path.join(projectRoot, 'dist/index'));

const context = {
  awsRequestId: 'test-request-' + Date.now(),
  functionName: 'better-lead-processor',
  functionVersion: '$LATEST',
  invokedFunctionArn: 'arn:aws:lambda:us-east-1:123456789012:function:better-lead-processor',
  memoryLimitInMB: '1024',
  logGroupName: '/aws/lambda/better-lead-processor',
  logStreamName: '2024/01/01/[$LATEST]llm-crm-test',
  getRemainingTimeInMillis: () => 300000,
};

function buildEvent(body, apiKey, franchisorName = 'lice-squad', franchiseName = 'barrie') {
  return {
    httpMethod: 'POST',
    path: `/api/v1/better-lead-processor/${franchisorName}/${franchiseName}`,
    pathParameters: {
      'franchisor-name': franchisorName,
      'franchise-name': franchiseName,
    },
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': apiKey,
    },
    queryStringParameters: null,
    body: JSON.stringify(body),
    isBase64Encoded: false,
  };
}

function parseErrorBody(body) {
  if (body && typeof body.error === 'string') return body.error;
  if (body && typeof body.message === 'string') return body.message;
  if (body && typeof body === 'object') return JSON.stringify(body).slice(0, 120);
  return null;
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const caseFromFlag = process.env.LLM_CRM_CASE || process.argv.find((a) => a.startsWith('--case='))?.split('=')[1];
  const positional = process.argv.slice(2).find((a) => !a.startsWith('--'));
  const caseArg = caseFromFlag !== undefined ? caseFromFlag : positional;

  const inputPath = path.join(testDir, 'input-cases.json');
  if (!fs.existsSync(inputPath)) {
    console.error('Missing test/input-cases.json');
    process.exit(1);
  }

  const inputFile = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
  let cases = (inputFile.cases || []).filter((c) => !c.skipForCrmFlow);

  if (caseArg !== undefined) {
    const allCases = inputFile.cases || [];
    const found = allCases.find((c, i) => c.id === caseArg || String(i) === caseArg);
    if (!found) {
      console.error('Case not found:', caseArg, '(use case id or index 0..' + (allCases.length - 1) + ')');
      process.exit(1);
    }
    cases = found.skipForCrmFlow ? [] : [found];
    if (cases.length === 0) {
      console.error('Case', found.id, 'is skipped for CRM flow (skipForCrmFlow: true)');
      process.exit(1);
    }
    console.log('LLM → CRM flow (single case: ' + found.id + ')');
  } else {
    console.log('LLM → CRM flow');
  }

  console.log('==================');
  console.log('Cases to run:', cases.length);

  if (dryRun) {
    cases.forEach((c, i) => console.log((i + 1) + '. ' + c.id + ': ' + (c.description || '')));
    return;
  }

  if (cases.length === 0) {
    console.log('No cases to run (all skipped).');
    return;
  }

  const apiKey = inputFile.apiKey || '550e8400-e29b-41d4-a716-546655440000';
  const results = [];
  let passed = 0;
  let failed = 0;

  for (let i = 0; i < cases.length; i++) {
    const c = cases[i];
    const id = c.id || 'case-' + (i + 1);
    const event = buildEvent(c.input, apiKey);

    let result;
    try {
      result = await handler(event, context);
    } catch (err) {
      result = {
        statusCode: 500,
        body: JSON.stringify({ error: err.message || String(err) }),
      };
    }

    const status = result.statusCode;
    let body = null;
    try {
      body = result.body ? JSON.parse(result.body) : null;
    } catch {
      body = { _raw: result.body };
    }

    const success = status === 202;
    if (success) passed++;
    else failed++;

    const record = {
      id,
      description: c.description || null,
      status,
      success,
      message: success ? (body?.message || null) : parseErrorBody(body),
    };
    results.push(record);

    const icon = success ? '✅' : '❌';
    const msg = record.message ? ' | ' + (record.message.slice(0, 80) + (record.message.length > 80 ? '…' : '')) : '';
    console.log(icon + ' ' + id + ' → ' + status + msg);
  }

  const summary = {
    runAt: new Date().toISOString(),
    total: cases.length,
    passed,
    failed,
    results,
  };

  const outPath = path.join(testDir, 'llm-crm-results.json');
  fs.writeFileSync(outPath, JSON.stringify(summary, null, 2), 'utf8');
  console.log('');
  console.log('Summary: ' + passed + ' passed, ' + failed + ' failed. Results written to ' + outPath);

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
