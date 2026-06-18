/**
 * Deployed E2E runner for the Secrets Manager-backed test location.
 *
 * It posts sanitized inputs to the deployed API, follows the async Lambda
 * invocation through CloudWatch Logs, and validates the payload sent to BPro.
 */

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const testDir = __dirname;
const projectRoot = path.join(testDir, '..', '..');
const inputPath = path.join(testDir, 'input-cases.json');
const rubricPath = path.join(testDir, 'llm-judge-rubric.json');
const outputPath = path.join(testDir, 'e2e-results.json');
const logGroupName = process.env.E2E_LOG_GROUP || '/aws/lambda/better-lead-processor';
const apiBaseUrl = (process.env.E2E_BASE_URL || 'https://integration.zynous.com').replace(/\/$/, '');
const defaultTimeoutMs = Number(process.env.E2E_TIMEOUT_MS || 180000);
const pollIntervalMs = Number(process.env.E2E_POLL_INTERVAL_MS || 5000);

function loadJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseArgs(argv) {
  const args = {
    dryRun: argv.includes('--dry-run'),
    noJudge: argv.includes('--no-judge'),
    caseArg: process.env.E2E_CASE || null,
    timeoutMs: defaultTimeoutMs,
  };

  for (const arg of argv) {
    if (arg.startsWith('--case=')) args.caseArg = arg.split('=')[1];
    if (arg.startsWith('--timeout-ms=')) args.timeoutMs = Number(arg.split('=')[1]);
  }

  const positional = argv.find((arg) => !arg.startsWith('--'));
  if (!args.caseArg && positional) args.caseArg = positional;

  if (!Number.isFinite(args.timeoutMs) || args.timeoutMs <= 0) {
    throw new Error('--timeout-ms must be a positive number');
  }

  return args;
}

function getPath(value, dotPath) {
  return dotPath.split('.').reduce((current, key) => {
    if (current == null || typeof current !== 'object') return undefined;
    return current[key];
  }, value);
}

function hasPath(value, dotPath) {
  return getPath(value, dotPath) !== undefined;
}

function assert(condition, message, issues) {
  if (!condition) issues.push(message);
}

function escapeLogsRegex(value) {
  return String(value).replace(/[\\/.^$*+?()[\]{}|]/g, '\\$&');
}

function execAws(args) {
  return new Promise((resolve, reject) => {
    execFile('aws', args, { maxBuffer: 25 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        const msg = stderr || stdout || error.message;
        reject(new Error(msg.trim()));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (parseError) {
        reject(new Error('Failed to parse AWS CLI JSON output: ' + parseError.message));
      }
    });
  });
}

async function startLogsQuery(queryString, startMs, endMs) {
  const response = await execAws([
    'logs',
    'start-query',
    '--log-group-name',
    logGroupName,
    '--start-time',
    String(Math.floor(startMs / 1000)),
    '--end-time',
    String(Math.ceil(endMs / 1000)),
    '--query-string',
    queryString,
    '--output',
    'json',
  ]);
  return response.queryId;
}

async function waitForQuery(queryId) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const response = await execAws([
      'logs',
      'get-query-results',
      '--query-id',
      queryId,
      '--output',
      'json',
    ]);

    if (response.status === 'Complete') return response.results || [];
    if (['Failed', 'Cancelled', 'Timeout'].includes(response.status)) {
      throw new Error('CloudWatch query ended with status ' + response.status);
    }
    await sleep(1000);
  }
  throw new Error('Timed out waiting for CloudWatch query ' + queryId);
}

async function runLogsQuery(queryString, startMs, endMs) {
  const queryId = await startLogsQuery(queryString, startMs, endMs);
  return waitForQuery(queryId);
}

function buildEndpoint(franchisorName, franchiseName) {
  return (
    apiBaseUrl +
    '/api/v1/better-lead-processor/' +
    encodeURIComponent(franchisorName) +
    '/' +
    encodeURIComponent(franchiseName)
  );
}

