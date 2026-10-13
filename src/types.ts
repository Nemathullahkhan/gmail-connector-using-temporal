// Shared shapes and names. Workflows import this file, so it must contain no I/O
// (no fs, no network, no process.env). Keep it plain types and tiny helpers.

/** The queue the worker listens on and every workflow is started on. */
export const TASK_QUEUE = 'mail';

/** A mail we have read and stored. */
export interface Email {
  id: string; // Gmail message ID
  messageId: string; // the Message-ID header
  from: string;
  to: string[];
  subject: string;
  date: string; // ISO 8601
  text: string;
  html: string;
  threadId?: string;
  labels?: string[];
}

/** What a caller gives us to create or send a mail. */
export interface MailRequest {
  requestId: string; // idempotency key: same ID = same mail, sent at most once
  to: string[];
  subject: string;
  text: string;
}

export interface SendResult {
  smtpMessageId: string;
}

/** Answer to "what is new since this cursor?". The cursor is a Gmail historyId (a numeric string). */
export interface NewMessages {
  ids: string[];
  nextCursor?: string; // pass this to the next call
}

/** Input of the poller workflow. */
export interface PollInput {
  cursor?: string; // Gmail historyId; undefined = start from now (new mail only)
  pollMs: number; // wait between polls
  maxLoops?: number; // restart the workflow (Continue-As-New) after this many polls
}

export interface DraftResult {
  draftId: string;
}

// Workflow IDs carry the idempotency key. Temporal refuses to start a second
// workflow with an ID that is already running (or already completed, with our
// reuse policy), so "same ID" means "same job".
export const POLLER_WORKFLOW_ID = 'poller';
export const emailWorkflowId = (gmailId: string) => `email-${gmailId}`;
export const sendWorkflowId = (requestId: string) => `send-${requestId}`;
export const draftWorkflowId = (requestId: string) => `draft-${requestId}`;
export const sendDraftWorkflowId = (draftId: string) => `senddraft-${draftId}`;

/** Ids end up in file names and workflow IDs, so allow only safe characters. */
export function assertSafeId(kind: string, value: string): void {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(value)) {
    throw new Error(`${kind} "${value}" not allowed. Use 1 to 64 letters, digits, - or _.`);
  }
}
