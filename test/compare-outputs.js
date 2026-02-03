/**
 * Compare test/actual-output.json with test/expected-output.json.
 * Uses deep equality (same keys and values; key order ignored).
 *
 * Usage (from project root): node test/compare-outputs.js
 */

const fs = require('fs');
const path = require('path');

const testDir = path.join(__dirname);
const actualPath = path.join(testDir, 'actual-output.json');
const expectedPath = path.join(testDir, 'expected-output.json');

function deepEqual(a, b) {
  if (a === b) return true;
  if (a == null || b == null || typeof a !== 'object' || typeof b !== 'object') return false;
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  for (const key of keysA) {
    if (!keysB.includes(key) || !deepEqual(a[key], b[key])) return false;
  }
  return true;
}

const actual = JSON.parse(fs.readFileSync(actualPath, 'utf8'));
const expected = JSON.parse(fs.readFileSync(expectedPath, 'utf8'));

const expectedById = new Map(expected.cases.map((c) => [c.id, c.expected]));

let passed = 0;
let failed = 0;

console.log('Comparing actual vs expected (deep equality, order ignored)\n');

for (const c of actual.cases) {
  if (c.error) {
    console.log(`  ❌ ${c.id}: actual had error: ${c.error}`);
    failed++;
    continue;
  }
  const exp = expectedById.get(c.id);
  if (!exp) {
    console.log(`  ❌ ${c.id}: no expected entry`);
    failed++;
    continue;
  }
  if (deepEqual(c.output, exp)) {
    console.log(`  ✅ ${c.id}`);
    passed++;
  } else {
    console.log(`  ❌ ${c.id}: output !== expected`);
    failed++;
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
