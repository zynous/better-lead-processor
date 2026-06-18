import { z } from 'zod';
import { ChatOpenAI } from '@langchain/openai';
import { ChatPromptTemplate } from '@langchain/core/prompts';
import { BetterCRMLead, BetterCRMLeadSchema, LeadData, SystemConfig, FranchiseConfig } from '../types';
import { logger } from '../utils';
import { ERROR_MESSAGES } from '../error-messages';

/** Relaxed info/address/interaction so LLM can omit or use empty string; post-processor strips invalid enum values. */
const relaxedInformation = z
  .object({
    account_owner: z.union([z.string(), z.number()]).optional(),
    ageRange: z.string().optional(),
    bio: z.string().optional(),
    date_of_birth: z.string().optional(),
    facebook: z.string().optional(),
    gender: z.string().optional(),
    linkedin: z.string().optional(),
    mood: z.string().optional(),
    source_id: z.union([z.string(), z.number()]).optional(),
    twitter: z.string().optional(),
    website: z.string().optional(),
    product_categories: z.array(z.union([z.string(), z.number()])).optional(),
    intel: z.array(z.union([z.string(), z.number()])).optional(),
  })
  .optional();
const relaxedAddress = BetterCRMLeadSchema.shape.address.optional();
const relaxedInteraction = z
  .object({
    activity_type: z.string().optional(),
    interaction_date: z.string().optional(),
    end_date: z.string().optional(),
    event_name: z.string().optional(),
    event_description: z.string().optional(),
  })
  .optional();

/** LLM output schema: sparse allowed; email and enums are relaxed (post-process / normalize fix). */
const LLMMapperOutputSchema = z.object({
  profile: z
    .object({
      first_name: z.string().optional(),
      last_name: z.string().optional(),
      business_name: z.string().optional(),
      phone: z
        .array(
          z.object({
            id: z.string().optional(),
            formatted: z.string(),
            type: z.string().optional(),
            country_code: z.string().optional(),
            extension: z.string().optional(),
          })
        )
        .optional(),
      email_address: z.string().optional(),
      identification: z.string().optional(),
      role_description: z.string().optional(),
      preferred_pronouns: z.string().optional(),
    })
    .optional(),
  information: relaxedInformation,
  address: relaxedAddress,
  note: z.string().optional(),
  interaction: relaxedInteraction,
  reasoning: z.string(),
});
type LLMMapperOutput = z.infer<typeof LLMMapperOutputSchema>;

/**
 * Recursively remove null and undefined from an object so the LLM never sees them.
 * - null/undefined → undefined (omitted from objects, filtered from arrays).
 * - Plain objects: recurse and omit keys whose stripped value is undefined.
 * - Non-plain objects (Date, RegExp, etc.): returned as-is.
 * - Circular references: return {} or [] to avoid stack overflow.
 */
function stripNullFromInput(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || value === undefined) {
    return undefined;
  }

  if (Array.isArray(value)) {
    if (seen.has(value)) return [];
    seen.add(value);
    return value
      .map((item) => stripNullFromInput(item, seen))
      .filter((item) => item !== undefined);
  }

  if (typeof value === 'object' && value !== null) {
    if (value.constructor !== Object) {
      return value;
    }
    if (seen.has(value)) return {};
    seen.add(value);
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      const stripped = stripNullFromInput(v, seen);
      if (stripped !== undefined) {
        out[k] = stripped;
      }
    }
    return out;
  }

  return value;
}

/**
 * Hallucination-safe, CRM-aware LLM mapper
 *
 * Strategy:
 * - Whitelist Better CRM field paths (not full schema)
 * - Allow sparse output; no strict schema here so post-processor can fix invalid email, bad phone, etc.
 * - Strict validation is applied after post-processing in index.ts before CRM.
 */
export class LLMMapperService {
  private llm: ChatOpenAI;
  private franchiseConfig: FranchiseConfig;

  constructor(systemConfig: SystemConfig, franchiseConfig: FranchiseConfig) {
    this.franchiseConfig = franchiseConfig;

    const apiKey = systemConfig.llm_api_key;
    this.llm = new ChatOpenAI({
      modelName: franchiseConfig.config.llm_settings.model,
      apiKey,
    });
  }

