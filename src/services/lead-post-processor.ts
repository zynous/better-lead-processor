/**
 * Post-processes LLM-mapped lead payload so the Better CRM Lead API returns 201.
 * Based on probe findings: ensures required first_name, valid email, phone entries
 * with non-empty formatted (and no id), address all-or-nothing, and interaction
 * moved to note to avoid 500/705.
 */

import { BetterCRMLead } from '../types';
import { logger } from '../utils';

/** Minimal email check so we don't send invalid email and get 704 */
const VALID_EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isNonEmptyString(s: unknown): s is string {
  return typeof s === 'string' && s.trim().length > 0;
}

function isValidEmail(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  return trimmed.length > 0 && VALID_EMAIL_REGEX.test(trimmed);
}

/**
 * first_name is required by the CRM. If missing or empty, set to "Unknown".
 */
function ensureFirstName(lead: BetterCRMLead): void {
  const profile = lead.profile ?? {};
  lead.profile = profile;

  if (isNonEmptyString(profile.first_name)) return;

  profile.first_name = 'Unknown';
}

/** If email is invalid or empty, move to note as key-value and remove from profile so API doesn't return 704. */
function normalizeEmail(lead: BetterCRMLead): void {
  const profile = lead.profile;
  if (!profile) return;
  if (profile.email_address === undefined || profile.email_address === null) return;
  if (!isValidEmail(profile.email_address)) {
    const value = typeof profile.email_address === 'string' ? profile.email_address.trim() : String(profile.email_address);
    const line = value ? `email=${value}` : 'email=(empty)';
    lead.note = lead.note ? lead.note + '\n' + line : line;
    logger.debug('Lead post-process: moving invalid or empty email_address to note');
    delete profile.email_address;
  }
}

/**
 * Keep only phone entries with non-empty formatted (API returns 704 otherwise).
 * Move dropped entries to note as: phone=<number>,type,code,extension
 */
function normalizePhone(lead: BetterCRMLead): void {
  const profile = lead.profile;
  if (!profile || !Array.isArray(profile.phone)) return;

  const kept: typeof profile.phone = [];
  const droppedLines: string[] = [];
  const DEFAULT_COUNTRY_CODE = '+1';
  for (const entry of profile.phone) {
    if (entry && isNonEmptyString((entry as { formatted?: unknown }).formatted)) {
      const e = entry as Record<string, unknown>;
      if (e.country_code == null || String(e.country_code).trim() === '') {
        e.country_code = DEFAULT_COUNTRY_CODE;
      }
      kept.push(entry);
    } else if (entry && typeof entry === 'object') {
      const e = entry as Record<string, unknown>;
      const num =
        e.formatted !== undefined && e.formatted !== null && String(e.formatted).trim().length > 0
          ? String(e.formatted).trim()
          : '(no number)';
      const type = e.type != null ? String(e.type) : '';
      const code =
        e.country_code != null && String(e.country_code).trim() !== ''
          ? String(e.country_code).trim()
          : DEFAULT_COUNTRY_CODE;
      const ext = e.extension != null ? String(e.extension) : '';
      droppedLines.push('phone=' + num + ',' + type + ',' + code + ',' + ext);
    }
  }
  if (droppedLines.length > 0) {
    lead.note = lead.note ? lead.note + '\n' + droppedLines.join('\n') : droppedLines.join('\n');
  }
  profile.phone = kept.length > 0 ? kept : undefined;
  if (profile.phone === undefined) delete profile.phone;
}

/**
 * CRM requires all of: deliveryAddress, city, province, country, postalCode if any address field is present.
 * Fill any missing required field with "Unknown" so address stays in main block. LLM does not set address when all are missing.
 */
const ADDRESS_REQUIRED_KEYS = ['deliveryAddress', 'city', 'province', 'country', 'postalCode'] as const;

function normalizeAddress(lead: BetterCRMLead): void {
  const address = lead.address;
  if (!address || typeof address !== 'object') return;

  const addr = address as Record<string, unknown>;
  for (const key of ADDRESS_REQUIRED_KEYS) {
    if (!isNonEmptyString(addr[key])) {
      addr[key] = 'Unknown';
    }
  }
}

/**
 * Interaction need  (end_date required for meeting). Move to note and remove block.
 */
function moveInteractionToNote(lead: BetterCRMLead): void {
  const interaction = lead.interaction;
  if (!interaction || typeof interaction !== 'object') return;

  const i = interaction as Record<string, unknown>;
  const kvs: string[] = [];
  if (i.activity_type != null && String(i.activity_type).trim()) kvs.push('activity_type=' + String(i.activity_type).trim());
  if (i.interaction_date != null && String(i.interaction_date).trim()) kvs.push('interaction_date=' + String(i.interaction_date).trim());
  if (i.end_date != null && String(i.end_date).trim()) kvs.push('end_date=' + String(i.end_date).trim());
  if (i.event_name != null && String(i.event_name).trim()) kvs.push('event_name=' + String(i.event_name).trim());
  if (i.event_description != null && String(i.event_description).trim()) kvs.push('event_description=' + String(i.event_description).trim());
  if (kvs.length > 0) {
    const line = 'Interaction: ' + kvs.join(', ');
    lead.note = lead.note ? lead.note + '\n' + line : line;
  }
  delete lead.interaction;
}

/**
 * Returns a normalized lead safe for the Better CRM Lead API (aim for 201).
 * Clones the input so the original is not mutated.
 */
export function postProcessLead(lead: BetterCRMLead): BetterCRMLead {
  const out = JSON.parse(JSON.stringify(lead)) as BetterCRMLead;
  ensureFirstName(out);
  normalizeEmail(out);
  normalizePhone(out);
  normalizeAddress(out);
  moveInteractionToNote(out);
  return out;
}
