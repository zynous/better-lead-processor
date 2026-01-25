/**
 * Simple local test script (no Docker required)
 * Tests the Lambda handler directly
 */

const { handler } = require('./dist/index');

// Mock Lambda context
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

// Test event
const event = {
  httpMethod: 'POST',
  path: '/api/v1/better-lead-processor/lice-squad/barrie',
  pathParameters: {
    'franchisor-name': 'lice-squad',
    'franchise-name': 'barrie',
  },
  headers: {
    'Content-Type': 'application/json',
    'X-API-Key': '550e8400-e29b-41d4-a716-446655440000',
  },
  queryStringParameters: null,
  body: {
    firstName: 'John',
    lastName: 'Doe',
    email: 'john.doe@example.com',
  },
  isBase64Encoded: false,
};

// Stringify body for handler (matches API Gateway format)
event.body = JSON.stringify(event.body);

// Run the handler
async function test() {
  console.log('🧪 Testing Lambda handler locally...\n');
  console.log('Event:', JSON.stringify(event, null, 2));
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

test();