async function loadFranchisorSecret(target) {
  const secretName = target.secretName;
  if (!secretName) throw new Error('Missing target.secretName in input-cases.json');

  const response = await execAws([
    'secretsmanager',
    'get-secret-value',
    '--secret-id',
    secretName,
    '--output',
    'json',
  ]);

  const secretString = response.SecretString;
  if (!secretString) throw new Error('Secret ' + secretName + ' did not include SecretString');

  let secret;
  try {
    secret = JSON.parse(secretString);
  } catch (error) {
    throw new Error('Secret ' + secretName + ' does not contain valid JSON: ' + error.message);
  }

  if (!secret.api_key) {
    throw new Error('Secret ' + secretName + ' must include api_key for deployed API authentication');
  }

  if (!secret.franchisor_name) throw new Error('Secret ' + secretName + ' must include franchisor_name');

  const franchiseNames = Object.keys(secret.franchises || {});
  if (franchiseNames.length === 0) throw new Error('Secret ' + secretName + ' must include at least one franchise');

  const requestedFranchise = target.franchiseName;
  const franchiseKey = requestedFranchise
    ? franchiseNames.find((key) => key.toLowerCase() === String(requestedFranchise).trim().toLowerCase())
    : franchiseNames[0];

  if (!franchiseKey) throw new Error('Secret ' + secretName + ' does not include franchise ' + requestedFranchise);

  const franchise = secret.franchises[franchiseKey];
  const expectedOverrides = franchise.config?.lead_overrides || secret.config?.lead_overrides || {};

  return {
    secretName,
    franchisorName: secret.franchisor_name,
    franchiseName: franchiseKey,
    endpoint: buildEndpoint(secret.franchisor_name, franchiseKey),
    expectedOverrides,
    apiKey: secret.api_key,
  };
}

function rowToObject(row) {
  const out = {};
  for (const field of row) out[field.field] = field.value;
  return out;
}

function parseLambdaLog(rawMessage) {
  const raw = String(rawMessage || '').trim();
  const firstBrace = raw.indexOf('{');
  if (firstBrace === -1) return null;

  const prefix = raw.slice(0, firstBrace);
  const prefixParts = prefix.split('\t');
  const awsRequestId = prefixParts.length >= 2 ? prefixParts[1] : null;
  const jsonText = raw.slice(firstBrace);

  try {
    return {
      awsRequestId,
      entry: JSON.parse(jsonText),
      raw,
    };
  } catch {
    return null;
  }
}

function parseLogRows(rows) {
  return rows
    .map(rowToObject)
    .map((row) => ({
      timestamp: row['@timestamp'],
      logStream: row['@logStream'],
      parsed: parseLambdaLog(row['@message']),
      rawMessage: row['@message'],
    }))
    .filter((row) => row.parsed);
}

async function queryRequestLogs(requestId, submittedAtMs) {
  const escaped = escapeLogsRegex(requestId);
  const query = [
    'fields @timestamp, @message, @logStream',
    `| filter @message like /${escaped}/`,
    '| sort @timestamp asc',
    '| limit 100',
  ].join(' ');
  const rows = await runLogsQuery(query, submittedAtMs - 60000, Date.now() + 60000);
  return parseLogRows(rows);
}

async function queryInvocationLogs(awsRequestId, submittedAtMs) {
  const escaped = escapeLogsRegex(awsRequestId);
  const query = [
    'fields @timestamp, @message, @logStream',
    `| filter @message like /${escaped}/`,
    '| sort @timestamp asc',
    '| limit 200',
  ].join(' ');
  const rows = await runLogsQuery(query, submittedAtMs - 60000, Date.now() + 60000);
  return parseLogRows(rows);
}

function findAsyncInvocationId(requestLogs, requestId) {
  for (const row of requestLogs) {
    const entry = row.parsed.entry;
    if (entry.requestId !== requestId) continue;
    if (
      entry.message === 'Async processing started' ||
      entry.message === 'Lead processed successfully (async)' ||
      entry.message === 'Error processing lead (async)'
    ) {
      return row.parsed.awsRequestId;
    }
  }
  return null;
}

