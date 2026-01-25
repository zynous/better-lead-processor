import { SESClient, SendEmailCommand, SendEmailCommandInput } from '@aws-sdk/client-ses';
import { logger } from '../utils';

const IS_LOCAL = process.env.AWS_SAM_LOCAL === 'true' || !process.env.AWS_LAMBDA_FUNCTION_NAME;

/**
 * Send email notification via SES
 */
export async function sendFailureNotification(
  to: string[],
  franchisorName: string,
  franchiseName: string,
  reason: string,
  requestBody?: unknown
): Promise<void> {
  if (IS_LOCAL) {
    logger.warn('Email notification skipped (local mode)', { to, franchisorName, franchiseName });
    return;
  }

  const client = new SESClient({ region: process.env.AWS_REGION || 'us-east-1' });

  const title = `Lead Processing Failed - ${franchisorName}/${franchiseName}`;
  
  let body = `
Reason: ${reason}`;

  if (requestBody) {
    const requestBodyStr = typeof requestBody === 'string' 
      ? requestBody 
      : JSON.stringify(requestBody, null, 2);
    body += `\n\nRequest Body:\n${requestBodyStr}`;
  }

  const emailBody = body.trim();

  const params: SendEmailCommandInput = {
    Source: process.env.SES_FROM_EMAIL || 'team@zynous.com',
    Destination: {
      ToAddresses: to,
    },
    Message: {
      Subject: {
        Data: title,
        Charset: 'UTF-8',
      },
      Body: {
        Text: {
          Data: emailBody,
          Charset: 'UTF-8',
        },
      },
    },
  };

  try {
    const command = new SendEmailCommand(params);
    await client.send(command);
    logger.info('Failure notification email sent', { to, title, franchisorName, franchiseName });
  } catch (error) {
    logger.error('Failed to send notification email', { to, title, franchisorName, franchiseName }, error as Error);
    // Don't throw - email failure shouldn't break the flow
  }
}

