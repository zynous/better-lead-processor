import {
  SecretsManagerClient,
  GetSecretValueCommand,
  GetSecretValueCommandInput,
} from '@aws-sdk/client-secrets-manager';
import { FranchiseConfig, SystemConfig, FranchiseConfigSchema, SystemConfigSchema } from '../types';
import { logger } from '../utils';
import * as http from 'http';

const IS_LOCAL = process.env.AWS_SAM_LOCAL === 'true' || !process.env.AWS_LAMBDA_FUNCTION_NAME;
const SECRETS_EXTENSION_HTTP_PORT = 2773;

/** When running locally, configs are under project root (use cwd so it works with bundled dist/). */
function getLocalConfigsDir(): string {
  const path = require('path');
  return path.join(process.cwd(), 'local-configs');
}

// Cache for secrets (Lambda container reuse)
const secretCache = new Map<string, { value: unknown; timestamp: number }>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Get secret from Lambda Extension (faster, cached by extension).
 * Extension requires X-Aws-Parameters-Secrets-Token header set to AWS_SESSION_TOKEN.
 */
async function getSecretFromExtension(secretName: string): Promise<string> {
  const sessionToken = process.env.AWS_SESSION_TOKEN;
  if (!sessionToken) {
    throw new Error('AWS_SESSION_TOKEN not set (required by Parameters and Secrets Extension)');
  }

  return new Promise((resolve, reject) => {
    const path = `/secretsmanager/get?secretId=${encodeURIComponent(secretName)}`;
    const options: http.RequestOptions = {
      hostname: 'localhost',
      port: SECRETS_EXTENSION_HTTP_PORT,
      path,
      method: 'GET',
      headers: {
        'X-Aws-Parameters-Secrets-Token': sessionToken,
      },
    };
    const request = http.get(options, (response) => {
      let data = '';

      response.on('data', (chunk) => {
        data += chunk;
      });

      response.on('end', () => {
        if (response.statusCode === 200) {
          try {
            const parsed = JSON.parse(data);
            resolve(parsed.SecretString || parsed.SecretBinary);
          } catch (error) {
            reject(new Error(`Failed to parse extension response: ${error}`));
          }
        } else {
          reject(new Error(`Extension returned status ${response.statusCode}: ${data}`));
        }
      });
    });

    request.on('error', (error) => {
      reject(error);
    });

    request.setTimeout(2000, () => {
      request.destroy();
      reject(new Error('Extension request timeout'));
    });
  });
}

/**
 * Get secret from Secrets Manager SDK (fallback)
 */
async function getSecretFromSDK(secretName: string): Promise<string> {
  const systemConfig = await getSystemConfig();
  const region = systemConfig.aws_region;
  const client = new SecretsManagerClient({ region });
  const input: GetSecretValueCommandInput = {
    SecretId: secretName,
  };

  try {
    const command = new GetSecretValueCommand(input);
    const response = await client.send(command);
    return response.SecretString || '';
  } catch (error) {
    logger.error('Failed to get secret from SDK', { secretName }, error as Error);
    throw error;
  }
}

/**
 * Get secret with caching and extension support
 */
async function getSecret(secretName: string, useExtension = true): Promise<string> {
  // Check cache first
  const cached = secretCache.get(secretName);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    logger.debug('Using cached secret', { secretName });
    return cached.value as string;
  }

  let secretValue: string;

  // Try extension first (if not local and enabled)
  if (useExtension && !IS_LOCAL) {
    try {
      secretValue = await getSecretFromExtension(secretName);
      logger.debug('Retrieved secret from extension', { secretName });
    } catch (error) {
      logger.warn('Extension failed, falling back to SDK', { secretName }, error as Error);
      secretValue = await getSecretFromSDK(secretName);
    }
  } else {
    secretValue = await getSecretFromSDK(secretName);
  }

  // Update cache
  secretCache.set(secretName, { value: secretValue, timestamp: Date.now() });

  return secretValue;
}

/**
 * Get franchise configuration from Secrets Manager or local file
 * 
 * Returns a merged config with franchise-specific overrides applied
 */