function summarizeInvocation(invocationLogs) {
  const summary = {
    payloadSentToBetter: null,
    llmReasoning: null,
    bproResponse: null,
    leadId: null,
    failure: null,
    messages: [],
  };

  for (const row of invocationLogs) {
    const entry = row.parsed.entry;
    summary.messages.push(entry.message);

    if (entry.message === 'LLM reasoning') {
      summary.llmReasoning = entry.reasoning || null;
    }

    if (entry.message === 'Payload sent to Better CRM lead API') {
      try {
        summary.payloadSentToBetter = JSON.parse(entry.payload);
      } catch {
        summary.failure = 'Could not parse logged Better payload JSON';
      }
    }

    if (entry.message === 'Better CRM create-lead response') {
      summary.bproResponse = entry.response || null;
      summary.leadId = entry.leadId || entry.response?.data?.id || null;
    }

    if (entry.message === 'Better CRM API error') {
      summary.failure = entry.message + ': ' + (entry.message || entry.status || 'unknown error');
    }

    if (entry.message === 'Error processing lead (async)') {
      summary.failure = entry.error?.message || 'Error processing lead (async)';
    }
  }

  return summary;
}

async function waitForCloudWatchEvidence(requestId, submittedAtMs, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let asyncAwsRequestId = null;
  let lastMessages = [];

  while (Date.now() < deadline) {
    const requestLogs = await queryRequestLogs(requestId, submittedAtMs);
    lastMessages = requestLogs.map((row) => row.parsed.entry.message);
    asyncAwsRequestId = asyncAwsRequestId || findAsyncInvocationId(requestLogs, requestId);

    if (asyncAwsRequestId) {
      const invocationLogs = await queryInvocationLogs(asyncAwsRequestId, submittedAtMs);
      const summary = summarizeInvocation(invocationLogs);
      summary.asyncAwsRequestId = asyncAwsRequestId;
      summary.lastMessages = invocationLogs.map((row) => row.parsed.entry.message);

      const hasSuccess = summary.bproResponse?.code === 201;
      if ((summary.payloadSentToBetter && hasSuccess) || summary.failure) {
        return summary;
      }
    }

    await sleep(pollIntervalMs);
  }

  throw new Error(
    'Timed out waiting for CloudWatch evidence for request_id ' +
      requestId +
      '. Last messages: ' +
      (lastMessages.join(', ') || 'none')
  );
}

function validatePayloadShape(payload, issues) {
  const allowedTopLevel = new Set(['profile', 'information', 'address', 'note']);
  for (const key of Object.keys(payload || {})) {
    assert(allowedTopLevel.has(key), 'Unexpected top-level Better payload key: ' + key, issues);
  }

  assert(payload && typeof payload === 'object' && !Array.isArray(payload), 'Better payload must be an object', issues);
  assert(payload.profile && typeof payload.profile === 'object', 'Better payload must include profile object', issues);
  assert(!hasPath(payload, 'interaction'), 'Better payload must not include interaction block', issues);

  const email = getPath(payload, 'profile.email_address');
  if (email !== undefined) {
    assert(
      typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email),
      'profile.email_address must be a valid email when present',
      issues
    );
  }

  const phones = getPath(payload, 'profile.phone');
  if (phones !== undefined) {
    assert(Array.isArray(phones), 'profile.phone must be an array when present', issues);
    if (Array.isArray(phones)) {
      for (const [index, phone] of phones.entries()) {
        assert(
          phone && typeof phone.formatted === 'string' && phone.formatted.trim().length > 0,
          'profile.phone[' + index + '].formatted must be non-empty',
          issues
        );
      }
    }
  }

  const address = payload.address;
  if (address !== undefined) {
    for (const key of ['deliveryAddress', 'city', 'province', 'country', 'postalCode']) {
      assert(
        typeof address[key] === 'string' && address[key].trim().length > 0,
        'address.' + key + ' must be present and non-empty when address exists',
        issues
      );
    }
  }
}

