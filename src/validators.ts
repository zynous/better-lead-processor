import { APIGatewayProxyResult } from 'aws-lambda';
import { LeadDataSchema, LeadData } from './types';
import { ERROR_MESSAGES } from './error-messages';
import { logger } from './utils';

/**
 * Parse keys-to-avoid-for-data-extractions from a comma-separated string.
 * Handles both literal commas and URL-encoded commas (%2C).
 */
export function parseKeysToAvoidForDataExtraction(value: string | undefined): string[] {
  if (value == null || typeof value !== 'string' || value.trim() === '') {
    return [];
  }
  try {
    const decoded = decodeURIComponent(value);
    const keys = decoded
      .split(',')
      .map((k) => k.trim())
      .filter(Boolean);
    logger.info('parseKeysToAvoidForDataExtraction: parsed keys to avoid', { raw: value, keys });
    return keys;
  } catch {
    const keys = value.split(',').map((k) => k.trim()).filter(Boolean);
    logger.info('parseKeysToAvoidForDataExtraction: parsed keys (no decode)', { raw: value, keys });
    return keys;
  }
}

/**
 * Validate path parameters
 * Ensures franchisor-name is present in the URL path
 */
export function validatePathParameters(pathParameters: unknown): {
  valid: true;
  franchisorName: string;
  franchiseName?: string;
  keysToAvoidForDataExtraction?: string[];
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
  const inputLeadData = params['inputLeadData'] as Record<string, unknown> | undefined;
  const rawKeysToAvoid = inputLeadData?.['keys-to-avoid-for-data-extractions'];
  const keysToAvoidForDataExtraction =
    rawKeysToAvoid != null
      ? parseKeysToAvoidForDataExtraction(String(rawKeysToAvoid))
      : undefined;

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

  logger.info('Path parameters validated', {
    franchisorName: normalizedFranchisor,
    franchiseName: normalizedFranchise,
    keysToAvoidForDataExtraction: keysToAvoidForDataExtraction?.length ? keysToAvoidForDataExtraction : undefined,
  });

  return {
    valid: true,
    franchisorName: normalizedFranchisor,
    franchiseName: normalizedFranchise,
    keysToAvoidForDataExtraction: keysToAvoidForDataExtraction?.length ? keysToAvoidForDataExtraction : undefined,
  };
}

/**
 * Validate request body JSON and ensure it's a valid lead data object
 * Parses JSON and validates it's an object structure.
 * If keysToAvoidForDataExtraction is provided, those keys are omitted from the lead data (rest is used).
 */
export function validateRequestBody(body: string | null, keysToAvoidForDataExtraction?: string[]): {
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

    if (!result.success) {
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

    const data = result.data as Record<string, unknown>;
    let leadData: LeadData;

    if (keysToAvoidForDataExtraction?.length) {
      const filtered: Record<string, unknown> = {};
      const omitted: string[] = [];
      for (const key of Object.keys(data)) {
        if (!keysToAvoidForDataExtraction.includes(key)) {
          filtered[key] = data[key];
        } else {
          omitted.push(key);
        }
      }
      logger.info('Request body: filtered keys for lead data', {
        keysToAvoid: keysToAvoidForDataExtraction,
        omitted,
        remainingKeys: Object.keys(filtered),
      });
      const filteredResult = LeadDataSchema.safeParse(filtered);
      if (!filteredResult.success) {
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
      leadData = filteredResult.data;
    } else {
      leadData = data as LeadData;
    }

    logger.info('Request body validated as lead data', {
      keysFiltered: (keysToAvoidForDataExtraction?.length ?? 0) > 0,
      leadDataKeys: Object.keys(leadData),
    });
    return { valid: true, data: leadData };
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

