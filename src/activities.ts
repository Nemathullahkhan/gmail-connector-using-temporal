// Activities do the real-world work: Gmail and Postgres. Temporal records each result and
// retries a failed activity for us. An activity may run more than once, so each one
// is written to be safe to repeat.
import { ApplicationFailure } from '@temporalio/activity';
import { config } from './config';
import { getPool } from './db';
import { AuthError, NotFoundError, provider, rfcMessageId } from './mail';
import { assertSafeId } from './types';
import type { DraftResult, Email, MailRequest, NewMessages, SendResult } from './types';

/** Turns errors that retrying cannot fix into non-retryable Temporal failures. */
async function guard<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof NotFoundError) throw ApplicationFailure.nonRetryable(err.message, 'NotFound');
    if (err instanceof AuthError) throw ApplicationFailure.nonRetryable(err.message, 'AuthError');
    throw err; // anything else (Gmail 429/5xx, network) is retried
  }
}

function assertSendAllowed(): void {
  // Mailpit is a local test server, so sending there needs no opt-in.
  if (config.mailProvider === 'gmail' && !config.allowSend) throw ApplicationFailure.nonRetryable('Sending is off. Set ALLOW_SEND=true to enable.', 'SendDisabled');
}

/** Ask the mail server which mail arrived since the cursor. Read-only, so safe to repeat. */
export async function listNewMessageIds(cursor?: string): Promise<NewMessages> {
  return guard(() => provider.listMessagesSince(cursor));
}

/** Read one mail from the mail server. */
export async function fetchMessage(id: string): Promise<Email> {
  return guard(() => provider.getMessage(id));
}

/** Save a mail in Postgres. Same ID again just replaces the row, so a retry is harmless. */
export async function storeEmail(e: Email): Promise<void> {
  assertSafeId('email id', e.id);
  await getPool().query(
    `INSERT INTO emails (id, thread_id, message_id, from_addr, to_addrs, subject, date, text, html, labels)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (id) DO UPDATE SET thread_id=$2, message_id=$3, from_addr=$4, to_addrs=$5, subject=$6,
       date=$7, text=$8, html=$9, labels=$10`,
    [e.id, e.threadId ?? null, e.messageId, e.from, e.to, e.subject, e.date, e.text, e.html, e.labels ?? []],
  );
}

/** Create a real Gmail draft and remember it. A retry finds the saved row and does not create a second draft. */
export async function createDraft(req: MailRequest): Promise<DraftResult> {
  assertSafeId('requestId', req.requestId);
  const pool = getPool();
  const existing = await pool.query('SELECT gmail_draft_id FROM drafts WHERE request_id=$1', [req.requestId]);
  if (existing.rows[0]?.gmail_draft_id) return { draftId: req.requestId };
  const gmailDraftId = await guard(() => provider.createDraft(req, rfcMessageId(req.requestId)));
  await pool.query(
    `INSERT INTO drafts (request_id, gmail_draft_id, to_addrs, subject, text) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (request_id) DO UPDATE SET gmail_draft_id=$2`,
    [req.requestId, gmailDraftId, req.to, req.subject, req.text],
  );
  return { draftId: req.requestId };
}

/** Records a finished send so a retry returns it instead of sending again. */
async function remember(requestId: string, gmailId: string, rfcId: string): Promise<SendResult> {
  await getPool().query(
    `INSERT INTO sent (request_id, gmail_message_id, rfc_message_id) VALUES ($1,$2,$3) ON CONFLICT (request_id) DO NOTHING`,
    [requestId, gmailId, rfcId],
  );
  return { smtpMessageId: rfcId };
}

/**
 * Send a mail. Before sending we look in our own `sent` table, then in Gmail's Sent folder
 * for our Message-ID, so a retry after a timed-out attempt does not send twice.
 */
export async function sendMessage(req: MailRequest): Promise<SendResult> {
  assertSendAllowed();
  assertSafeId('requestId', req.requestId);
  const rfcId = rfcMessageId(req.requestId);
  const done = await getPool().query('SELECT rfc_message_id FROM sent WHERE request_id=$1', [req.requestId]);
  if (done.rows[0]) return { smtpMessageId: done.rows[0].rfc_message_id };
  const already = await guard(() => provider.findSent(rfcId));
  if (already) return remember(req.requestId, already, rfcId);
  return remember(req.requestId, await guard(() => provider.sendMail(req, rfcId)), rfcId);
}

/** Send a saved draft through Gmail. */
export async function sendDraft(draftId: string): Promise<SendResult> {
  assertSendAllowed();
  assertSafeId('draftId', draftId);
  const key = `draft-${draftId}`;
  const done = await getPool().query('SELECT rfc_message_id FROM sent WHERE request_id=$1', [key]);
  if (done.rows[0]) return { smtpMessageId: done.rows[0].rfc_message_id };
  const row = await getPool().query('SELECT gmail_draft_id, to_addrs, subject, text FROM drafts WHERE request_id=$1', [draftId]);
  if (!row.rows[0]) throw ApplicationFailure.nonRetryable(`No draft ${draftId}`, 'NotFound');
  const rfcId = rfcMessageId(draftId); // the draft was built with this Message-ID
  const already = await guard(() => provider.findSent(rfcId));
  if (already) return remember(key, already, rfcId);
  return remember(key, await guard(() => provider.sendDraft(row.rows[0].gmail_draft_id, { requestId: draftId, to: row.rows[0].to_addrs, subject: row.rows[0].subject, text: row.rows[0].text }, rfcId)), rfcId);
}