  async mapLeadData(inputData: LeadData): Promise<BetterCRMLead> {
    logger.info('Starting LLM mapping', {
      franchisorName: this.franchiseConfig.franchisor_name,
      franchiseName: this.franchiseConfig.franchise_name,
      model: this.franchiseConfig.config.llm_settings.model,
      inputKeys: Object.keys(inputData),
    });

    // Strip null/undefined recursively so the LLM never sees them and parsing stays simple
    const cleanedInput = stripNullFromInput(inputData) as LeadData;
    logger.info('Input cleaned for LLM (null/undefined stripped)', {
      franchisorName: this.franchiseConfig.franchisor_name,
      franchiseName: this.franchiseConfig.franchise_name,
      cleanedKeys: Object.keys(cleanedInput as Record<string, unknown>),
    });

    // Franchisor/franchise-specific rules (combined, from config) injected into the prompt.
    const rawInstructions = this.franchiseConfig.config.mapping_instructions;
    const instructionsText = Array.isArray(rawInstructions)
      ? rawInstructions.map((s) => s.trim()).filter(Boolean).join('\n')
      : (rawInstructions ?? '').trim();
    const customMappingInstructions = instructionsText
      ? `\nFRANCHISOR-SPECIFIC MAPPING RULES:
These tenant-specific rules may clarify, extend, or override the default use of any allowed Better CRM field.
${instructionsText}\n`
      : '';

    /**
     * Allowed Better CRM fields (WHITELIST)
     * The model may ONLY use these paths.
     * 
     */
    // Build the prompt with Better CRM API structure and input data
    const betterCRMStructure = `{
      "profile": {
        "first_name": "string — Lead's first/given name",
        "last_name": "string — Lead's last/family name/surname",
        "business_name": "string — Company or business name",
        "phone": [
          {
            "formatted": "string - The actual phone number. Does not include country code or extension in the formatted string.",
            "type": "string - The type of phone number (cell, work, fax, home, phone, other)",
            "country_code": "string - The country code of the phone number (+1 , +0, +44, +64 etc)",
            "extension": "string - The extension of the phone number"
          }
        ],
        "email_address": "string - The email address of the lead. Use it as is without any validation or correction.",
        "role_description": "string - The role description of the lead",
        "preferred_pronouns": "string - The preferred pronouns of the lead"
      },
      "information": {
        "account_owner": "string or number - Owner/user ID in CRM",
        "ageRange": "string - Age range or bracket (options: 0-5, 6-15, 16-30, 31-45, 46-60, 61-75, 76+)",
        "bio": "string - Biographical or profile-surface details about the lead (e.g. job title, background).",
        "date_of_birth": "string - Date of birth",
        "facebook": "string - Facebook profile URL or handle",
        "gender": "string - Gender (male, female, unspecified, genderqueer/nonbinary)",
        "linkedin": "string - LinkedIn profile URL",
        "mood": "string - Mood or disposition",
        "source_id": "string or number - Lead source identifier in CRM",
        "twitter": "string - Twitter/X URL",
        "website": "string - Website URL",
        "product_categories": "array of integers - Product/category IDs",
        "intel": "array of integers - Intel/segment IDs"
      },
      "address": {
        "deliveryAddress": "string - Street address line 1",
        "deliveryAddress2": "string - Street address line 2, suite, etc.",
        "city": "string - City",
        "province": "string - Two-character province, state, or region code (e.g. ON, BC, VA, NC)",
        "country": "string - Two-character country code (e.g. CA, US)",
        "postalCode": "string - Postal/ZIP code",
        "description": "string - Address/location/delivery description (e.g. 'right in front', 'back door', 'please call before arrival'). Use for any description that refers to where or how to find the address.",
        "primary_address": "boolean - Marks primary address",
        "service_address": "boolean - Marks service address"
      },
      "note": "string - Free-text note; put unmappable input fields here as key = value lines",
      "interaction": {
        "activity_type": "string - Type of interaction (options: Call, Email, Meeting, Task)",
        "interaction_date": "string - Start date/time in UTC",
        "end_date": "string - End date/time in UTC",
        "event_name": "string - Name of event or meeting",
        "event_description": "string - Description of interaction"
      }
    }`;

    const prompt = ChatPromptTemplate.fromMessages([
      [
        'system',
        `You transform input lead data into the Better CRM Lead format. Map by meaning: match input fields to the correct output fields by what they represent, not by exact key names. Use only the allowed fields below.
{customMappingInstructions}
RULE PRECEDENCE:
1. Franchisor-specific and franchise-specific mapping rules, when present. These may clarify, extend, or override the default use of any allowed Better CRM field.
2. General mapping guidance in this prompt.
3. The allowed Better CRM field descriptions listed below.

For each input field, analyze whether its value fits the best-matching output field. Assign a confidence level for that mapping: high (value clearly belongs there), medium (plausible but ambiguous), or low (weak or doubtful fit).

CONFIDENCE:
- High: map the value to the output field only.
- Medium: map the value to the output field and also append it to "note" so it is preserved for review.
- Low: do not map to the output field; put the value in "note" only.

You must evaluate confidence per input field by considering whether the value actually fits the target field, not just whether the key name matches. 

CRITICAL:
- Do not invent data. Only map fields that are explicitly provided in the input.
- Exception for address geography: if city, province/state, country, or postal/ZIP code context makes the geography high-confidence, you may infer missing address.province or address.country.
- Do not account for dependencies between fields while assigning confidence.

MAPPING:
- Map input to output by semantics. Match by what each field and value represent.
- If an input value contains multiple pieces of information that fit separate output fields, split it and map each part to the appropriate field. Use exact substrings from the input. Apply confidence per part if needed.
- Put in "note" anything unmappable, low-confidence, or medium-confidence (for medium, also map to the output field).
- When an input value's type does not match the output field's allowed type, treat as low confidence and put that value in note only.

ADDRESS GEOGRAPHY:
- Normalize address.province to an uppercase two-character province/state code. Examples: "Ontario" -> "ON", "on" -> "ON", "Va" -> "VA", "Virginia" -> "VA".
- Normalize address.country to an uppercase two-character country code. Examples: "Canada" -> "CA", "United States" -> "US", "USA" -> "US".
- If country is missing or null but the city plus province/state or postal/ZIP code clearly identifies the country, infer address.country. Examples: "Ashburn, VA 20147" -> "US"; "Toronto, ON M4E 3P9" -> "CA".
- If province/state is missing but the city plus country or postal/ZIP code clearly identifies the province/state, infer address.province.
- Only infer geography when confidence is high. If a city name is ambiguous and no province/state, country, or postal/ZIP context resolves it, do not infer missing geography.

NOTE FORMAT (required): The "note" field must list **ONLY** every low/medium-confidence and unmapped input field WITH ITS VALUE, one per line, in the form: FieldName = value. Use the actual input key (e.g. dotted path like LetsStart.PhoneNumber or simple key). Examples:
  PhoneNumber = 555-1234
  LetsStart.Address.CityStatePostalCode = Austin, TX 78701
  LetsStart.Address.StreetAddress = 123 Main St
Do not put only a description or reasoning in the note—always include the field name and its value so the data is preserved for review.

OUTPUT (SPARSE): Return ONLY the fields you mapped plus "reasoning". Do NOT include the full structure.
- Include "profile" only with the subfields you actually mapped (omit profile entirely if you mapped nothing there, or omit any profile key you did not map).
- Include "information", "address", or "interaction" ONLY if you mapped at least one value there; omit the whole object if you mapped nothing. Do not include any key with an empty string or empty array.
- Include "note" only if it has content (unmappable or low/medium-confidence items, each as "FieldName = value"). Omit "note" if empty.
- Never include a field whose value would be empty string, empty object, or empty array. Omit it instead.
Use only the allowed Better CRM fields below.

REASONING (required): In the "reasoning" string, list every input field with its confidence and outcome. For each input key write one line: input_key -> output_path or "note", then (high|medium|low): brief reason. Example lines: "firstName -> profile.first_name (high): clear name match." "description -> note (low): value describes request, not address." Cover all input keys so we can see per-field confidence.

Allowed Better CRM fields:
{betterCRMStructure}`,
      ],
      [
        'human',
        `Input lead data:
{inputData}

Return ONLY JSON. No other text.`,
      ],
    ]);

    try {
      const structuredLlm = this.llm.withStructuredOutput(LLMMapperOutputSchema, {
        method: 'jsonMode',
        name: 'lead_mapping',
      });

      const messages = await prompt.formatMessages({
        inputData: JSON.stringify(cleanedInput, null, 2),
        betterCRMStructure,
        customMappingInstructions,
      });

      logger.info('Invoking LLM for lead mapping', {
        franchisorName: this.franchiseConfig.franchisor_name,
        franchiseName: this.franchiseConfig.franchise_name,
      });
      const parsed: LLMMapperOutput = await structuredLlm.invoke(messages);

      logger.info('LLM reasoning', {
        franchisorName: this.franchiseConfig.franchisor_name,
        franchiseName: this.franchiseConfig.franchise_name,
        reasoning: parsed.reasoning,
      });

      const { reasoning: _r, ...lead } = parsed;

      logger.info('LLM mapping completed successfully', {
        franchisorName: this.franchiseConfig.franchisor_name,
        franchiseName: this.franchiseConfig.franchise_name,
        parsed: lead,
      });

      return lead as BetterCRMLead;

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
