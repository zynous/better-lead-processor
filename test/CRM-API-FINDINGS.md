# Better CRM Lead API – Probe Findings

This document is filled in after running the CRM API probe (`pnpm test:crm-probe` or `node test/crm-api-probe.js`) and reviewing `test/crm-api-probe-results.json`. It records how the **actual** Lead API behaves (which may differ from official API docs).

**Design note:** The first block of cases (empty body, single fields, pairs) is used to discover **mandatory identity**. All other cases (address, information, interaction, note, profile optional fields) include a **baseline mandatory profile** (e.g. `first_name` + `last_name` + `email_address`) so that if the API rejects, the error can be attributed to the field under test, not to “missing required identity.”

---

**Post-processing:** Rules from probe results are in `src/services/lead-post-processor.ts` and `docs/CRM-API-RULES-FROM-PROBE.md`. Lambda runs post-process after LLM and before CRM so payload gets 201.

## 1. Identity / profile – mandatory vs optional

**Question:** What is the minimum set of profile fields required to create a lead?

| Finding | Notes |
|--------|--------|
| Empty body `{}` | Accepted / Rejected? (see case `empty-body`) |
| Only `profile: {}` | Accepted / Rejected? (see case `profile-empty`) |
| Only `first_name` | (case `first-name-only`) |
| Only `last_name` | (case `last-name-only`) |
| Only `business_name` | (case `business-name-only`) |
| Only `email_address` (valid) | (case `email-only-valid`) |
| Only `email_address` (invalid) | (case `email-only-invalid`) |
| `first_name` + `last_name` | (case `first-and-last`) |
| `first_name` + `last_name` + `email_address` | (case `first-last-email`) |
| `first_name` + `last_name` + `email_address` + `business_name` | (case `first-last-email-business`) |

**Conclusion (fill after reviewing results):**

- Minimum required: at least one of [ first_name, last_name, email_address, business_name ]? Or a specific combination (e.g. first + last + email)?
- Optional: which of first_name, last_name, business_name, email_address, phone can be omitted when others are present?

---

## 2. Email validation

| Scenario | Case ID | Accepted? | API message (if rejected) |
|----------|---------|-----------|----------------------------|
| Valid email `probe-valid@example.com` | email-only-valid | | |
| Invalid format `not-an-email` | email-only-invalid | | |
| Empty string `""` | email-only-empty | | |
| Minimal valid `a@b.co` | email-minimal-valid | | |

**Conclusion:** Does the API validate email format? Does it reject empty email?

---

## 3. Address – omit vs partial vs full

**Question:** If `address` is sent, can it be partial, or must certain sub-fields be present together?

| Scenario | Case ID | Accepted? | Notes |
|----------|---------|-----------|--------|
| No `address` block | address-omit | | |
| Only `deliveryAddress` | address-only-delivery | | |
| Only `city` | address-only-city | | |
| Only `postalCode` | address-only-postal | | |
| `deliveryAddress` + `city` | address-delivery-and-city | | |
| Full address (street, city, province, country, postalCode) | address-full | | |

**Conclusion:**

- If `address` is omitted entirely: accepted when profile is valid?
- If `address` is sent: can we send only one field (e.g. postalCode)? Or must we send either the full set or omit the whole block?

---

## 4. Other fields

| Scenario | Case ID | Accepted? | Notes |
|----------|---------|-----------|--------|
| `note` only (with valid profile) | note-only-with-profile | | |
| `information.source_id` | information-source-id | | |
| `information` only (no profile identifiers) | information-only-no-profile-identifiers | | |
| `interaction` (call / meeting) | interaction-call, interaction-meeting | | |
| Empty `phone: []` | phone-empty-array | | |
| Multiple phones | phone-multiple | | |
| `allow_calls` / `allow_marketing_email` | profile-allow-calls-marketing | | |
| `gender` (information) | gender-unspecified, gender-male | | |

---

## 5. Edge cases

| Scenario | Case ID | Accepted? | Notes |
|----------|---------|-----------|--------|
| `first_name` empty string `""` | first-name-empty-string | | |
| Very long `first_name` (500 chars) | very-long-first-name | | |
| Special chars in name (O'Brien, José, 中文) | special-chars-name | | |
| Numeric-looking string as first_name | numeric-first-name | | |
| Whitespace in names | whitespace-first-name | | |

---

## 6. Final working set (for post-processing)

After reviewing all results, summarize the rules to enforce **before** calling the CRM Lead API:

1. **Identity**
   - Required: …
   - Optional: …
   - At least one of: [ first_name, last_name, email_address, business_name ]? Or stricter?

2. **Email**
   - Required format: …
   - Empty allowed: yes / no

3. **Address**
   - If omitted: …
   - If present: allowed subsets (e.g. full only, or any subset), or “if one field then all of …”

4. **Phone**
   - Empty array allowed: …
   - Format of `formatted`: …

5. **Other**
   - `note`, `information`, `interaction`: optional and accepted as-is? Any validation?

---

## How to run the probe

```bash
# From project root; requires local-configs/app-config.json and local-configs/<franchisor>.json
pnpm test:crm-probe

# Optional: specify franchisor and franchise
node test/crm-api-probe.js --franchisor=lice-squad --franchise="My Franchise"

# List cases only (no API calls)
node test/crm-api-probe.js --dry-run
```

Results are written to `test/crm-api-probe-results.json`. Use that file to fill the tables above and the “Final working set” section.
