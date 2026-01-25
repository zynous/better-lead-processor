import { APIGatewayProxyResult } from 'aws-lambda';
import { LeadData } from '../types';
import { extractPostalCode, logger } from '../utils';
import { ERROR_MESSAGES } from '../error-messages';

/**
 * FSA (Forward Sortation Area) to Franchise Name Mapping
 * Maps the first 3 characters of Canadian postal codes to franchise names
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
  'L1M': 'whitby',
  'L1N': 'whitby',
  'L1P': 'whitby',
  'L1R': 'whitby',
  'L1G': 'oshawa',
  'L1H': 'oshawa',
  'L1J': 'oshawa',
  'L1K': 'oshawa',
  'L1L': 'oshawa',
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


