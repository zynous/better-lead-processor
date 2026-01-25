import { ChatOpenAI } from '@langchain/openai';
import { ChatPromptTemplate } from '@langchain/core/prompts';
import { BetterCRMLead, LeadData, BetterCRMLeadSchema, SystemConfig, FranchiseConfig } from '../types';
import { logger } from '../utils';
import { ERROR_MESSAGES } from '../error-messages';

/**
 * LLM-based data mapping service
 * Maps unstructured lead data to Better CRM format using OpenAI + LangChain
 */
export class LLMMapperService {
  private llm: ChatOpenAI;
  private franchiseConfig: FranchiseConfig;

  constructor(systemConfig: SystemConfig, franchiseConfig: FranchiseConfig) {
    this.franchiseConfig = franchiseConfig;

    this.llm = new ChatOpenAI({
      modelName: franchiseConfig.config.llm_settings.model || 'gpt-4',
      temperature: 0, // Use 0 temperature to minimize creativity/invention
      openAIApiKey: systemConfig.llm_api_key,
    });
  }

  /**
   * Map unstructured lead data to Better CRM format
   */
  async mapLeadData(inputData: LeadData): Promise<BetterCRMLead> {
    logger.info('Starting LLM mapping', {
      franchisorName: this.franchiseConfig.franchisor_name,
      franchiseName: this.franchiseConfig.franchise_name,
    });

    // Use structured output with Zod schema (modern LangChain approach)
    const structuredLlm = this.llm.withStructuredOutput(BetterCRMLeadSchema);

    // Build the prompt with Better CRM API structure and input data
    const betterCRMStructure = `{
  "profile": {
    "first_name": "string (optional)",
    "last_name": "string (optional)",
    "business_name": "string (optional)",
    "phone": [
      {
        "id": "string (optional, for edits)",
        "formatted": "string (required in array)",
        "type": "string (optional: mobile, home, work)",
        "country_code": "string (optional)",
        "extension": "string (optional)"
      }
    ],
    "email_address": "string (email, optional)",
    "identification": "string (optional)",
    "allow_calls": "string (optional)",
    "allow_marketing_email": "string (optional)",
    "role_description": "string (optional)",
    "is-enabled_email": "string (optional)",
    "is-enabled_sms": "string (optional)",
    "preferred_pronouns": "string (optional)"
  },
  "information": {
    "account_owner": "string or number (optional)",
    "ageRange": "string (optional)",
    "bio": "string (optional)",
    "date_of_birth": "string (optional)",
    "facebook": "string (optional)",
    "gender": "string (optional: male, female, unspecified, genderqueer, nonbinary)",
    "linkedin": "string (optional)",
    "mood": "string (optional)",
    "source_id": "string or number (optional)",
    "twitter": "string (optional)",
    "website": "string (optional)",
    "product_categories": ["array of IDs (optional)"],
    "intel": ["array of IDs (optional)"]
  },
  "address": {
    "deliveryAddress": "string (optional but recommended)",
    "deliveryAddress2": "string (optional)",
    "city": "string (optional but recommended)",
    "province": "string (optional but recommended)",
    "country": "string (optional but recommended)",
    "postalCode": "string (optional but recommended)",
    "description": "string (optional)",
    "primary_address": "string or boolean (optional)",
    "service_address": "string or boolean (optional)"
  },
  "note": "string (optional)",
  "interaction": {
    "activity_type": "string (optional: call or meeting)",
    "interaction_date": "string (optional, UTC datetime)",
    "end_date": "string (optional, UTC datetime)",
    "event_name": "string (optional)",
    "event_description": "string (optional)"
  }
}`;

    // Escape curly braces in the structure (LangChain uses {variable} syntax)
    const escapedStructure = betterCRMStructure.replace(/\{/g, '{{').replace(/\}/g, '}}');

    const prompt = ChatPromptTemplate.fromMessages([
      [
        'system',
        `You are a data mapping expert. Your task is to map unstructured lead data to the Better CRM API format.

CRITICAL RULES - YOU MUST FOLLOW THESE EXACTLY:
1. ONLY map fields that EXIST in the input data. DO NOT invent, guess, or create ANY data.
2. DO NOT add phone numbers if phone/phoneNumber/phone_number is not in the input.
3. DO NOT add address fields if address/city/province/postalCode are not in the input.
4. DO NOT add information fields (bio, facebook, linkedin, etc.) if they're not in the input.
5. DO NOT add interaction data if it's not in the input.
6. DO NOT include phone.id field for new leads (id is only for editing existing phones).
7. If a field is missing, omit the entire section (don't create empty objects or arrays).
8. DO NOT add default values unless explicitly in the input data.
9. DO NOT add business_name if it's not in the input.
10. DO NOT add any profile fields (allow_calls, role_description, etc.) if they're not in the input.
11. If input only has firstName, lastName, email - output should ONLY have profile.first_name, profile.last_name, profile.email_address.

REQUIREMENT: At least one of profile.first_name, profile.last_name, profile.business_name, or profile.email_address must be provided.

Better CRM API Structure:
${escapedStructure}

Mapping Rules:
1. Extract and map ONLY fields that exist in the input data - do not invent any data
2. For phone numbers: Only add if phone/phoneNumber/phone_number exists in input
   - Format: {{ formatted: "string", type: "mobile"|"home"|"work", country_code: "string" }}
   - DO NOT include "id" field (only for edits)
   - Extract country code if present (e.g., +1, +44)
   - Normalize phone format (remove spaces, dashes, parentheses)
3. For names: Split "name" field into first_name and last_name if separate fields not provided
4. For email: Map email, emailAddress, email_address to profile.email_address
5. For address: Only add address section if address fields exist in input
   - deliveryAddress: street address (line 1)
   - city: city name
   - province: state/province (map "state" to "province" if needed)
   - country: country name or code
   - postalCode: postal/zip code (normalize format)
6. If a field is not available in input, omit it entirely (don't use null, empty strings, or undefined)
7. Handle common field name variations (firstName/first_name, postalCode/postal_code, etc.)

Input Data to Map:
{{inputData}}

Output the mapped data in the exact Better CRM API format shown above. ONLY include fields that exist in the input. DO NOT invent any data.`,
      ],
      [
        'human',
        'Map this lead data to Better CRM format. Use ONLY the data provided - do not invent any fields:\n\n{{input}}',
      ],
    ]);

    try {
      // Use structured output - the model will return parsed and validated data
      const chain = prompt.pipe(structuredLlm);

      const validated = await chain.invoke({
        input: JSON.stringify(inputData, null, 2),
        inputData: JSON.stringify(inputData, null, 2),
      });

      logger.info('LLM mapping completed successfully', {
        franchisorName: this.franchiseConfig.franchisor_name,
        franchiseName: this.franchiseConfig.franchise_name,
        hasProfile: !!validated.profile,
        hasAddress: !!validated.address,
      });

      return validated;
    } catch (error) {
      logger.error('LLM mapping failed', {
        franchisorName: this.franchiseConfig.franchisor_name,
        franchiseName: this.franchiseConfig.franchise_name,
      }, error as Error);

      // Throw user-friendly error message (internal details logged above)
      throw new Error(ERROR_MESSAGES.LLM_MAPPING_FAILED);
    }
  }
}

