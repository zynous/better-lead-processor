import { APIGatewayProxyResult } from 'aws-lambda';
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import {
  LambdaEvent,
  LambdaContext,
  SuccessResponse,
  ErrorResponse,
  AsyncLeadPayload,
  BetterCRMLeadSchema,
} from './types';
import { getFranchiseConfig, getFranchisorConfig, getSystemConfig } from './services/secrets-manager';
import { BetterCRMService } from './services/better-crm';
import { LLMMapperService } from './services/llm-mapper';
import { postProcessLead } from './services/lead-post-processor';
import { sendFailureNotification } from './services/email';
import { logger, LogConfig } from './utils';
import { lookupFranchiseByPostalCode } from './handlers';
import { validatePathParameters, validateRequestBody } from './validators';
import { ERROR_MESSAGES } from './error-messages';

function isAsyncPayload(event: LambdaEvent | AsyncLeadPayload): event is AsyncLeadPayload {
  const e = event as unknown as { _async?: unknown; requestId?: unknown; franchisorName?: unknown; franchiseName?: unknown; leadData?: unknown };
  return (
    e != null &&
    typeof e === 'object' &&
    e._async === true &&
    e.requestId != null &&
    e.franchisorName != null &&
    e.franchiseName != null &&
    e.leadData != null
  );
}

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
 * Create success response with lead_id (used in sync mode, e.g. local testing).
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
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(response),
  };
}

/**
 * Create 202 Accepted response when lead is queued for async processing (no lead_id yet).
 */
function createAcceptedResponse(requestId: string): APIGatewayProxyResult {
  return {
    statusCode: 202,
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      success: true,
      message: 'Lead accepted for processing',
      request_id: requestId,
      processed_at: new Date().toISOString(),
    }),
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
 * Run LLM → post-process → CRM (used by async invocation). Sends failure notification on error.
 */
async function processLeadAsync(payload: AsyncLeadPayload, _context: LambdaContext): Promise<void> {
  const { requestId, franchisorName, franchiseName, leadData } = payload;

  try {
    const systemConfig = await getSystemConfig();
    if (systemConfig.logging) {
      logger.configure(systemConfig.logging as LogConfig);
    }
    logger.info('Async processing started', { requestId, franchisorName, franchiseName });

    const franchiseConfig = await getFranchiseConfig(franchisorName, franchiseName);
    const llmMapper = new LLMMapperService(systemConfig, franchiseConfig);
    const mappedLead = await llmMapper.mapLeadData(leadData);
    const normalizedLead = postProcessLead(mappedLead);
    const betterCRMLead = BetterCRMLeadSchema.parse(normalizedLead);
    const betterCRMService = new BetterCRMService(franchiseConfig);
    const leadId = await betterCRMService.createLead(betterCRMLead);

    logger.info('Lead processed successfully (async)', {
      requestId,
      franchisorName,
      franchiseName,
      leadId,
    });
  } catch (error) {
    logger.error('Error processing lead (async)', { requestId }, error as Error);

    if (
      error instanceof Error &&
      error.message.startsWith(ERROR_MESSAGES.LLM_REJECT_PREFIX)
    ) {
      return;
    }

    try {
      const franchiseConfig = await getFranchiseConfig(franchisorName, franchiseName);
      if (franchiseConfig.config.notification_settings.email_on_failure) {
        const errorReason = error instanceof Error ? error.message : String(error);
        await sendFailureNotification(
          franchiseConfig.config.notification_settings.notification_emails,
          franchisorName,
          franchiseName,
          errorReason,
          leadData
        );
      }
    } catch (notificationError) {
      logger.error('Failed to send notification', { requestId }, notificationError as Error);
    }
  }
}

/**
 * Main Lambda handler. Accepts API requests (validate → invoke async → 202) or async payload (process only).
 */
