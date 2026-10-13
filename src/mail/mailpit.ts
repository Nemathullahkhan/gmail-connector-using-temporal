// Plain functions that talk to Mailpit (local test mail server). Same shape as gmail.ts,
// so mail/index.ts can pick either one. No Temporal in this file.
import * as nodemailer from 'nodemailer';
import { config } from '../config';
import type { Email, MailRequest, NewMessages } from '../types';
import { NotFoundError } from './errors';

const PAGE_SIZE = 100;

interface MailpitAddress {
  Name: string;
  Address: string;
}

/** The part of Mailpit's GET /api/v1/message/{id} answer that we use. */
interface MailpitMessage {
  ID: string;
  MessageID: string;
  From: MailpitAddress;
  To: MailpitAddress[];
  Subject: string;
  Date: string;
  Text: string;
  HTML: string;
}

export async function getMessage(id: string): Promise<Email> {
  const res = await fetch(`${config.mailpitUrl}/api/v1/message/${encodeURIComponent(id)}`);
  if (res.status === 404) throw new NotFoundError(`Mailpit has no message ${id}`);
  if (!res.ok) throw new Error(`Mailpit answered ${res.status} for message ${id}`); // plain Error: Temporal retries it
  const m = (await res.json()) as MailpitMessage;
  return {
    id: m.ID,
    messageId: m.MessageID,
    from: m.From?.Address ?? '',
    to: (m.To ?? []).map((a) => a.Address),
    subject: m.Subject,
    date: m.Date,
    text: m.Text,
    html: m.HTML,
  };
}

/** Sends one mail over SMTP to Mailpit. Returns the Message-ID. */
export async function sendMail(req: MailRequest, rfcId: string): Promise<string> {
  const transport = nodemailer.createTransport({ host: config.smtpHost, port: config.smtpPort, secure: false });
  try {
    const info = await transport.sendMail({ from: config.fromAddress, to: req.to, subject: req.subject, text: req.text, messageId: rfcId });
    return info.messageId;
  } finally {
    transport.close();
  }
}

/**
 * Lists mail received at or after `cursor` (the whole inbox when there is no cursor).
 * Mailpit returns newest first, 100 per page, so we read pages until we pass the cursor.
 * "At or after" (not "after") on purpose: two mails can arrive in the same instant, and a
 * mail we have already seen is harmless because its workflow ID is taken (see start.ts).
 * The cursor is a received time (ISO 8601).
 */
export async function listMessagesSince(cursor?: string): Promise<NewMessages> {
  const since = cursor ? Date.parse(cursor) : -Infinity;
  const ids: string[] = [];
  let latest: string | undefined;
  for (let start = 0; ; start += PAGE_SIZE) {
    const res = await fetch(`${config.mailpitUrl}/api/v1/messages?limit=${PAGE_SIZE}&start=${start}`);
    if (!res.ok) throw new Error(`Mailpit answered ${res.status} listing messages`);
    const page = (await res.json()) as { messages: { ID: string; Created: string }[] };
    for (const m of page.messages) {
      if (Date.parse(m.Created) < since) continue;
      ids.push(m.ID);
      if (!latest || Date.parse(m.Created) > Date.parse(latest)) latest = m.Created;
    }
    const last = page.messages[page.messages.length - 1];
    if (!last || page.messages.length < PAGE_SIZE || Date.parse(last.Created) < since) break;
  }
  return { ids: ids.reverse(), nextCursor: latest }; // oldest first
}

/** Mailpit has no Sent folder search worth using here; our own `sent` table covers repeats. */
export async function findSent(_rfcId: string): Promise<string | undefined> {
  return undefined;
}
