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
    oauth_endpoint: string;
  };
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

    const oauthEndpoint = this.config.credentials.oauth_endpoint;
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
    const baseUrl = this.config.credentials.base_url;
    const createLeadUrl = `${baseUrl}/v2/crm/lead`;

    logger.info('Creating lead in Better CRM', {
      franchisorName: this.config.franchisor_name,
      franchiseName: this.config.franchise_name,
    });

    const response = await retry(
      async () => {
        const requestBody = JSON.stringify(lead);
        logger.debug('Better CRM request', {
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

        if (!res.ok) {
          const errorText = await res.text();
          logger.error('Better CRM API error', {
            status: res.status,
            statusText: res.statusText,
            error: errorText,
            payload: requestBody,
          });
          // Throw user-friendly error (internal details logged above)
          throw new Error(ERROR_MESSAGES.BETTER_CRM_ERROR);
        }

        return res;
      },
      { maxRetries: 3, initialDelayMs: 1000 }
    );

    const result = (await response.json()) as {
      code: number;
      data?: { id: number };
      id?: number;
    };

    // Better CRM returns id in data.id or directly as id
    const leadId = result.data?.id || result.id || 0;

    logger.info('Lead created successfully', {
      leadId,
      franchisorName: this.config.franchisor_name,
      franchiseName: this.config.franchise_name,
    });

    return leadId;
  }
}