export async function handler(
  event: LambdaEvent | AsyncLeadPayload,
  context: LambdaContext
): Promise<APIGatewayProxyResult> {
  const requestId = context.awsRequestId;

  try {
    const systemConfig = await getSystemConfig();
    if (systemConfig.logging) {
      logger.configure(systemConfig.logging as LogConfig);
    }

    if (isAsyncPayload(event)) {
      await processLeadAsync(event, context);
      return { statusCode: 200, headers: {}, body: '' };
    }

    const apiEvent = event as LambdaEvent;
    logger.info('Request received', { requestId });
    const pathValidation = validatePathParameters(apiEvent.pathParameters);
    if (!pathValidation.valid) {
      return pathValidation.error;
    }

    const franchisorName = pathValidation.franchisorName;
    let franchiseName = pathValidation.franchiseName;
    const keyToExtractDataFrom =
      pathValidation.keyToExtractDataFrom ??
      apiEvent.queryStringParameters?.['key-for-data-extraction'];

    // Validate and parse request body
    const bodyValidation = validateRequestBody(event.body, keyToExtractDataFrom);
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

    logger.info('Loading franchise configuration', { requestId, franchisorName, franchiseName });
    const franchiseConfig = await getFranchiseConfig(franchisorName, franchiseName);

    const apiKey = extractApiKey(apiEvent);
    if (!validateApiKey(apiKey, franchiseConfig.api_key)) {
      logger.warn('Invalid API key', { requestId, franchisorName, franchiseName });
      return createErrorResponse(401, ERROR_MESSAGES.INVALID_API_KEY, 'AUTH_ERROR');
    }

    if (!franchiseConfig.active) {
      logger.warn('Franchise is not active', { requestId, franchisorName, franchiseName });
      return createErrorResponse(403, ERROR_MESSAGES.FRANCHISE_NOT_ACTIVE, 'AUTH_ERROR');
    }

    const functionName = process.env.AWS_LAMBDA_FUNCTION_NAME;
    const syncMode = !functionName || process.env.LEAD_PROCESSOR_ASYNC === '0';

    if (syncMode) {
      const llmConfig = await getSystemConfig();
      const llmMapper = new LLMMapperService(llmConfig, franchiseConfig);
      const mappedLead = await llmMapper.mapLeadData(leadData);
      const normalizedLead = postProcessLead(mappedLead);
      const betterCRMLead = BetterCRMLeadSchema.parse(normalizedLead);
      const betterCRMService = new BetterCRMService(franchiseConfig);
      const leadId = await betterCRMService.createLead(betterCRMLead);
      logger.info('Lead processed successfully (sync)', { requestId, franchisorName, franchiseName, leadId });
      return createSuccessResponse(leadId, franchisorName, franchiseName);
    }

    const asyncPayload: AsyncLeadPayload = {
      _async: true,
      requestId,
      franchisorName,
      franchiseName,
      leadData,
    };
    const lambda = new LambdaClient({});
    await lambda.send(
      new InvokeCommand({
        FunctionName: functionName,
        InvocationType: 'Event',
        Payload: JSON.stringify(asyncPayload),
      })
    );

    logger.info('Lead accepted for async processing', { requestId, franchisorName, franchiseName });
    return createAcceptedResponse(requestId);
  } catch (error) {
    logger.error('Error processing lead', { requestId }, error as Error);

    if (
      error instanceof Error &&
      error.message.startsWith(ERROR_MESSAGES.LLM_REJECT_PREFIX)
    ) {
      const message = error.message.slice(ERROR_MESSAGES.LLM_REJECT_PREFIX.length);
      return createErrorResponse(400, message, 'VALIDATION_ERROR');
    }

    try {
      const apiEvent = event as LambdaEvent;
      const pathParams = apiEvent.pathParameters;
      if (pathParams?.['franchisor-name'] && pathParams?.['franchise-name']) {
        const franchiseConfig = await getFranchiseConfig(
          pathParams['franchisor-name'],
          pathParams['franchise-name']
        );

        if (franchiseConfig.config.notification_settings.email_on_failure) {
          const errorReason = error instanceof Error ? error.message : String(error);
          let requestBody: unknown = null;
          try {
            if (apiEvent.body) {
              requestBody = JSON.parse(apiEvent.body);
            }
          } catch {
            requestBody = apiEvent.body;
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

    return createErrorResponse(
      500,
      ERROR_MESSAGES.INTERNAL_SERVER_ERROR,
      'INTERNAL_ERROR'
    );
  }
}

