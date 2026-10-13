// Picks the mail provider (MAIL_PROVIDER=gmail|mailpit) and gives activities one interface.
// Workflows never see this file.
import { config } from '../config';
import type { Email, MailRequest, NewMessages } from '../types';
import * as gmail from './gmail';
import * as mailpit from './mailpit';

export { AuthError, NotFoundError } from './errors';

export interface MailProvider {
  getMessage(id: string): Promise<Email>;
  listMessagesSince(cursor?: string): Promise<NewMessages>;
  /** Sends one mail with the given Message-ID. Returns the provider's message ID. */
  sendMail(req: MailRequest, rfcId: string): Promise<string>;
  /** Looks for an already-sent mail with this Message-ID. */
  findSent(rfcId: string): Promise<string | undefined>;
  /** Creates a draft. Returns a provider draft ID (Mailpit has no drafts: the DB row is the draft). */
  createDraft(req: MailRequest, rfcId: string): Promise<string>;
  /** Sends a draft created by createDraft. `req` is the saved draft content. */
  sendDraft(draftId: string, req: MailRequest, rfcId: string): Promise<string>;
}

const gmailProvider: MailProvider = {
  ...gmail,
  createDraft: gmail.createGmailDraft,
  sendDraft: (draftId) => gmail.sendGmailDraft(draftId),
};

const mailpitProvider: MailProvider = {
  ...mailpit,
  createDraft: async (req) => `local-${req.requestId}`,
  sendDraft: (_draftId, req, rfcId) => mailpit.sendMail(req, rfcId),
};

export const provider: MailProvider = config.mailProvider === 'mailpit' ? mailpitProvider : gmailProvider;

/** The address mail is sent from. */
export const fromAddress = config.mailProvider === 'mailpit' ? config.fromAddress : config.gmailUser;

/** Deterministic Message-ID, so a retry builds the same mail and can be found again. */
export const rfcMessageId = (requestId: string) => `<${requestId}@${fromAddress.split('@')[1] ?? 'localhost'}>`;