function validateDeterministic(caseDef, payload, cloudWatchSummary, expectedOverrides) {
  const issues = [];
  validatePayloadShape(payload, issues);

  for (const [dotPath, expected] of Object.entries(expectedOverrides || {})) {
    assert(
      getPath(payload, dotPath) === expected,
      'Expected override ' + dotPath + ' to equal ' + JSON.stringify(expected),
      issues
    );
  }

  for (const [field, expected] of Object.entries(caseDef.expect?.profile || {})) {
    const actual = getPath(payload, 'profile.' + field);
    assert(actual === expected, 'Expected profile.' + field + ' to equal ' + JSON.stringify(expected), issues);
  }

  for (const [field, expected] of Object.entries(caseDef.expect?.address || {})) {
    const actual = getPath(payload, 'address.' + field);
    assert(actual === expected, 'Expected address.' + field + ' to equal ' + JSON.stringify(expected), issues);
  }

  for (const [field, expected] of Object.entries(caseDef.expect?.information || {})) {
    const actual = getPath(payload, 'information.' + field);
    assert(actual === expected, 'Expected information.' + field + ' to equal ' + JSON.stringify(expected), issues);
  }

  for (const dotPath of caseDef.expect?.absentPaths || []) {
    assert(!hasPath(payload, dotPath), 'Expected path to be absent: ' + dotPath, issues);
  }

  const note = typeof payload.note === 'string' ? payload.note : '';
  for (const expected of caseDef.expect?.noteIncludes || []) {
    assert(note.includes(expected), 'Expected note to include: ' + expected, issues);
  }

  assert(
    cloudWatchSummary.bproResponse?.code === 201,
    'Expected Better CRM create-lead response code 201',
    issues
  );
  assert(Boolean(cloudWatchSummary.leadId), 'Expected Better CRM lead id in CloudWatch response', issues);

  return issues;
}

function getJudgeApiKey() {
  if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY;

  const localAppConfigPath = path.join(projectRoot, 'local-configs', 'app-config.json');
  if (fs.existsSync(localAppConfigPath)) {
    const config = loadJson(localAppConfigPath);
    return config.llm_api_key || null;
  }

  return null;
}

async function runJudge(caseDef, payload, llmReasoning, rubric) {
  const apiKey = getJudgeApiKey();
  if (!apiKey) {
    throw new Error('Missing OPENAI_API_KEY or local-configs/app-config.json llm_api_key for judge mode');
  }

  const model = process.env.E2E_JUDGE_MODEL || rubric.defaultModel || 'gpt-5-mini';
  const body = {
    model,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content:
          'You judge whether a lead mapping preserved user data and stayed compatible with Better/BPro. Return only strict JSON with pass, issues, and confidence.',
      },
      {
        role: 'user',
        content: JSON.stringify(
          {
            requiredOutputSchema: rubric.requiredOutputSchema,
            globalCriteria: rubric.globalCriteria,
            failureExamples: rubric.failureExamples,
            caseId: caseDef.id,
            caseDescription: caseDef.description,
            caseCriteria: caseDef.judgeCriteria || [],
            input: caseDef.input,
            payloadSentToBetter: payload,
            llmReasoning,
          },
          null,
          2
        ),
      },
    ],
    max_completion_tokens: 800,
  };

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error('LLM judge request failed: ' + response.status + ' ' + text.slice(0, 500));
  }

  const data = JSON.parse(text);
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error('LLM judge returned no content');

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new Error('LLM judge returned non-JSON content: ' + content.slice(0, 500));
  }

  if (typeof parsed.pass !== 'boolean' || !Array.isArray(parsed.issues)) {
    throw new Error('LLM judge JSON did not match expected schema');
  }

  return parsed;
}

async function postCase(endpoint, apiKey, caseDef) {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': apiKey,
    },
    body: JSON.stringify(caseDef.input),
  });

  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { _raw: text };
  }

  return {
    status: response.status,
    body,
  };
}

function selectCases(inputFile, caseArg) {
  const allCases = inputFile.cases || [];
  if (caseArg === null || caseArg === undefined) return allCases;

  const found = allCases.find((caseDef, index) => caseDef.id === caseArg || String(index) === caseArg);
  if (!found) {
    throw new Error('Case not found: ' + caseArg + ' (use case id or index 0..' + (allCases.length - 1) + ')');
  }
  return [found];
}

