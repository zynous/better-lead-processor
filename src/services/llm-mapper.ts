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
     * TODO: check what are required field by system, I am sure first_name and last_name are required.
     */
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

    const prompt = ChatPromptTemplate.fromMessages([
      [
        'system',
        `You are a strict data extraction engine mapping input data into the Better CRM Lead format.

RULES (NON-NEGOTIABLE):
- Use ONLY values that appear verbatim in the input.
- Do NOT invent, infer, normalize, or improve data.
- Do NOT include a field unless its value exists in the input.
- You may ONLY use the allowed Better CRM fields listed below for profile, information, address, interaction.
- Any input field that does NOT map to one of those allowed Better CRM fields MUST be put in the "note" field.
- In "note", put unmappable fields as key=value, one per line. Format: key1 = value1 then newline key2 =v alue2 (e.g. customSource = web\nutm_campaign = summer).
- Missing data is acceptable. Invention is NOT.
- Output MUST be valid JSON.
- Output MUST include a top-level "profile" object (it may be empty).

Allowed Better CRM fields:
{betterCRMStructure}

Violating any rule makes the output INVALID.`,
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

      // ✅ Final authority: schema validation
      const validated = BetterCRMLeadSchema.parse(parsed);

      logger.info('LLM mapping completed successfully', {
        franchisorName: this.franchiseConfig.franchisor_name,
        franchiseName: this.franchiseConfig.franchise_name,
        fieldsReturned: Object.keys(validated),
      });

      return validated;
    } catch (error) {
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
