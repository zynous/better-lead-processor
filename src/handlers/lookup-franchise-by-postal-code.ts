import { APIGatewayProxyResult } from 'aws-lambda';
import { LeadData } from '../types';
import { extractPostalCode, logger } from '../utils';
import { ERROR_MESSAGES } from '../error-messages';

/**
 * FSA (Forward Sortation Area) to Franchise Name Mapping
 * Maps the first 3 characters of Canadian postal codes to franchise names.
 * Includes L-prefix (standard) and digit-first aliases (1C0, 2L0, 1TO, etc.) for alternate input formats.
 */
const FSA_TO_FRANCHISE_MAPPING: Record<string, string> = {
  'L4M': 'barrie',
  'L4N': 'barrie',
  'L9J': 'barrie',
  'L3Z': 'bradford',
  'L9N': 'east gwillimbury',
  'L4P': 'keswick',
  'L9R': 'alliston',
  'L9S': 'innisfil',
  'L1S': 'ajax',
  'L1T': 'ajax',
  'L1Z': 'ajax',
  'L1B': 'bowmanville',
  'L1C': 'bowmanville',
  'L1E': 'bowmanville',
  'L1V': 'pickering',
  'L1W': 'pickering',
  'L1X': 'pickering',
  'L1Y': 'pickering',
  'L1A': 'port hope',
  'L9L': 'port perry',
  'L9P': 'uxbridge',
  'L9T': 'uxbridge',
  'L1M': 'whitby',
  'L1N': 'whitby',
  'L1P': 'whitby',
  'L1R': 'whitby',
  'L1G': 'oshawa',
  'L1H': 'oshawa',
  'L1J': 'oshawa',
  'L1K': 'oshawa',
  'L1L': 'oshawa',
  'L2L': 'barrie',
  'L2N': 'barrie',
  '1C0': 'bowmanville',
  '1K0': 'oshawa',
  '1L0': 'oshawa',
  '1N0': 'whitby',
  '1R0': 'whitby',
  '1W0': 'pickering',
  '1P0': 'whitby',
  '1A0': 'port hope',
  '1E0': 'bowmanville',
  '1S0': 'ajax',
  '1T0': 'ajax',
  '1B0': 'bowmanville',
  '1G0': 'oshawa',
  '1J0': 'oshawa',
  '1M0': 'whitby',
  '1TO': 'uxbridge',
  '2L0': 'barrie',
  '2N0': 'barrie',
};

/**
 * Postal code to franchise name mapping
 * Extracts FSA (first 3 chars) from postal code and maps to franchise
 */
export async function lookupFranchiseByPostalCode(
  franchisorName: string,
  leadData: LeadData,
  requestId: string
): Promise<{ franchiseName: string } | { error: APIGatewayProxyResult }> {
  try {
    logger.info('Endpoint 2: Mapping postal code to franchise', { requestId, franchisorName });

    // Extract postal code from request
    const postalCode = extractPostalCode(leadData);
    if (!postalCode) {
      logger.warn('Postal code not found in request', { requestId });
      return {
        error: {
          statusCode: 400,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            success: false,
            error: ERROR_MESSAGES.POSTAL_CODE_REQUIRED,
            error_type: 'VALIDATION_ERROR',
            processed_at: new Date().toISOString(),
          }),
        },
      };
    }

    // Extract FSA (first 3 characters) from postal code
    const normalizedCode = postalCode.toUpperCase().replace(/\s+/g, '');
    if (normalizedCode.length < 3) {
      logger.warn('Postal code too short to extract FSA', { requestId, postalCode });
      return {
        error: {
          statusCode: 400,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            success: false,
            error: ERROR_MESSAGES.POSTAL_CODE_TOO_SHORT,
            error_type: 'VALIDATION_ERROR',
            processed_at: new Date().toISOString(),
          }),
        },
      };
    }

    const fsa = normalizedCode.substring(0, 3);
    const franchiseName = FSA_TO_FRANCHISE_MAPPING[fsa];

    if (!franchiseName) {
      logger.warn('FSA not found in mapping', { requestId, postalCode, fsa, franchisorName });
      return {
        error: {
          statusCode: 404,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            success: false,
            error: ERROR_MESSAGES.POSTAL_CODE_NOT_FOUND(postalCode, fsa),
            error_type: 'NOT_FOUND',
            processed_at: new Date().toISOString(),
          }),
        },
      };
    }

    logger.info('Mapped postal code to franchise', {
      requestId,
      postalCode,
      fsa,
      franchiseName,
      franchisorName,
    });

    return { franchiseName };
  } catch (error) {
    logger.error('Unexpected error in postal code lookup', { requestId }, error as Error);
    return {
      error: {
        statusCode: 500,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          success: false,
          error: ERROR_MESSAGES.INTERNAL_SERVER_ERROR,
          error_type: 'INTERNAL_ERROR',
          processed_at: new Date().toISOString(),
        }),
      },
    };
  }
}


