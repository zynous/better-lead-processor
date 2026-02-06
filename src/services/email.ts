import { SESClient, SendEmailCommand, SendEmailCommandInput } from '@aws-sdk/client-ses';
import { logger } from '../utils';
import { getSystemConfig } from './secrets-manager';

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

  const systemConfig = await getSystemConfig();
  const region = systemConfig.aws_region;
  const fromEmail = systemConfig.ses_from_email;

  const client = new SESClient({ region });

  const title = `Lead Processing Failed - ${franchisorName}/${franchiseName}`;

  // Prettify JSON request body
  let prettifiedBody = '';
  if (requestBody) {
    if (typeof requestBody === 'string') {
      try {
        prettifiedBody = JSON.stringify(JSON.parse(requestBody), null, 2);
      } catch {
        prettifiedBody = requestBody;
      }
    } else {
      prettifiedBody = JSON.stringify(requestBody, null, 2);
    }
  }

  let body = `
Hi,

The lead that was submitted from your website was not created on Better CRM. Here is the lead data that was submitted:
${prettifiedBody}

Reason: ${reason}`;

  const emailBody = body.trim();

  const params: SendEmailCommandInput = {
    Source: fromEmail,
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
