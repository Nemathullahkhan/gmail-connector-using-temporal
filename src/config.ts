import * as path from 'node:path';

// Every setting has a default that works with the local setup in the README, except the
// Google credentials, which come from .env. Override with environment variables.
const root = path.resolve(__dirname, '..');

export const config = {
  /** gmail (real mailbox) or mailpit (local test server). */
  mailProvider: process.env.MAIL_PROVIDER === 'mailpit' ? 'mailpit' : 'gmail',
  mailpitUrl: (process.env.MAILPIT_URL ?? 'http://localhost:8026').replace(/\/+$/, ''),
  smtpHost: process.env.SMTP_HOST ?? 'localhost',
  smtpPort: Number(process.env.SMTP_PORT ?? 1026),
  fromAddress: process.env.FROM_ADDRESS ?? 'connector@example.com',
  gmailUser: process.env.GMAIL_USER ?? '',
  googleClientId: process.env.GOOGLE_CLIENT_ID ?? '',
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET ?? '',
  googleRefreshToken: process.env.GOOGLE_REFRESH_TOKEN ?? '',
  /** The Web client's registered redirect URI. npm run auth listens on it. */
  oauthRedirectPort: 53682,
  /** Sending is off until you opt in, because this is a real mailbox. */
  allowSend: process.env.ALLOW_SEND === 'true',
  databaseUrl: process.env.DATABASE_URL ?? 'postgres://mailconn:mailconn_dev@localhost:5432/mailconn',
  temporalAddress: process.env.TEMPORAL_ADDRESS ?? 'localhost:7233',
  root,
};
