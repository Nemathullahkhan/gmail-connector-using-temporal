CREATE TABLE IF NOT EXISTS emails (
  id          text PRIMARY KEY,          -- Gmail message ID
  thread_id   text,
  message_id  text NOT NULL,             -- Message-ID header
  from_addr   text NOT NULL,
  to_addrs    text[] NOT NULL DEFAULT '{}',
  subject     text NOT NULL DEFAULT '',
  date        timestamptz,
  text        text NOT NULL DEFAULT '',
  html        text NOT NULL DEFAULT '',
  labels      text[] NOT NULL DEFAULT '{}',
  stored_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS drafts (
  request_id     text PRIMARY KEY,
  gmail_draft_id text,
  to_addrs       text[] NOT NULL,
  subject        text NOT NULL,
  text           text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- One row per mail we have sent. Checked before every send so a retry cannot send twice.
CREATE TABLE IF NOT EXISTS sent (
  request_id       text PRIMARY KEY,     -- request id, or "draft-<id>" for a sent draft
  gmail_message_id text NOT NULL,
  rfc_message_id   text NOT NULL,
  sent_at          timestamptz NOT NULL DEFAULT now()
);
