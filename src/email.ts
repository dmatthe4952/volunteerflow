import nodemailer from 'nodemailer';
import { config } from './config.js';

export type EmailMessage = {
  to: string;
  subject: string;
  text: string;
  html?: string;
};

export function canSendEmail(): boolean {
  // SMTP is the only supported option outside of development/test.
  if (config.smtp.host && config.smtp.fromEmail) return true;
  if (config.env === 'development') return true; // dev can log or optionally use sendmail
  if (config.env === 'test') return false;
  return false;
}

function redactEmail(email: string): string {
  const [local, domain] = email.split('@');
  if (!domain) return '[redacted]';
  const maskedLocal = local.length <= 2 ? `${local[0] ?? ''}*` : `${local.slice(0, 2)}***`;
  return `${maskedLocal}@${domain}`;
}

function fromHeader(): string {
  const fromEmail = config.smtp.fromEmail;
  const fromName = config.smtp.fromName;
  if (fromEmail) return fromName ? `"${fromName}" <${fromEmail}>` : fromEmail;
  // Dev fallback so local sendmail has something sane.
  if (config.env === 'development') return `"${fromName || 'VolunteerFlow'}" <no-reply@localhost>`;
  return '';
}

export async function sendEmail(msg: EmailMessage): Promise<void> {
  const from = fromHeader();

  // SMTP (staging/production, or dev if explicitly configured)
  if (config.smtp.host && config.smtp.fromEmail) {
    const transporter = nodemailer.createTransport({
      host: config.smtp.host,
      port: config.smtp.port,
      secure: config.smtp.secure,
      auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined,
      // Prevent hanging requests if the SMTP endpoint is unreachable or stalls.
      connectionTimeout: 5_000,
      greetingTimeout: 5_000,
      socketTimeout: 10_000
    });

    await transporter.sendMail({
      from,
      to: msg.to,
      subject: msg.subject,
      text: msg.text,
      html: msg.html
    });
    return;
  }

  // Local dev optional: try system sendmail (works only if the runtime has a local MTA).
  // This is opt-in because many dev setups run in containers without sendmail installed.
  const wantSendmail =
    config.env === 'development' && (process.env.EMAIL_TRANSPORT === 'sendmail' || Boolean(process.env.SENDMAIL_PATH));
  if (wantSendmail) {
    try {
      const transporter = nodemailer.createTransport({
        sendmail: true,
        newline: 'unix',
        path: process.env.SENDMAIL_PATH || undefined
      } as any);

      await transporter.sendMail({
        from: from || `"VolunteerFlow" <no-reply@localhost>`,
        to: msg.to,
        subject: msg.subject,
        text: msg.text,
        html: msg.html
      });
      return;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[email:dev] sendmail transport failed; falling back to console log', err);
      // Fall through to console logging below.
    }
  }

  // In non-dev environments, missing SMTP config is an error (don't silently "send").
  if (config.env !== 'development' && config.env !== 'test') {
    throw new Error('Email sending is not configured.');
  }

  // eslint-disable-next-line no-console
  console.log('[email:dev]', { to: redactEmail(msg.to), subject: msg.subject, text: msg.text, html: msg.html });
}