async function runCase(caseDef, rubric, args, resolvedTarget) {
  if (!resolvedTarget.endpoint) throw new Error('Missing endpoint resolved from Secrets Manager');
  if (!resolvedTarget.apiKey) throw new Error('Missing API key loaded from Secrets Manager');

  const submittedAtMs = Date.now();
  const apiResponse = await postCase(resolvedTarget.endpoint, resolvedTarget.apiKey, caseDef);

  const record = {
    id: caseDef.id,
    description: caseDef.description,
    apiStatus: apiResponse.status,
    requestId: apiResponse.body?.request_id || null,
    asyncAwsRequestId: null,
    leadId: null,
    deterministicIssues: [],
    judge: null,
    success: false,
  };

  if (apiResponse.status !== 202 || !record.requestId) {
    record.deterministicIssues.push('Expected API 202 with request_id, got ' + apiResponse.status);
    record.apiBody = apiResponse.body;
    return record;
  }

  const cloudWatchSummary = await waitForCloudWatchEvidence(record.requestId, submittedAtMs, args.timeoutMs);
  record.asyncAwsRequestId = cloudWatchSummary.asyncAwsRequestId;
  record.leadId = cloudWatchSummary.leadId;

  if (cloudWatchSummary.failure) {
    record.deterministicIssues.push(cloudWatchSummary.failure);
  }

  if (!cloudWatchSummary.payloadSentToBetter) {
    record.deterministicIssues.push('Missing logged Better payload');
  } else {
    record.deterministicIssues.push(
      ...validateDeterministic(
        caseDef,
        cloudWatchSummary.payloadSentToBetter,
        cloudWatchSummary,
        resolvedTarget.expectedOverrides
      )
    );
  }

  if (!args.noJudge && cloudWatchSummary.payloadSentToBetter) {
    try {
      record.judge = await runJudge(
        caseDef,
        cloudWatchSummary.payloadSentToBetter,
        cloudWatchSummary.llmReasoning,
        rubric
      );
      if (!record.judge.pass) {
        record.deterministicIssues.push('LLM judge failed: ' + record.judge.issues.join('; '));
      }
    } catch (error) {
      record.deterministicIssues.push(error.message);
    }
  }

  record.success = record.deterministicIssues.length === 0;
  return record;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const inputFile = loadJson(inputPath);
  const rubric = loadJson(rubricPath);
  const cases = selectCases(inputFile, args.caseArg);
  const target = inputFile.target || {};
  const resolvedTarget = await loadFranchisorSecret(target);

  console.log('E2E LLM -> Better validation');
  console.log('============================');
  console.log('Secret:', resolvedTarget.secretName);
  console.log('Target:', resolvedTarget.franchisorName + ' / ' + resolvedTarget.franchiseName);
  console.log('Endpoint:', resolvedTarget.endpoint);
  console.log('Log group:', logGroupName);
  console.log('Judge:', args.noJudge ? 'disabled' : 'enabled');
  console.log('Cases:', cases.length);

  if (args.dryRun) {
    cases.forEach((caseDef, index) => {
      console.log(index + 1 + '. ' + caseDef.id + ' - ' + caseDef.description);
    });
    return;
  }

  const results = [];
  let passed = 0;
  let failed = 0;

  for (const caseDef of cases) {
    process.stdout.write(caseDef.id + ' ... ');
    let record;
    try {
      record = await runCase(caseDef, rubric, args, resolvedTarget);
    } catch (error) {
      record = {
        id: caseDef.id,
        description: caseDef.description,
        success: false,
        deterministicIssues: [error.message],
      };
    }

    results.push(record);
    if (record.success) {
      passed++;
      console.log('PASS' + (record.leadId ? ' lead_id=' + record.leadId : ''));
    } else {
      failed++;
      console.log('FAIL');
      for (const issue of record.deterministicIssues) console.log('  - ' + issue);
    }
  }

  const summary = {
    runAt: new Date().toISOString(),
    target: {
      secretName: resolvedTarget.secretName,
      franchisorName: resolvedTarget.franchisorName,
      franchiseName: resolvedTarget.franchiseName,
      endpoint: resolvedTarget.endpoint,
    },
    total: results.length,
    passed,
    failed,
    judgeEnabled: !args.noJudge,
    results,
  };

  fs.writeFileSync(outputPath, JSON.stringify(summary, null, 2), 'utf8');
  console.log('');
  console.log('Summary: ' + passed + ' passed, ' + failed + ' failed. Results written to ' + outputPath);

  if (failed > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
