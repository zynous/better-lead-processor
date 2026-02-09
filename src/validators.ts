import { APIGatewayProxyResult } from 'aws-lambda';
import { LeadDataSchema, LeadData } from './types';
import { ERROR_MESSAGES } from './error-messages';

/**
 * Validate path parameters
 * Ensures franchisor-name is present in the URL path
 */
export function validatePathParameters(pathParameters: unknown): {
  valid: true;
  franchisorName: string;
  franchiseName?: string;
  keyToExtractDataFrom?: string;
} | {
  valid: false;
  error: APIGatewayProxyResult;
} {
  if (!pathParameters || typeof pathParameters !== 'object') {
    return {
      valid: false,
      error: {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          success: false,
          error: ERROR_MESSAGES.MISSING_PATH_PARAMETERS,
          error_type: 'VALIDATION_ERROR',
          processed_at: new Date().toISOString(),
        }),
      },
    };
  }

  const params = pathParameters as Record<string, unknown>;
  const franchisorName = params['franchisor-name'];
  const keyToExtractDataFrom = (params as Record<string, any>)?.['inputLeadData']?.['key-for-data-extraction'] as string | undefined;

  if (!franchisorName || typeof franchisorName !== 'string') {
    return {
      valid: false,
      error: {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          success: false,
          error: ERROR_MESSAGES.MISSING_FRANCHISOR_NAME,
          error_type: 'VALIDATION_ERROR',
          processed_at: new Date().toISOString(),
        }),
      },
    };
  }

  const franchiseName = params['franchise-name'];

  // Normalize to lowercase for case-insensitive lookup
  const normalizedFranchisor = String(franchisorName).trim().toLowerCase();
  const normalizedFranchise = franchiseName ? String(franchiseName).trim().toLowerCase() : undefined;

  return {
    valid: true,
    franchisorName: normalizedFranchisor,
    franchiseName: normalizedFranchise,
    keyToExtractDataFrom: keyToExtractDataFrom,
  };
}

/**
 * Validate request body JSON and ensure it's a valid lead data object
 * Parses JSON and validates it's an object structure
 */
export function validateRequestBody(body: string | null, keyToExtractDataFrom?: string): {
  valid: true;
  data: LeadData;
} | {
  valid: false;
  error: APIGatewayProxyResult;
} {
  try {
    const requestBody = body ? JSON.parse(body) : {};

    // Validate it's an object (not array, null, or primitive)
    const result = LeadDataSchema.safeParse(requestBody);

    if (!result.success || (keyToExtractDataFrom && !result.data[keyToExtractDataFrom])) {
      return {
        valid: false,
        error: {
          statusCode: 400,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            success: false,
            error: ERROR_MESSAGES.INVALID_LEAD_DATA,
            error_type: 'VALIDATION_ERROR',
            processed_at: new Date().toISOString(),
          }),
        },
      };
    }

    return { valid: true, data: keyToExtractDataFrom ? result.data[keyToExtractDataFrom] : result.data };
  } catch (error) {
    return {
      valid: false,
      error: {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          success: false,
          error: ERROR_MESSAGES.INVALID_JSON,
          error_type: 'VALIDATION_ERROR',
          processed_at: new Date().toISOString(),
        }),
      },
    };
  }
}

