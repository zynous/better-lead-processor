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

  return {
    valid: true,
    franchisorName,
    franchiseName: franchiseName ? String(franchiseName) : undefined,
  };
}

/**
 * Validate request body JSON
 * Attempts to parse the body as JSON
 */
export function validateRequestBody(body: string | null): {
  valid: true;
  data: Record<string, unknown>;
} | {
  valid: false;
  error: APIGatewayProxyResult;
} {
  try {
    const requestBody = body ? JSON.parse(body) : {};
    return { valid: true, data: requestBody };
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

/**
 * Validate and parse lead data
 * Validates against LeadDataSchema using Zod
 */
export function validateLeadData(data: unknown): {
  valid: true;
  data: LeadData;
} | {
  valid: false;
  error: APIGatewayProxyResult;
} {
  const result = LeadDataSchema.safeParse(data);

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

  return { valid: true, data: result.data };
}

