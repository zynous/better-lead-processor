import { APIGatewayProxyResult } from 'aws-lambda';
import { LeadData } from '../types';
import { extractPostalCode, logger } from '../utils';
import { ERROR_MESSAGES } from '../error-messages';

/**
 * FSA (Forward Sortation Area) to Franchise Name Mapping
 * Keyed by franchisor name so multiple franchisors can have their own mappings.
 * Each franchisor maps the first 3 characters of Canadian postal codes (FSA) to franchise names.
 * Includes L-prefix (standard) and digit-first aliases (1C0, 2L0, 1TO, etc.) for alternate input formats.
 */
const FSA_TO_FRANCHISE_MAPPING: Record<string, Record<string, string>> = {
  'lice-squad': {
    "L1S": "durham",
    "L1T": "durham",
    "L1Z": "durham",
    "L1V": "durham",
    "L1W": "durham",
    "L1X": "durham",
    "L1Y": "durham",
    "L1M": "durham",
    "L1N": "durham",
    "L1P": "durham",
    "L1R": "durham",
    "L1G": "durham",
    "L1H": "durham",
    "L1J": "durham",
    "L1K": "durham",
    "L1L": "durham",
    "L1B": "durham",
    "L1C": "durham",
    "L1E": "durham",
    "L1A": "durham",
    "L9L": "durham",
    "L9P": "durham",
    "L0A": "durham",
    "L0B": "durham",
    "L0C": "durham",
    "L0E": "barrie",
    "L0G": "barrie",
    "L0L": "barrie",
    "L0M": "barrie",
    "L0N": "barrie",
    "L3Z": "barrie",
    "L4M": "barrie",
    "L4N": "barrie",
    "L4P": "barrie",
    "L9J": "barrie",
    "L9N": "barrie",
    "L9R": "barrie",
    "L9S": "barrie",
    "1C0": "barrie",
    "1K0": "barrie",
    "1L0": "barrie",
    "1N0": "barrie",
    "1R0": "barrie",
    "1W0": "barrie",
    "2L0": "barrie",
    "2N0": "barrie",
    "1A0": "barrie",
    "1B0": "barrie",
    "1TO": "barrie",
    "1G0": "barrie",
    "1J0": "barrie",
    "1M0": "barrie",
    "1T0": "barrie",
  },
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
    logger.info('Mapping postal code to franchise', { requestId, franchisorName });

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
    const franchisorMapping = FSA_TO_FRANCHISE_MAPPING[franchisorName];

    if (!franchisorMapping) {
      logger.warn('Postal code mapping not configured for franchisor', { requestId, franchisorName });
      return {
        error: {
          statusCode: 404,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            success: false,
            error: ERROR_MESSAGES.POSTAL_CODE_MAPPING_NOT_SUPPORTED,
            error_type: 'NOT_FOUND',
            processed_at: new Date().toISOString(),
          }),
        },
      };
    }

    const franchiseName = franchisorMapping[fsa];

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


