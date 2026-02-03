/**
 * Simple local test script (no Docker required)
 * Tests the Lambda handler directly. Use "Debug Handler" in Run and Debug to run with breakpoints.
 *
 * Prerequisites:
 * - pnpm build (run once; or use preLaunchTask in launch.json)
 * - local-configs/app-config.json and local-configs/lice-squad.json (copy from prod-configs or create)
 *
 * Usage (from project root):
 *   node test/test-local.js              # default event (Test, User, test@example.com)
 *   node test/test-local.js <caseId>     # run one case from test/input-cases.json (e.g. minimal-camel)
 *   node test/test-local.js <index>      # run case by index (e.g. 0)
 */

const fs = require('fs');
const path = require('path');

const projectRoot = path.join(__dirname, '..');
const localConfigsDir = path.join(projectRoot, 'local-configs');

if (!fs.existsSync(path.join(localConfigsDir, 'app-config.json'))) {
  console.error('Missing local-configs/app-config.json. Copy from prod-configs/app-config.json or create for local testing.');
  process.exit(1);
}
if (!fs.existsSync(path.join(localConfigsDir, 'lice-squad.json'))) {
  console.error('Missing local-configs/lice-squad.json. Copy from prod-configs/lice-squad.json or create for local testing.');
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
  logStreamName: '2024/01/01/[$LATEST]test',
  getRemainingTimeInMillis: () => 300000,
};

function buildEvent(body, apiKey = '550e8400-e29b-41d4-a716-546655440000') {
  return {
    httpMethod: 'POST',
    path: '/api/v1/better-lead-processor/lice-squad/barrie',
    pathParameters: {
      'franchisor-name': 'lice-squad',
      'franchise-name': 'barrie',
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

let event = buildEvent({
  firstName: 'Test',
  lastName: 'User',
  email: 'test@example.com',
  phone: '+1-555-123-4567',
});

const caseArg = process.argv[2];
if (caseArg) {
  const inputPath = path.join(__dirname, 'input-cases.json');
  if (!fs.existsSync(inputPath)) {
    console.error('test/input-cases.json not found.');
    process.exit(1);
  }
  const inputFile = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
  const cases = inputFile.cases || [];
  const apiKey = inputFile.apiKey || '550e8400-e29b-41d4-a716-546655440000';
  const found = cases.find((c, i) => c.id === caseArg || String(i) === caseArg);
  if (!found) {
    console.error('Case not found:', caseArg, '(use case id or index 0..' + (cases.length - 1) + ')');
    process.exit(1);
  }
  event = buildEvent(found.input, apiKey);
  console.log('Using case:', found.id, '-', found.description || '');
}

async function runTest() {
  console.log('🧪 Testing Lambda handler locally...\n');
  console.log('Event:', JSON.stringify({ ...event, body: JSON.parse(event.body) }, null, 2));
  console.log('\n---\n');

  try {
    const result = await handler(event, context);
    console.log('✅ Success!');
    console.log('Response:', JSON.stringify(JSON.parse(result.body), null, 2));
    console.log('Status Code:', result.statusCode);
  } catch (error) {
    console.error('❌ Error:', error.message);
    console.error('Stack:', error.stack);
    process.exit(1);
  }
}

runTest();
