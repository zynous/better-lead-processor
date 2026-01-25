/**
 * Utility functions: logging, postal code, retry
 */

// ==================== Logging ====================

export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
}

interface LogContext {
  requestId?: string;
  franchisorName?: string;
  franchiseName?: string;
  [key: string]: unknown;
}

export interface LogConfig {
  level: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';
  includeTimestamp?: boolean;
}

class Logger {
  private minLevel: LogLevel = LogLevel.INFO;

  configure(config: LogConfig): void {
    this.minLevel = LogLevel[config.level];
  }

  private shouldLog(level: LogLevel): boolean {
    return level >= this.minLevel;
  }

  private log(level: LogLevel, message: string, context?: LogContext, error?: Error): void {
    if (!this.shouldLog(level)) {
      return;
    }

    const logEntry: Record<string, unknown> = {
      timestamp: new Date().toISOString(),
      level: LogLevel[level],
      message,
    };

    if (context) {
      Object.assign(logEntry, context);
    }

    if (error) {
      logEntry.error = {
        name: error.name,
        message: error.message,
        stack: error.stack,
      };
    }

    console.log(JSON.stringify(logEntry));
  }

  debug(message: string, context?: LogContext): void {
    this.log(LogLevel.DEBUG, message, context);
  }

  info(message: string, context?: LogContext): void {
    this.log(LogLevel.INFO, message, context);
  }

  warn(message: string, context?: LogContext, error?: Error): void {
    this.log(LogLevel.WARN, message, context, error);
  }

  error(message: string, context?: LogContext, error?: Error): void {
    this.log(LogLevel.ERROR, message, context, error);
  }
}

export const logger = new Logger();

// ==================== Postal Code ====================

export function extractPostalCode(data: Record<string, unknown>): string | null {
  const postalCodeFields = [
    'postal_code',
    'postalCode',
    'zip',
    'zipCode',
    'zip_code',
    'postal',
    'postcode',
  ];

  for (const field of postalCodeFields) {
    const value = data[field];
    if (value && typeof value === 'string' && value.trim().length > 0) {
      return normalizePostalCode(value);
    }
  }

  if (data.address && typeof data.address === 'string') {
    const address = data.address;
    const canadianPattern = /\b([A-Z]\d[A-Z]\s?\d[A-Z]\d)\b/i;
    const canadianMatch = address.match(canadianPattern);
    if (canadianMatch) {
      return normalizePostalCode(canadianMatch[1]);
    }

    const usPattern = /\b(\d{5}(?:-\d{4})?)\b/;
    const usMatch = address.match(usPattern);
    if (usMatch) {
      return normalizePostalCode(usMatch[1]);
    }
  }

  return null;
}

function normalizePostalCode(code: string): string {
  return code.replace(/\s+/g, '').toUpperCase();
}

export function lookupFranchiseFromPostalCode(
  postalCode: string,
  mapping: Record<string, string> | undefined
): string | null {
  if (!mapping) {
    return null;
  }

  const normalizedCode = normalizePostalCode(postalCode);

  if (mapping[normalizedCode]) {
    return mapping[normalizedCode];
  }

  if (normalizedCode.length >= 3) {
    const prefix = normalizedCode.substring(0, 3);
    if (mapping[prefix]) {
      return mapping[prefix];
    }
  }

  return null;
}

// ==================== Retry ====================

export interface RetryOptions {
  maxRetries: number;
  initialDelayMs: number;
  maxDelayMs?: number;
  backoffMultiplier?: number;
}

const DEFAULT_OPTIONS: Required<RetryOptions> = {
  maxRetries: 3,
  initialDelayMs: 1000,
  maxDelayMs: 30000,
  backoffMultiplier: 2,
};

export async function retry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = DEFAULT_OPTIONS
): Promise<T> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  let lastError: Error | unknown;

  for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      if (attempt === opts.maxRetries) {
        throw error;
      }

      const delay = Math.min(
        opts.initialDelayMs * Math.pow(opts.backoffMultiplier, attempt),
        opts.maxDelayMs
      );

      await sleep(delay);
    }
  }

  throw lastError;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

