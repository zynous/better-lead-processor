import { BetterCRMLead } from '../types';
import { logger, retry } from '../utils';
import { ERROR_MESSAGES } from '../error-messages';

interface OAuthToken {
  access_token: string;
  token_type: string;
  expires_in?: number;
}

interface FranchiseConfigWithCredentials {
  franchisor_name: string;
  franchise_name: string;
  credentials: {
    client_id: string;
    client_secret: string;
    base_url: string;
  };
}

/** HTTP status codes that are typically transient (retry-safe). */
const TRANSIENT_5XX = [502, 503, 504];

/** Parse Better CRM error response body and return msg if present. */
function parseBetterCRMMessage(responseText: string): string | null {
  try {
    const body = JSON.parse(responseText) as { msg?: string };
    return typeof body?.msg === 'string' ? body.msg : null;
  } catch {
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Better CRM API Service
 * Handles OAuth2 authentication and lead creation
 */
export class BetterCRMService {
  private tokenCache: { token: string; expiresAt: number } | null = null;
  private config: FranchiseConfigWithCredentials;

  constructor(config: FranchiseConfigWithCredentials) {
    this.config = config;
  }

  /**
   * Get OAuth2 access token (with caching)
   */
  private async getAccessToken(): Promise<string> {
    // Check if cached token is still valid (with 5 minute buffer)
    if (this.tokenCache && this.tokenCache.expiresAt > Date.now() + 5 * 60 * 1000) {
      logger.debug('Using cached OAuth token');
      return this.tokenCache.token;
    }

    logger.info('Fetching new OAuth token', {
      franchisorName: this.config.franchisor_name,
      franchiseName: this.config.franchise_name,
    });

    const baseUrl = this.config.credentials.base_url.replace(/\/$/, '');
    const oauthEndpoint = `${baseUrl}/oauth/access_token`;
    const clientId = this.config.credentials.client_id;
    const clientSecret = this.config.credentials.client_secret;

    // OAuth2 Client Credentials Flow - form-encoded body
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
    });

    const response = await retry(
      async () => {
        const res = await fetch(oauthEndpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: body.toString(),
        });

        if (!res.ok) {
          const errorText = await res.text();
          logger.error('OAuth token request failed', {
            status: res.status,
            statusText: res.statusText,
            error: errorText,
          });
          // Throw user-friendly error (internal details logged above)
          throw new Error(ERROR_MESSAGES.BETTER_CRM_ERROR);
        }

        return res;
      },
      { maxRetries: 3, initialDelayMs: 1000 }
    );

    const tokenData = (await response.json()) as OAuthToken;

    // Cache token (default to 1 hour if expires_in not provided)
    const expiresIn = tokenData.expires_in || 3600;
    this.tokenCache = {
      token: tokenData.access_token,
      expiresAt: Date.now() + expiresIn * 1000,
    };

    logger.info('OAuth token obtained', {
      expiresIn,
      tokenType: tokenData.token_type,
    });

    return tokenData.access_token;
  }

  /**
   * Create a lead in Better CRM
   */
  async createLead(lead: BetterCRMLead): Promise<number> {
    const accessToken = await this.getAccessToken();
    const baseUrl = this.config.credentials.base_url.replace(/\/$/, '');
    const createLeadUrl = `${baseUrl}/v2/crm/lead`;

    logger.info('Creating lead in Better CRM', {
      franchisorName: this.config.franchisor_name,
      franchiseName: this.config.franchise_name,
    });

    const requestBody = JSON.stringify(lead);
    const maxRetries = 3;
    let lastResponseText: string | null = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      logger.info('Payload sent to Better CRM lead API', {
        franchisorName: this.config.franchisor_name,
        franchiseName: this.config.franchise_name,
        url: createLeadUrl,
        payload: requestBody,
      });

      const res = await fetch(createLeadUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: requestBody,
      });

      const responseText = await res.text();
      lastResponseText = responseText;

      if (res.status === 201) break;

      const apiMsg = parseBetterCRMMessage(responseText);
      let crmResponseBody: unknown = responseText;
      try {
        crmResponseBody = JSON.parse(responseText) as unknown;
      } catch {
        // keep as string if not JSON
      }
      logger.error('Better CRM API error', {
        status: res.status,
        statusText: res.statusText,
        crmResponseBody,
        message: apiMsg ?? undefined,
        payload: requestBody,
      });

      // Only retry on transient 5xx (502, 503, 504). 4xx and 500 are not retried.
      const isTransient = TRANSIENT_5XX.includes(res.status);
      if (!isTransient || attempt === maxRetries) {
        throw new Error(apiMsg || ERROR_MESSAGES.BETTER_CRM_ERROR);
      }

      const delayMs = 1000 * Math.pow(2, attempt);
      await sleep(delayMs);
    }

    const response = { ok: true as const, text: lastResponseText! };

    const result = JSON.parse(response.text) as {
      code: number;
      msg?: string;
      data?: { id: number };
      id?: number;
      [key: string]: unknown;
    };

    // API doc: successful response is Code 201. Body code must be 201; fail otherwise (e.g. 704).
    if (result.code !== 201) {
      const apiMsg = result.msg || String(result);
      logger.error('Better CRM API error (body code)', {
        franchisorName: this.config.franchisor_name,
        franchiseName: this.config.franchise_name,
        code: result.code,
        msg: result.msg,
        response: result,
      });
      throw new Error(apiMsg || ERROR_MESSAGES.BETTER_CRM_ERROR);
    }

    // Better CRM returns id in data.id or directly as id
    const leadId = result.data?.id ?? result.id ?? 0;

    logger.info('Better CRM create-lead response', {
      franchisorName: this.config.franchisor_name,
      franchiseName: this.config.franchise_name,
      response: result,
      leadId,
    });

    return leadId;
  }
}

