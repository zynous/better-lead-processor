/**
 * Run mapping test cases: for each input in input-cases.json, call the LLM mapper
 * then post-process (no Lambda handler, no Better CRM) and write results to actual-output.json.
 *
 * Prerequisites:
 * - pnpm build
 * - local-configs/app-config.json and local-configs/lice-squad.json
 *
 * Usage (from project root): node test/run-mapping-tests.js
 *
 * Then compare with expected: node test/compare-outputs.js
 * (compares actual-output.json with expected-output.json; expected should be post-processed shape).
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

delete process.env.AWS_LAMBDA_FUNCTION_NAME;

const { getSystemConfig, getFranchiseConfig } = require(path.join(projectRoot, 'dist/services/secrets-manager'));
const { LLMMapperService } = require(path.join(projectRoot, 'dist/services/llm-mapper'));
const { postProcessLead } = require(path.join(projectRoot, 'dist/services/lead-post-processor'));

async function runMappingTests() {
  const inputPath = path.join(testDir, 'input-cases.json');
  const outputPath = path.join(testDir, 'actual-output.json');

  const inputFile = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
  const cases = inputFile.cases || [];
  if (cases.length === 0) {
    console.error('No cases in input-cases.json');
    process.exit(1);
  }

  console.log(`Running ${cases.length} mapping test cases...\n`);

  const systemConfig = await getSystemConfig();
  const franchiseConfig = await getFranchiseConfig('lice-squad', 'barrie');
  const mapper = new LLMMapperService(systemConfig, franchiseConfig);

  const results = {
    description: 'Actual output (LLM + post-process) from run-mapping-tests.js. Compare with expected-output.json via compare-outputs.js.',
    runAt: new Date().toISOString(),
    cases: [],
  };

  for (let i = 0; i < cases.length; i++) {
    const tc = cases[i];
    const id = tc.id || `case-${i + 1}`;
    const description = tc.description || '';
    const input = tc.input || {};

    process.stdout.write(`  [${i + 1}/${cases.length}] ${id} ... `);
    try {
      const mapped = await mapper.mapLeadData(input);
      const output = postProcessLead(mapped, {
        defaultSourceId: franchiseConfig.config?.lead_defaults?.source_id,
        defaultIsEnabledEmail: franchiseConfig.config?.lead_defaults?.is_enabled_email,
        defaultIsEnabledSms: franchiseConfig.config?.lead_defaults?.is_enabled_sms,
      });
      results.cases.push({
        id,
        description,
        input,
        output: JSON.parse(JSON.stringify(output)),
      });
      console.log('OK');
    } catch (err) {
      console.log('FAIL');
      results.cases.push({
        id,
        description,
        input,
        error: err.message || String(err),
      });
    }
  }

  fs.writeFileSync(outputPath, JSON.stringify(results, null, 2), 'utf8');
  console.log(`\nWrote ${results.cases.length} results to test/actual-output.json`);
}

runMappingTests().catch((err) => {
  console.error(err);
  process.exit(1);
});
