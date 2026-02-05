/**
 * CRM Lead API Probe
 *
 * Calls the Better CRM Lead API (v2/crm/lead) directly with an extensive set of
 * payload combinations to discover:
 * - Which parameter combinations are accepted vs rejected
 * - What is mandatory vs optional
 * - Validation rules (e.g. email format, address completeness)
 *
 * Prerequisites:
 * - local-configs/app-config.json (must contain better_crm_base_url)
 * - local-configs/<franchisor>.json with at least one franchise having
 *   credentials.client_id and credentials.client_secret
 *
 * Usage (from project root):
 *   node test/crm-api-probe.js
 *   node test/crm-api-probe.js --case=first-name-only   # run one case by id
 *   node test/crm-api-probe.js --case=0                 # run one case by index (0-based)
 *   node test/crm-api-probe.js --franchisor lice-squad --franchise "My Franchise"
 *   node test/crm-api-probe.js --dry-run   # list cases only, no API calls
 *
 * Output:
 *   test/crm-api-probe-results.json  (full results)
 *   Console summary: accepted / rejected counts and per-case status
 */

const fs = require('fs');
const path = require('path');

const projectRoot = path.join(__dirname, '..');
const localConfigsDir = path.join(projectRoot, 'local-configs');

function loadJson(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  return JSON.parse(raw);
}

function getConfig() {
  const appConfigPath = path.join(localConfigsDir, 'app-config.json');
  if (!fs.existsSync(appConfigPath)) {
    console.error('Missing local-configs/app-config.json. Need better_crm_base_url for CRM API.');
    process.exit(1);
  }
  const appConfig = loadJson(appConfigPath);
  const baseUrl = (appConfig.better_crm_base_url || '').replace(/\/$/, '');
  if (!baseUrl) {
    console.error('app-config.json must contain better_crm_base_url');
    process.exit(1);
  }

  const franchisorName = process.env.FRANCHISOR || process.argv.find((a) => a.startsWith('--franchisor='))?.split('=')[1] || 'lice-squad';
  const franchiseNameArg = process.env.FRANCHISE || process.argv.find((a) => a.startsWith('--franchise='))?.split('=')[1];
  const franchisorPath = path.join(localConfigsDir, `${franchisorName}.json`);
  if (!fs.existsSync(franchisorPath)) {
    console.error('Missing local-configs/' + franchisorName + '.json');
    process.exit(1);
  }
  const franchisorConfig = loadJson(franchisorPath);
  const franchises = franchisorConfig.franchises || {};
  const franchiseNames = Object.keys(franchises);
  if (franchiseNames.length === 0) {
    console.error('No franchises defined in ' + franchisorName + '.json');
    process.exit(1);
  }
  const franchiseName = franchiseNameArg || franchiseNames[0];
  const franchise = franchises[franchiseName];
  if (!franchise?.credentials?.client_id || !franchise?.credentials?.client_secret) {
    console.error('Franchise "' + franchiseName + '" must have credentials.client_id and client_secret');
    process.exit(1);
  }

  return {
    baseUrl,
    franchisorName,
    franchiseName,
    clientId: franchise.credentials.client_id,
    clientSecret: franchise.credentials.client_secret,
  };
}

async function getAccessToken(baseUrl, clientId, clientSecret) {
  const oauthUrl = `${baseUrl}/oauth/access_token`;
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: clientId,
    client_secret: clientSecret,
  });
  const res = await fetch(oauthUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error('OAuth failed: ' + res.status + ' ' + text);
  }
  const data = await res.json();
  return data.access_token;
}

async function createLead(baseUrl, accessToken, payload) {
  const url = `${baseUrl}/v2/crm/lead`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { _raw: text };
  }
  return { status: res.status, statusText: res.statusText, body, ok: res.ok };
}

function parseApiMessage(body) {
  if (body && typeof body.msg === 'string') return body.msg;
  if (body && typeof body.message === 'string') return body.message;
  if (body && body.data && typeof body.data === 'object') return JSON.stringify(body.data);
  return null;
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const caseArg = process.env.CRM_PROBE_CASE || process.argv.find((a) => a.startsWith('--case='))?.split('=')[1];
  const casesPath = path.join(__dirname, 'crm-api-probe-cases.json');
  if (!fs.existsSync(casesPath)) {
    console.error('Missing test/crm-api-probe-cases.json');
    process.exit(1);
  }
  let { cases } = loadJson(casesPath);
  if (caseArg !== undefined) {
    const found = cases.find((c, i) => c.id === caseArg || String(i) === caseArg);
    if (!found) {
      console.error('Case not found:', caseArg, '(use case id or index 0..' + (cases.length - 1) + ')');
      process.exit(1);
    }
    cases = [found];
    console.log('CRM Lead API Probe (single case: ' + found.id + ')');
  } else {
    console.log('CRM Lead API Probe');
  }
  console.log('==================');
  console.log('Cases to run:', cases.length);
  if (dryRun) {
    cases.forEach((c, i) => console.log((i + 1) + '. ' + c.id + ': ' + c.description));
    return;
  }

  const config = getConfig();
  console.log('Base URL:', config.baseUrl);
  console.log('Franchisor:', config.franchisorName, '| Franchise:', config.franchiseName);
  console.log('');

  let accessToken;
  try {
    accessToken = await getAccessToken(config.baseUrl, config.clientId, config.clientSecret);
    console.log('OAuth token obtained.');
  } catch (e) {
    console.error('Failed to get OAuth token:', e.message);
    process.exit(1);
  }

  const results = [];
  let accepted = 0;
  let rejected = 0;

  for (let i = 0; i < cases.length; i++) {
    const c = cases[i];
    const result = await createLead(config.baseUrl, accessToken, c.payload);
    const success = result.status === 201 && result.body && result.body.code === 201;
    if (success) accepted++;
    else rejected++;

    const record = {
      id: c.id,
      description: c.description,
      status: result.status,
      bodyCode: result.body?.code,
      success,
      apiMessage: parseApiMessage(result.body) || (result.body ? JSON.stringify(result.body) : null),
    };
    results.push(record);
    const icon = success ? '✅' : '❌';
    console.log(icon + ' ' + c.id + ' → ' + result.status + (result.body?.code != null ? ' (body code ' + result.body.code + ')' : '') + (record.apiMessage ? ' | ' + (record.apiMessage.slice(0, 80) + (record.apiMessage.length > 80 ? '…' : '')) : ''));
  }

  const summary = {
    runAt: new Date().toISOString(),
    baseUrl: config.baseUrl,
    franchisor: config.franchisorName,
    franchise: config.franchiseName,
    total: cases.length,
    accepted,
    rejected,
    results,
  };

  const outPath = path.join(__dirname, 'crm-api-probe-results.json');
  fs.writeFileSync(outPath, JSON.stringify(summary, null, 2), 'utf8');
  console.log('');
  console.log('Summary: ' + accepted + ' accepted, ' + rejected + ' rejected. Results written to ' + outPath);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
