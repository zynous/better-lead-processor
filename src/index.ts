import { APIGatewayProxyResult } from 'aws-lambda';
import { LambdaEvent, LambdaContext, SuccessResponse, ErrorResponse } from './types';
import { getFranchiseConfig, getFranchisorConfig, getSystemConfig } from './services/secrets-manager';
import { BetterCRMService } from './services/better-crm';
import { LLMMapperService } from './services/llm-mapper';
import { sendFailureNotification } from './services/email';
import { logger, LogConfig } from './utils';
import { lookupFranchiseByPostalCode } from './handlers';
import { validatePathParameters, validateRequestBody } from './validators';
import { ERROR_MESSAGES } from './error-messages';

/**
 * Extract API key from request (header or query parameter)
 */
function extractApiKey(event: LambdaEvent): string | null {
  // Check header first
  const headerKey = event.headers['x-api-key'] || event.headers['X-API-Key'];
  if (headerKey) {
    return headerKey;
  }

  // Check query parameter
  if (event.queryStringParameters?.api_key) {
    return event.queryStringParameters.api_key;
  }

  return null;
}

/**
 * Validate API key against franchise config
 */
function validateApiKey(apiKey: string | null, expectedApiKey: string | undefined): boolean {
  if (!apiKey || !expectedApiKey) {
    return false;
  }
  return apiKey === expectedApiKey;
}

/**
 * Create success response
 */
function createSuccessResponse(leadId: number, franchisorName: string, franchiseName: string): APIGatewayProxyResult {
  const response: SuccessResponse = {
    success: true,
    lead_id: leadId,
    franchisor_name: franchisorName,
    franchise_name: franchiseName,
    message: 'Lead processed successfully',
    processed_at: new Date().toISOString(),
  };

  return {
    statusCode: 202,
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(response),
  };
}

/**
 * Create error response
 */
function createErrorResponse(
  statusCode: number,
  error: string,
  errorType?: string,
  errorMessage?: string
): APIGatewayProxyResult {
  const response: ErrorResponse = {
    success: false,
    error,
    error_type: errorType,
    error_message: errorMessage,
    processed_at: new Date().toISOString(),
  };

  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(response),
  };
}

/**
 * Main Lambda handler
 */
export async function handler(
  event: LambdaEvent,
  context: LambdaContext
): Promise<APIGatewayProxyResult> {
  const requestId = context.awsRequestId;

  try {
    // Load system config to initialize logging
    const systemConfig = await getSystemConfig();
    if (systemConfig.logging) {
      logger.configure(systemConfig.logging as LogConfig);
    }

    logger.info('Request received', { requestId });
    // Validate path parameters
    const pathValidation = validatePathParameters(event.pathParameters);
    if (!pathValidation.valid) {
      return pathValidation.error;
    }

    const franchisorName = pathValidation.franchisorName;
    let franchiseName = pathValidation.franchiseName;

    // Validate and parse request body
    const bodyValidation = validateRequestBody(event.body);
    if (!bodyValidation.valid) {
      return bodyValidation.error;
    }

    const leadData = bodyValidation.data;

    logger.info('Input request lead data received', {
      requestId,
      franchisorName,
      franchiseName: franchiseName ?? '(postal-code lookup pending)',
      inputLeadData: leadData,
    });

    // Handle endpoint 2: postal code to franchise mapping
    if (!franchiseName) {
      const result = await lookupFranchiseByPostalCode(franchisorName, leadData, requestId);

      if ('error' in result) {
        // Try to send failure notification for postal code lookup failure
        try {
          const franchisorConfig = await getFranchisorConfig(franchisorName);
          if (franchisorConfig.config.notification_settings.email_on_failure) {
            await sendFailureNotification(
              franchisorConfig.config.notification_settings.notification_emails,
              franchisorName,
              'unknown',
              ERROR_MESSAGES.EMAIL_REASON_POSTAL_CODE_NOT_FOUND,
              leadData
            );
          }
        } catch (emailError) {
          logger.warn('Failed to send postal code failure notification', { requestId }, emailError as Error);
        }
        return result.error;
      }

      franchiseName = result.franchiseName;
    }

    // Load franchise configuration
    logger.info('Loading franchise configuration', { requestId, franchisorName, franchiseName });
    const franchiseConfig = await getFranchiseConfig(franchisorName, franchiseName);

    // Validate API key
    const apiKey = extractApiKey(event);
    if (!validateApiKey(apiKey, franchiseConfig.api_key)) {
      logger.warn('Invalid API key', { requestId, franchisorName, franchiseName });
      return createErrorResponse(401, ERROR_MESSAGES.INVALID_API_KEY, 'AUTH_ERROR');
    }

    // Check if franchise is active
    if (!franchiseConfig.active) {
      logger.warn('Franchise is not active', { requestId, franchisorName, franchiseName });
      return createErrorResponse(403, ERROR_MESSAGES.FRANCHISE_NOT_ACTIVE, 'AUTH_ERROR');
    }

    // Get LLM API key from system config
    const llmConfig = await getSystemConfig();

    // Map lead data using LLM
    logger.info('Mapping lead data with LLM', { requestId, franchisorName, franchiseName });
    const llmMapper = new LLMMapperService(llmConfig, franchiseConfig);
    const betterCRMLead = await llmMapper.mapLeadData(leadData);

    // Create lead in Better CRM
    logger.info('Creating lead in Better CRM', { requestId, franchisorName, franchiseName });
    const betterCRMService = new BetterCRMService(franchiseConfig);
    const leadId = await betterCRMService.createLead(betterCRMLead);

    logger.info('Lead processed successfully', {
      requestId,
      franchisorName,
      franchiseName,
      leadId,
    });

    return createSuccessResponse(leadId, franchisorName, franchiseName);
  } catch (error) {
    logger.error('Error processing lead', { requestId }, error as Error);

    // LLM rejected: required fields (first/last/business/email) missing — return 400, no notification
    if (
      error instanceof Error &&
      error.message.startsWith(ERROR_MESSAGES.LLM_REJECT_PREFIX)
    ) {
      const message = error.message.slice(ERROR_MESSAGES.LLM_REJECT_PREFIX.length);
      return createErrorResponse(400, message, 'VALIDATION_ERROR');
    }

    // Try to send failure notification if we have config loaded
    try {
      const pathParams = event.pathParameters;
      if (pathParams?.['franchisor-name'] && pathParams?.['franchise-name']) {
        const franchiseConfig = await getFranchiseConfig(
          pathParams['franchisor-name'],
          pathParams['franchise-name']
        );

        if (franchiseConfig.config.notification_settings.email_on_failure) {
          // Use actual error message for email so recipients see the real failure reason
          const errorReason =
            error instanceof Error ? error.message : String(error);

          // Get request body from event
          let requestBody: unknown = null;
          try {
            if (event.body) {
              requestBody = JSON.parse(event.body);
            }
          } catch {
            // If parsing fails, use raw body
            requestBody = event.body;
          }

          await sendFailureNotification(
            franchiseConfig.config.notification_settings.notification_emails,
            franchiseConfig.franchisor_name,
            franchiseConfig.franchise_name,
            errorReason,
            requestBody
          );
        }
      }
    } catch (notificationError) {
      logger.error('Failed to send notification', { requestId }, notificationError as Error);
    }

    // Never expose internal error details to API consumers
    return createErrorResponse(
      500,
      ERROR_MESSAGES.INTERNAL_SERVER_ERROR,
      'INTERNAL_ERROR'
    );
  }
}

