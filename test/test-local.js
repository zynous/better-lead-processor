/**
 * Simple local test script (no Docker required)
 * Tests the Lambda handler directly. Use "Debug Handler" in Run and Debug to run with breakpoints.
 *
 * Prerequisites:
 * - pnpm build (run once; or use preLaunchTask in launch.json)
 * - local-configs/app-config.json and local-configs/{franchisor}.json (copy from prod-configs or create)
 *
 * Usage (from project root):
 *   node test/test-local.js              # default event (Test, User, test@example.com)
 *   node test/test-local.js <caseId>     # run one case from test/input-cases.json (e.g. minimal-camel)
 *   node test/test-local.js events/cognito-estimate.json   # event file (e.g. Cognito payload)
 */

const fs = require('fs');
const path = require('path');

const projectRoot = path.join(__dirname, '..');
const localConfigsDir = path.join(projectRoot, 'local-configs');

if (!fs.existsSync(path.join(localConfigsDir, 'app-config.json'))) {
  console.error('Missing local-configs/app-config.json. Copy from prod-configs/app-config.json or create for local testing.');
  process.exit(1);
}
const caseArg = process.argv[2];
const eventFileFranchisor = caseArg?.endsWith('.json') && caseArg !== 'input-cases.json'
  ? (() => {
      const eventPath = path.isAbsolute(caseArg) ? caseArg : path.join(projectRoot, caseArg);
      if (!fs.existsSync(eventPath)) return null;
      try {
        const ev = JSON.parse(fs.readFileSync(eventPath, 'utf8'));
        return ev.pathParameters?.['franchisor-name'] || null;
      } catch {
        return null;
      }
    })()
  : null;
const requiredFranchisorConfig = eventFileFranchisor || 'lice-squad';
if (!fs.existsSync(path.join(localConfigsDir, `${requiredFranchisorConfig}.json`))) {
  console.error(`Missing local-configs/${requiredFranchisorConfig}.json. Copy from prod-configs or create for local testing.`);
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
    path: '/api/v1/better-lead-processor/lice-squad',
    pathParameters: {
      'franchisor-name': 'lice-squad'
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

if (caseArg) {
  // Event file path (e.g. events/cognito-estimate.json) for Run and Debug
  if (caseArg.endsWith('.json')) {
    const eventPath = path.isAbsolute(caseArg) ? caseArg : path.join(projectRoot, caseArg);
    if (!fs.existsSync(eventPath)) {
      console.error('Event file not found:', eventPath);
      process.exit(1);
    }
    event = JSON.parse(fs.readFileSync(eventPath, 'utf8'));
    // API Gateway sends body as string
    if (event.body != null && typeof event.body === 'object') {
      event.body = JSON.stringify(event.body);
    }
    console.log('Using event file:', caseArg);
  } else {
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
}

async function runTest() {
  console.log('🧪 Testing Lambda handler locally...\n');
  console.log('Event:', JSON.stringify({ ...event, body: JSON.parse(event.body) }, null, 2));
  console.log('\n---\n');

  try {
    const result = await handler(event, context);
    const status = result.statusCode;
    const body = JSON.parse(result.body);
    console.log(status >= 200 && status < 300 ? '✅ Success!' : status >= 400 ? '⚠️ Client/Server error (expected for some cases)' : 'Response');
    console.log('Status Code:', status);
    console.log('Response:', JSON.stringify(body, null, 2));
  } catch (error) {
    console.error('❌ Error:', error.message);
    console.error('Stack:', error.stack);
    process.exit(1);
  }
}

runTest();
