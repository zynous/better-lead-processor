/* eslint-disable no-console */
/**
 * Utility: extract unique Canadian FSAs (first 3 chars) from an .xlsx file.
 *
 * Usage:
 *   node scripts/extract-fsas-from-xlsx.js "lice_squad_locations/Winnipeg - North & South - Oct 2019.xlsx"
 */
const path = require('path');
const XLSX = require('xlsx');

const input = process.argv[2];
if (!input) {
  console.error('Missing input path. Example: node scripts/extract-fsas-from-xlsx.js "path/to/file.xlsx"');
  process.exit(1);
}

const file = path.isAbsolute(input) ? input : path.join(process.cwd(), input);
const wb = XLSX.readFile(file, { cellText: false, cellDates: false });

/** Match either full postal code or an FSA token like "R2P". */
const postalRe = /\b([A-Za-z]\d[A-Za-z])\s*\d[A-Za-z]\d\b|\b([A-Za-z]\d[A-Za-z])\b/g;

console.log('file:', file);
console.log('sheets:', wb.SheetNames);

for (const name of wb.SheetNames) {
  const ws = wb.Sheets[name];
  const found = new Set();
  for (const key of Object.keys(ws)) {
    if (key[0] === '!') continue;
    const cell = ws[key];
    if (!cell || cell.v == null) continue;
    const text = String(cell.v);
    let m;
    while ((m = postalRe.exec(text))) {
      const fsa = (m[2] || m[1].slice(0, 3)).toUpperCase().replace(/\s+/g, '');
      found.add(fsa);
    }
  }
  const list = Array.from(found).sort();
  console.log(`\n== ${name} ==`);
  console.log('FSAs:', list.length);
  console.log(list.join(', '));
}

