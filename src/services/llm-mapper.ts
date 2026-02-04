import { ChatOpenAI } from '@langchain/openai';
import { ChatPromptTemplate } from '@langchain/core/prompts';
import {
  BetterCRMLead,
  LeadData,
  BetterCRMLeadSchema,
  SystemConfig,
  FranchiseConfig,
} from '../types';
import { logger } from '../utils';
import { ERROR_MESSAGES } from '../error-messages';

/**
 * Hallucination-safe, CRM-aware LLM mapper
 *
 * Strategy:
 * - Whitelist Better CRM field paths (not full schema)
 * - Allow sparse output
 * - No schema forcing during generation
 * - Hard Zod validation after generation
 */
export class LLMMapperService {
  private llm: ChatOpenAI;
  private franchiseConfig: FranchiseConfig;

  constructor(systemConfig: SystemConfig, franchiseConfig: FranchiseConfig) {
    this.franchiseConfig = franchiseConfig;

    this.llm = new ChatOpenAI({
      modelName: 'gpt-4.1-mini',
      temperature: 0,
      openAIApiKey: systemConfig.llm_api_key,
    });
  }

  async mapLeadData(inputData: LeadData): Promise<BetterCRMLead> {
    logger.info('Starting LLM mapping', {
      franchisorName: this.franchiseConfig.franchisor_name,
      franchiseName: this.franchiseConfig.franchise_name,
    });

    /**
     * Allowed Better CRM fields (WHITELIST)
     * The model may ONLY use these paths.
     * 
     */
    // Build the prompt with Better CRM API structure and input data
    const betterCRMStructure = `{
      "profile": {
        "first_name": "string (optional) — Lead's first/given name",
        "last_name": "string (optional) — Lead's last/family name/surname",
        "business_name": "string (optional) — Company or business name",
        "phone": [
          {
            "id": "string (optional) — Phone record ID for edits only",
            "formatted": "string (required in array) — Full phone number as displayed",
            "type": "string (optional: mobile, home, work) — Phone type",
            "country_code": "string (optional) — Dialing code ",
            "extension": "string (optional) — Extension number"
          }
        ],
        "email_address": "string (optional) — Lead's email; must be valid email format",
        "identification": "string (optional) — ID number, license, or similar identifier",
        "allow_calls": "boolean (optional) — Consent or preference for phone contact",
        "allow_marketing_email": "boolean (optional) — Consent for marketing emails",
        "role_description": "string (optional) — Job title or role",
        "is-enabled_email": "boolean (optional) — Email contact enabled flag",
        "is-enabled_sms": "boolean (optional) — SMS contact enabled flag",
        "preferred_pronouns": "string (optional) — e.g. he/she/they/etc."
      },
      "information": {
        "account_owner": "string or number (optional) — Owner/user ID in CRM",
        "ageRange": "string (optional) — Age range or bracket",
        "bio": "string (optional) — Short biography or notes",
        "date_of_birth": "string (optional) — Date of birth",
        "facebook": "string (optional) — Facebook profile URL or handle",
        "gender": "string (optional: male, female, unspecified, genderqueer/nonbinary)",
        "linkedin": "string (optional) — LinkedIn profile URL",
        "mood": "string (optional) — Mood or disposition",
        "source_id": "string or number (optional) — Lead source identifier in CRM",
        "twitter": "string (optional) — Twitter/X URL",
        "website": "string (optional) — Website URL",
        "product_categories": "array of IDs (optional) — Product/category IDs",
        "intel": "array of IDs (optional) — Intel/segment IDs"
      },
      "address": {
        "deliveryAddress": "string (optional) — Street address line 1",
        "deliveryAddress2": "string (optional) — Street address line 2, suite, etc.",
        "city": "string (optional) — City",
        "province": "string (optional) — Province, state, or region",
        "country": "string (optional) — Country",
        "postalCode": "string (optional) — Postal/ZIP code",
        "description": "string (optional) — Address description or label",
        "primary_address": "boolean (optional) — Marks primary address",
        "service_address": "boolean (optional) — Marks service address"
      },
      "note": "string (optional) — Free-text note; put unmappable input fields here as key=value lines",
      "interaction": {
        "activity_type": "string (optional: call or meeting) — Type of interaction",
        "interaction_date": "string (optional) — Start date/time in UTC",
        "end_date": "string (optional) — End date/time in UTC",
        "event_name": "string (optional) — Name of event or meeting",
        "event_description": "string (optional) — Description of interaction"
      }
    }`;

    const prompt = ChatPromptTemplate.fromMessages([
      [
        'system',
        `You transform input lead data into the Better CRM Lead format. Map by meaning: match input fields to the correct output fields by what they represent, not by exact key names. Use the allowed fields below only.

REQUIRED-FIELDS CHECK FIRST: The input must contain at least one of: first name, last name, business/company name, or email (in any key or form). If none of these are present, output exactly: {{"_reject": true, "_reject_reason": "At least one of: first_name, last_name, business_name and email_address must be provided"}}.

MAPPING:
- Map input to output by semantics. Different input keys can map to the same output (e.g. address, street, address1 → address block; firstName, first_name, name → first_name). Use only values from the input; do not invent data.
- If an input value clearly contains multiple pieces of information (e.g. one string with street, city, province, postal), parse it into the right output fields. Use the exact substrings from the input.
- Only put in "note" input that has no corresponding lead API field (e.g. utm_campaign, referral, customSource, campaign_id). Anything that is clearly name, contact, or address must be mapped to profile/information/address, not to note.
- In "note", format unmappable fields as key=value, one per line.

ADDRESS: The CRM requires that if ANY address field is present, ALL of line 1 (deliveryAddress), city, state/province, country, and zip/postalCode must be present. When the input gives you all five (e.g. one string like "100 Main Street Barrie, ON, Canada" that you parse into street/city/province/country plus a separate postalCode, or separate address fields), you MUST include the "address" object and map them; do not put address data in "note". Only when the input has partial address (e.g. only postal code, or only street with no city/country/zip) do you omit "address" and put what you have in "note" instead.

OUTPUT: Valid JSON only. Include a top-level "profile" object (may be empty), unless rejecting for missing required fields. Use only the allowed Better CRM fields listed below.

Allowed Better CRM fields:
{betterCRMStructure}`,
      ],
      [
        'human',
        `Input lead data:
{inputData}

Return ONLY JSON. No explanations.`,
      ],
    ]);

    try {
      // Pass variables so LangChain substitutes them; do not embed JSON/structure in template (braces are treated as variables)
      const response = await this.llm.invoke(
        await prompt.formatMessages({
          inputData: JSON.stringify(inputData, null, 2),
          betterCRMStructure,
        })
      );

      if (typeof response.content !== 'string') {
        throw new Error('LLM did not return text output');
      }

      let parsed: unknown;

      try {
        parsed = JSON.parse(response.content);
      } catch {
        logger.error('Invalid JSON from LLM', {
          output: response.content,
        });
        throw new Error(ERROR_MESSAGES.LLM_MAPPING_FAILED);
      }

      // LLM rejected: required fields (first/last/business/email) missing in input
      if (
        parsed &&
        typeof parsed === 'object' &&
        (parsed as Record<string, unknown>)._reject === true
      ) {
        const reason =
          (parsed as Record<string, unknown>)._reject_reason ||
          ERROR_MESSAGES.REQUIRED_FIELDS_MISSING;
        throw new Error(
          `${ERROR_MESSAGES.LLM_REJECT_PREFIX}${typeof reason === 'string' ? reason : ERROR_MESSAGES.REQUIRED_FIELDS_MISSING}`
        );
      }

      // ✅ Final authority: schema validation
      const validated = BetterCRMLeadSchema.parse(parsed);

      logger.info('LLM mapping completed successfully', {
        franchisorName: this.franchiseConfig.franchisor_name,
        franchiseName: this.franchiseConfig.franchise_name,
        fieldsReturned: Object.keys(validated),
      });

      return validated;
    } catch (error) {
      // Rethrow required-fields rejection so handler can return 400
      if (
        error instanceof Error &&
        error.message.startsWith(ERROR_MESSAGES.LLM_REJECT_PREFIX)
      ) {
        throw error;
      }

      logger.error(
        'LLM mapping failed',
        {
          franchisorName: this.franchiseConfig.franchisor_name,
          franchiseName: this.franchiseConfig.franchise_name,
        },
        error as Error
      );

      throw new Error(ERROR_MESSAGES.LLM_MAPPING_FAILED);
    }
  }
}
