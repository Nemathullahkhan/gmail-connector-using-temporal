// Plain functions that talk to Gmail. No Temporal in this file, so each function can be
// tried on its own. Errors that retrying cannot fix are thrown as NotFoundError / AuthError;
// anything else is a plain Error and Temporal retries it.
import { google, gmail_v1 } from 'googleapis';
import MailComposer from 'nodemailer/lib/mail-composer';
import { config } from '../config';
import { AuthError, NotFoundError } from './errors';
import type { Email, MailRequest, NewMessages } from '../types';


export const GMAIL_SCOPES = [
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.compose',
];

export function oauthClient() {
  return new google.auth.OAuth2(
    config.googleClientId,
    config.googleClientSecret,
    `http://localhost:${config.oauthRedirectPort}/oauth2callback`,
  );
}

let api: gmail_v1.Gmail | undefined;
function gmail(): gmail_v1.Gmail {
  if (!api) {
    const auth = oauthClient();
    auth.setCredentials({ refresh_token: config.googleRefreshToken }); // access tokens are fetched and renewed automatically
    api = google.gmail({ version: 'v1', auth });
  }
  return api;
}

/** Runs one Gmail call and sorts its errors into "retry" and "do not retry". */
async function call<T>(what: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err: any) {
    const status = err?.code ?? err?.response?.status;
    const msg = String(err?.response?.data?.error ?? err?.message ?? err);
    if (msg.includes('invalid_grant')) throw new AuthError(`Gmail refresh token rejected (${what}). Run npm run auth again.`);
    if (status === 404) throw new NotFoundError(`Gmail: not found (${what})`);
    throw err;
  }
}

const header = (m: gmail_v1.Schema$Message, name: string) =>
  m.payload?.headers?.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? '';

const decode = (data?: string | null) => (data ? Buffer.from(data, 'base64url').toString('utf8') : '');

/** Walks the MIME tree and returns the first text/plain and text/html bodies. */
function bodies(part: gmail_v1.Schema$MessagePart | undefined, out = { text: '', html: '' }) {
  if (!part) return out;
  if (part.mimeType === 'text/plain' && !out.text && !part.filename) out.text = decode(part.body?.data);
  else if (part.mimeType === 'text/html' && !out.html && !part.filename) out.html = decode(part.body?.data);
  for (const p of part.parts ?? []) bodies(p, out);
  return out;
}

const addresses = (v: string) => [...v.matchAll(/[\w.+'-]+@[\w.-]+\.[A-Za-z]{2,}/g)].map((m) => m[0]);

export async function getMessage(id: string): Promise<Email> {
  const { data: m } = await call(`message ${id}`, () => gmail().users.messages.get({ userId: 'me', id, format: 'full' }));
  const { text, html } = bodies(m.payload);
  const date = header(m, 'Date');
  return {
    id: m.id!,
    messageId: header(m, 'Message-ID'),
    from: addresses(header(m, 'From'))[0] ?? '',
    to: addresses(header(m, 'To')),
    subject: header(m, 'Subject'),
    date: date ? new Date(date).toISOString() : new Date(Number(m.internalDate)).toISOString(),
    text,
    html,
    threadId: m.threadId ?? undefined,
    labels: m.labelIds ?? [],
  };
}

/**
 * New mail since `cursor` (a historyId). With no cursor we start from now: nothing old is read.
 * If Gmail no longer has that history (about a week old), we start from now again and log it,
 * because mail received during the gap cannot be listed from the cursor.
 */
export async function listMessagesSince(cursor?: string): Promise<NewMessages> {
  if (!cursor) return { ids: [], nextCursor: await currentHistoryId() };
  const ids = new Set<string>();
  let next = cursor;
  let pageToken: string | undefined;
  try {
    do {
      const { data } = await call('history', () =>
        gmail().users.history.list({ userId: 'me', startHistoryId: cursor, historyTypes: ['messageAdded'], pageToken }),
      );
      for (const h of data.history ?? []) {
        for (const a of h.messagesAdded ?? []) {
          // Creating a draft also shows up as an added message. A draft is not mail we received or sent.
          if (a.message?.id && !a.message.labelIds?.includes('DRAFT')) ids.add(a.message.id);
        }
      }
      if (data.historyId) next = data.historyId;
      pageToken = data.nextPageToken ?? undefined;
    } while (pageToken);
  } catch (err) {
    if (!(err instanceof NotFoundError)) throw err;
    console.warn(`Gmail history ${cursor} expired; restarting from now. Mail from the gap is not read.`);
    return { ids: [], nextCursor: await currentHistoryId() };
  }
  return { ids: [...ids].reverse(), nextCursor: next };
}

async function currentHistoryId(): Promise<string> {
  const { data } = await call('profile', () => gmail().users.getProfile({ userId: 'me' }));
  return data.historyId!;
}

async function buildRaw(req: MailRequest, rfcId: string): Promise<string> {
  const buf = await new MailComposer({
    from: config.gmailUser,
    to: req.to,
    subject: req.subject,
    text: req.text,
    messageId: rfcId,
  })
    .compile()
    .build();
  return buf.toString('base64url');
}

/** Finds a mail already in Gmail's Sent folder with this Message-ID. */
export async function findSent(rfcId: string): Promise<string | undefined> {
  const q = `in:sent rfc822msgid:${rfcId.replace(/[<>]/g, '')}`;
  const { data } = await call('search sent', () => gmail().users.messages.list({ userId: 'me', q, maxResults: 1 }));
  return data.messages?.[0]?.id ?? undefined;
}

/** Sends a mail. Returns Gmail's message ID. */
export async function sendMail(req: MailRequest, rfcId: string): Promise<string> {
  const raw = await buildRaw(req, rfcId);
  const { data } = await call('send', () => gmail().users.messages.send({ userId: 'me', requestBody: { raw } }));
  return data.id!;
}

/** Creates a real Gmail draft. Returns Gmail's draft ID. */
export async function createGmailDraft(req: MailRequest, rfcId: string): Promise<string> {
  const raw = await buildRaw(req, rfcId);
  const { data } = await call('create draft', () => gmail().users.drafts.create({ userId: 'me', requestBody: { message: { raw } } }));
  return data.id!;
}

/** Sends an existing Gmail draft. Returns Gmail's message ID. */
export async function sendGmailDraft(draftId: string): Promise<string> {
  const { data } = await call('send draft', () => gmail().users.drafts.send({ userId: 'me', requestBody: { id: draftId } }));
  return data.id!;
}
