import fs from 'fs';
import path from 'path';
import { lookupFranchiseByPostalCode } from '../handlers/lookup-franchise-by-postal-code';
import { LeadData } from '../types';

// Covers the 2026-09-24 Lice Squad routing changes:
// - new franchise North Shore Burnaby (BPro 13029), carved out of vancouver
// - Scarborough (BPro 13019) merged into richmond-hill-markham
// - TO Central (BPro 12997) merged into toronto-east (BPro 12996)

const leadWith = (postalCode: string): LeadData =>
  ({ postalCode } as unknown as LeadData);

const lookup = async (postalCode: string) => {
  const result = await lookupFranchiseByPostalCode('lice-squad', leadWith(postalCode), 'test');
  if ('error' in result) {
    throw new Error(`lookup failed for ${postalCode}: ${result.error.body}`);
  }
  return result.franchiseName;
};

describe('lice-squad postal routing', () => {
  const northShoreBurnaby = [
    'V5A', 'V5B', 'V5C', 'V5E', 'V5G', 'V5H', 'V5J', 'V3N', 'V3H',
    'V7G', 'V7H', 'V7J', 'V7K', 'V7L', 'V7M', 'V7N', 'V7P',
    'V7R', 'V7S', 'V7T', 'V7V', 'V7W',
  ];
  const formerScarborough = [
    'M1B', 'M1C', 'M1E', 'M1G', 'M1H', 'M1J', 'M1K', 'M1L', 'M1M',
    'M1N', 'M1P', 'M1R', 'M1S', 'M1T', 'M1V', 'M1W', 'M1X',
  ];
  const formerTorontoCentral = [
    'M4M', 'M4W', 'M4X', 'M4Y', 'M5A', 'M5B', 'M5C', 'M5E',
    'M5G', 'M5H', 'M5J', 'M5K', 'M5L', 'M5N', 'M5P', 'M5R',
    'M5S', 'M5T', 'M5V', 'M5W', 'M5X', 'M6C',
  ];

  it.each(northShoreBurnaby)('routes North Shore Burnaby FSA %s', async (fsa) => {
    await expect(lookup(`${fsa} 1A1`)).resolves.toBe('north-shore-burnaby');
  });

  it.each(formerScarborough)('reassigns Scarborough FSA %s', async (fsa) => {
    await expect(lookup(`${fsa} 1A1`)).resolves.toBe('richmond-hill-markham');
  });

  it.each(formerTorontoCentral)('reassigns TO Central FSA %s', async (fsa) => {
    await expect(lookup(`${fsa} 1A1`)).resolves.toBe('toronto-east');
  });

  it.each([
    ['V5H 1A1', 'north-shore-burnaby'], // Burnaby
    ['V3N 4R5', 'north-shore-burnaby'], // Burnaby (east)
    ['V7M 1A5', 'north-shore-burnaby'], // North Vancouver
    ['V7W 2B3', 'north-shore-burnaby'], // West Vancouver
    ['V6B 1A1', 'vancouver'], // untouched Vancouver FSA
    ['V5K 1A1', 'vancouver'], // untouched Vancouver FSA next to the carve-out
    ['M1B 2C3', 'richmond-hill-markham'], // ex-Scarborough
    ['M1X 1A1', 'richmond-hill-markham'], // ex-Scarborough
    ['L4B 1A1', 'richmond-hill-markham'], // pre-existing Richmond Hill/Markham FSA
    ['M5V 3L9', 'toronto-east'], // ex-TO Central
    ['M6C 1A1', 'toronto-east'], // ex-TO Central
    ['M4K 1A1', 'toronto-east'], // pre-existing Toronto (ex-TO East) FSA
    ['L0M1P0', 'owensound-orillia'], // 6-char override still wins over the L0M FSA default
  ])('routes %s to %s', async (postalCode, expected) => {
    await expect(lookup(postalCode)).resolves.toBe(expected);
  });

  it('no longer routes anything to the deactivated franchises', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '..', 'handlers', 'lookup-franchise-by-postal-code.ts'),
      'utf8'
    );
    expect(source).not.toMatch(/: "scarborough"/);
    expect(source).not.toMatch(/: "toronto-central"/);
  });
});
