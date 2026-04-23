import { z } from 'zod';
import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';

// Accepts any JSON object structure - the LLM will intelligently map it
export const LeadDataSchema = z.any().refine(
  (val) => val !== null && typeof val === 'object' && !Array.isArray(val),
  { message: 'Request body must be a JSON object' }
);

// LeadData can be any object structure - LLM will map it
export type LeadData = Record<string, unknown>;

// Better CRM Lead Schema (output format). profile is optional for parsing resilience; caller must ensure it exists or fallback.
export const BetterCRMLeadSchema = z.object({
  profile: z.object({
    first_name: z.string().optional(),
    last_name: z.string().optional(),
    business_name: z.string().optional(),
    phone: z.array(z.object({
      id: z.string().optional(),
      formatted: z.string(),
      type: z.string().optional(),
      country_code: z.string().optional(),
      extension: z.string().optional(),
      primary: z.boolean().optional(),
      display: z.boolean().optional(),
      notification: z.boolean().optional(),
    })).optional(),
    email_address: z.string().email().optional(),
    identification: z.string().optional(),
    allow_calls: z.number().optional(),
    allow_marketing_email: z.number().optional(),
    role_description: z.string().optional(),
    is_enabled_email: z.number().optional(),
    is_enabled_sms: z.number().optional(),
    preferred_pronouns: z.string().optional(),
  }).optional(),
  information: z.object({
    account_owner: z.union([z.string(), z.number()]).optional(),
    ageRange: z.string().optional(),
    bio: z.string().optional(),
    date_of_birth: z.string().optional(),
    facebook: z.string().optional(),
    gender: z.enum(['male', 'female', 'unspecified', 'genderqueer', 'nonbinary']).optional(),
    linkedin: z.string().optional(),
    mood: z.string().optional(),
    source_id: z.union([z.string(), z.number()]).optional(),
    twitter: z.string().optional(),
    website: z.string().optional(),
    product_categories: z.array(z.union([z.string(), z.number()])).optional(),
    intel: z.array(z.union([z.string(), z.number()])).optional(),
  }).optional(),
  address: z.object({
    deliveryAddress: z.string().optional(),
    deliveryAddress2: z.string().optional(),
    city: z.string().optional(),
    province: z.string().optional(),
    country: z.string().optional(),
    postalCode: z.string().optional(),
    description: z.string().optional(),
    primary_address: z.union([z.string(), z.boolean()]).optional(),
    service_address: z.union([z.string(), z.boolean()]).optional(),
  }).optional(),
  note: z.string().optional(),
  interaction: z.object({
    activity_type: z.enum(['call', 'meeting']).optional(),
    interaction_date: z.string().optional(),
    end_date: z.string().optional(),
    event_name: z.string().optional(),
    event_description: z.string().optional(),
  }).optional(),
});

export type BetterCRMLead = z.infer<typeof BetterCRMLeadSchema>;

// Each array element must be a single valid email; invalid/empty entries are filtered out
const notificationEmailsSchema = z
  .array(z.string())
  .transform((arr) => {
    const emailSchema = z.string().email();
    return arr.filter((s) => {
      const trimmed = s.trim();
      return trimmed.length > 0 && emailSchema.safeParse(trimmed).success;
    });
  });

const notificationSettingsSchema = z.object({
  email_on_failure: z.boolean(),
  notification_emails: notificationEmailsSchema,
});

// Keys are dot-notation paths: "<section>.<field>" e.g. "profile.is_enabled_email"
const leadOverrideSchema = z.record(z.string(), z.unknown());

// Franchise Config Schema
export const FranchiseConfigSchema = z.object({
  franchisor_name: z.string(),
  api_key: z.string().optional(),
  active: z.boolean().default(true),
  config: z.object({
    notification_settings: notificationSettingsSchema.optional(),
    lead_overrides: leadOverrideSchema.optional(),
    llm_settings: z.object({
      model: z.string(),
      temperature: z.number().min(0).max(2).optional(),
    }),
  }),
  franchises: z.record(z.string(), z.object({
    credentials: z.object({
      client_id: z.string(),
      client_secret: z.string(),
    }),
    config: z.object({
      notification_settings: notificationSettingsSchema.optional(),
      lead_overrides: leadOverrideSchema.optional(),
      llm_settings: z.object({
        model: z.string(),
        temperature: z.number().min(0).max(2).optional(),
      }).optional(),
    }).optional(),
  })).optional(),
});

export type FranchiseConfig = z.infer<typeof FranchiseConfigSchema> & { franchise_name?: string };

// System Config Schema (LLM API key, Better CRM base URL, logging, SES, region)
export const SystemConfigSchema = z.object({
  llm_api_key: z.string(),
  llm_provider: z.string().optional(),
  better_crm_base_url: z.string(),
  aws_region: z.string().optional(),
  ses_from_email: z.string().optional(),
  logging: z.object({
    level: z.enum(['DEBUG', 'INFO', 'WARN', 'ERROR']).optional(),
    includeTimestamp: z.boolean().optional(),
  }).optional(),
});

export type SystemConfig = z.infer<typeof SystemConfigSchema>;

// API Response Schemas
export const SuccessResponseSchema = z.object({
  success: z.literal(true),
  lead_id: z.number(),
  franchisor_name: z.string(),
  franchise_name: z.string(),
  message: z.string(),
  processed_at: z.string(),
});

export const ErrorResponseSchema = z.object({
  success: z.literal(false),
  error: z.string(),
  error_type: z.string().optional(),
  error_message: z.string().optional(),
  processed_at: z.string(),
});

export type SuccessResponse = z.infer<typeof SuccessResponseSchema>;
export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;

/** Payload when Lambda is invoked asynchronously (Event); handler runs process-only, no API validation. */
export interface AsyncLeadPayload {
  _async: true;
  requestId: string;
  franchisorName: string;
  franchiseName: string;
  leadData: LeadData;
}

// Lambda Types
export interface LambdaEvent extends APIGatewayProxyEvent {
  pathParameters: {
    'franchisor-name': string;
    'franchise-name'?: string;
  } | null;
}

export interface LambdaContext {
  requestId: string;
  functionName: string;
  functionVersion: string;
  invokedFunctionArn: string;
  memoryLimitInMB: string;
  awsRequestId: string;
  logGroupName: string;
  logStreamName: string;
  getRemainingTimeInMillis: () => number;
}

export type LambdaHandler = (
  event: LambdaEvent,
  context: LambdaContext
) => Promise<APIGatewayProxyResult>;

