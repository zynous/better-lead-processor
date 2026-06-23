import { z } from 'zod';
import { BetterCRMLeadSchema, BetterCRMLead } from '../types';
import { stripNullFromInput } from '../services/llm-mapper';
import { postProcessLead } from '../services/lead-post-processor';

// Reproduces the CloudWatch failure: the LLM emitted address.deliveryAddress: null,
// which z.string().optional() rejects ("expected string, received null").
const llmOutputWithNullDeliveryAddress = {
  profile: {
    first_name: 'Sara',
    last_name: 'Martin',
    email_address: 'sarashae33@gmail.com',
    phone: [{ formatted: '2268023273' }],
  },
  information: { bio: 'Booking for myself.' },
  address: {
    deliveryAddress: null,
    city: 'Hagersville',
    province: 'ON',
    country: 'CA',
    postalCode: 'N0A 1H0',
  },
};

describe('null deliveryAddress handling', () => {
  it('documents the original bug: the raw schema rejects an explicit null', () => {
    const result = BetterCRMLeadSchema.shape.address.safeParse(
      llmOutputWithNullDeliveryAddress.address
    );
    expect(result.success).toBe(false);
  });

  it('the preprocess fix coerces null to undefined so validation passes', () => {
    const fixedSchema = z.preprocess(
      (value) => stripNullFromInput(value),
      BetterCRMLeadSchema.shape.address
    );
    const result = fixedSchema.safeParse(llmOutputWithNullDeliveryAddress.address);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).not.toHaveProperty('deliveryAddress');
    }
  });

  it('post-processing fills deliveryAddress with Unknown and passes final validation', () => {
    const fixedSchema = z.preprocess(
      (value) => stripNullFromInput(value),
      BetterCRMLeadSchema
    );
    const parsed = fixedSchema.parse(llmOutputWithNullDeliveryAddress) as BetterCRMLead;

    const normalized = postProcessLead(parsed);
    expect(normalized.address?.deliveryAddress).toBe('Unknown');
    expect(normalized.address?.city).toBe('Hagersville');
    expect(normalized.address?.province).toBe('ON');

    // The payload that would be sent to the CRM must still satisfy strict validation.
    expect(() => BetterCRMLeadSchema.parse(normalized)).not.toThrow();
  });
});
