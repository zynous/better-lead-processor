/**
 * User-friendly error messages
 * These messages are safe to expose to API consumers and in email notifications
 */

export const ERROR_MESSAGES = {
  // Validation Errors (400)
  MISSING_PATH_PARAMETERS: 'Missing required path parameters',
  MISSING_FRANCHISOR_NAME: 'Missing franchisor-name in path',
  INVALID_JSON: 'Invalid JSON in request body',
  INVALID_LEAD_DATA: 'Invalid lead data format',
  POSTAL_CODE_REQUIRED: 'Postal code is required',
  POSTAL_CODE_TOO_SHORT: 'Postal code must be at least 3 characters',
  REQUIRED_FIELDS_MISSING:
    'At least one of: first_name, last_name, business_name and email_address must be provided',

  /** Prefix for errors thrown when LLM rejects (required fields missing). Used to return 400. */
  LLM_REJECT_PREFIX: '[REQUIRED_FIELDS]',

  // Authentication Errors (401, 403)
  INVALID_API_KEY: 'Invalid API key',
  FRANCHISE_NOT_ACTIVE: 'Franchise is not active',

  // Not Found Errors (404)
  POSTAL_CODE_NOT_FOUND: (postalCode: string, fsa: string) =>
    `Postal code ${postalCode} (FSA: ${fsa}) not found in franchise mapping`,
  POSTAL_CODE_MAPPING_NOT_SUPPORTED: 'Postal code mapping is not supported for this franchisor',

  // Configuration Errors (500)
  FRANCHISOR_CONFIG_NOT_FOUND: 'Franchisor configuration not found',
  POSTAL_CODE_MAPPING_NOT_CONFIGURED: 'Postal code mapping not configured',
  FAILED_TO_LOAD_POSTAL_CODE_MAPPING: 'Failed to load postal code mapping',
  CREDENTIALS_REQUIRED: (franchiseName: string) =>
    `Credentials are required for franchise: ${franchiseName}`,

  // Internal Server Errors (500)
  INTERNAL_SERVER_ERROR: 'An internal server error occurred. Please try again later.',
  LLM_MAPPING_FAILED: 'Failed to process lead data. Please try again later.',
  BETTER_CRM_ERROR: 'Failed to create lead in Better CRM. Please try again later.',

  // Email Notification Reasons
  EMAIL_REASON_POSTAL_CODE_NOT_FOUND: 'Postal code not found in franchise mapping',
  EMAIL_REASON_LLM_MAPPING_FAILED: 'Failed to process lead data',
  EMAIL_REASON_BETTER_CRM_ERROR: 'Failed to create lead in CRM',
  EMAIL_REASON_INTERNAL_ERROR: 'An unexpected error occurred during processing',
} as const;

/**
 * Get user-friendly error message for email notifications
 * Never exposes internal error details
 */
export function getUserFriendlyErrorReason(error: unknown): string {
  if (error instanceof Error) {
    const errorMessage = error.message.toLowerCase();

    // Map common error patterns to user-friendly messages
    if (errorMessage.includes('llm') || errorMessage.includes('mapping')) {
      return ERROR_MESSAGES.EMAIL_REASON_LLM_MAPPING_FAILED;
    }
    if (errorMessage.includes('crm') || errorMessage.includes('better')) {
      return ERROR_MESSAGES.EMAIL_REASON_BETTER_CRM_ERROR;
    }
    if (errorMessage.includes('postal') || errorMessage.includes('zip')) {
      return ERROR_MESSAGES.EMAIL_REASON_POSTAL_CODE_NOT_FOUND;
    }
  }

  // Default to generic message for any unknown error
  return ERROR_MESSAGES.EMAIL_REASON_INTERNAL_ERROR;
}