export async function getFranchiseConfig(
  franchisorName: string,
  franchiseName: string
): Promise<FranchiseConfig & {
  franchise_name: string;
  credentials: {
    client_id: string;
    client_secret: string;
    base_url: string;
  };
  config: FranchiseConfig['config'] & {
    llm_settings: { model: string; temperature?: number };
    lead_defaults?: { source_id?: string | number };
  }
}> {
  const normalizedFranchisor = franchisorName.trim().toLowerCase();
  const normalizedFranchise = franchiseName.trim().toLowerCase();

  let franchisorConfig: FranchiseConfig;

  if (IS_LOCAL) {
    // Load from local franchisor config file (use cwd so it works when running from bundled dist/)
    const fs = await import('fs');
    const path = await import('path');
    const configPath = path.join(getLocalConfigsDir(), `${normalizedFranchisor}.json`);

    if (!fs.existsSync(configPath)) {
      throw new Error(`Local franchisor config not found: ${configPath}`);
    }

    const configContent = fs.readFileSync(configPath, 'utf8');
    franchisorConfig = FranchiseConfigSchema.parse(JSON.parse(configContent));
  } else {
    // Load from Secrets Manager
    const secretName = `better-lead-processor/${normalizedFranchisor}`;
    const secretValue = await getSecret(secretName);
    franchisorConfig = FranchiseConfigSchema.parse(JSON.parse(secretValue));
  }

  // Resolve franchise key case-insensitively (config may use any casing)
  const franchiseKey = Object.keys(franchisorConfig.franchises ?? {}).find(
    (k) => k.toLowerCase() === normalizedFranchise
  );
  const franchiseOverrides = franchiseKey ? franchisorConfig.franchises?.[franchiseKey] : undefined;

  // Get franchise-specific overrides - credentials are required at franchise level
  if (!franchiseOverrides?.credentials) {
    throw new Error(`Credentials are required for franchise: ${franchiseName}`);
  }

  const systemConfig = await getSystemConfig();

  // Merge configs: franchisor defaults + franchise overrides; base_url from system config
  // Use resolved key for franchise_name so casing matches config
  return {
    franchisor_name: franchisorConfig.franchisor_name,
    franchise_name: franchiseKey ?? normalizedFranchise,
    api_key: franchisorConfig.api_key,
    active: franchisorConfig.active,
    credentials: {
      ...franchiseOverrides.credentials,
      base_url: systemConfig.better_crm_base_url,
    },
    config: {
      notification_settings:
        franchiseOverrides?.config?.notification_settings ??
        franchisorConfig.config.notification_settings ??
        { email_on_failure: false, notification_emails: [] },
      lead_defaults:
        franchiseOverrides?.config?.lead_defaults ??
        franchisorConfig.config.lead_defaults,
      llm_settings:
        franchiseOverrides?.config?.llm_settings ?? franchisorConfig.config.llm_settings,
    },
  };
}

/**
 * Get franchisor-level configuration (without franchise-specific data)
 * Used for postal code mapping lookup
 */
export async function getFranchisorConfig(franchisorName: string): Promise<FranchiseConfig> {
  const normalizedFranchisor = franchisorName.trim().toLowerCase();

  if (IS_LOCAL) {
    const fs = await import('fs');
    const path = await import('path');
    const configPath = path.join(getLocalConfigsDir(), `${normalizedFranchisor}.json`);

    if (!fs.existsSync(configPath)) {
      throw new Error(`Local franchisor config not found: ${configPath}`);
    }

    const configContent = fs.readFileSync(configPath, 'utf8');
    return FranchiseConfigSchema.parse(JSON.parse(configContent));
  } else {
    const secretName = `better-lead-processor/${normalizedFranchisor}`;
    const secretValue = await getSecret(secretName);
    return FranchiseConfigSchema.parse(JSON.parse(secretValue));
  }
}

/**
 * Get system-level configuration (LLM API key)
 */
export async function getSystemConfig(): Promise<SystemConfig> {
  if (IS_LOCAL) {
    // Load from local config file (use cwd so it works when running from bundled dist/)
    const fs = await import('fs');
    const path = await import('path');
    const configPath = path.join(getLocalConfigsDir(), 'app-config.json');

    if (!fs.existsSync(configPath)) {
      throw new Error(`Local system config not found: ${configPath}`);
    }

    const configContent = fs.readFileSync(configPath, 'utf8');
    const config = JSON.parse(configContent);
    return SystemConfigSchema.parse(config);
  }
  try {
    const secretName = 'better-lead-processor/app-config';
    const secretValue = await getSecret(secretName);
    const config = JSON.parse(secretValue);
    return SystemConfigSchema.parse(config);
  } catch (error) {
    logger.error('Failed to get system config from Secrets Manager', { error }, error as Error);
    throw error;
  }
}

