# Mail connector

Reads, drafts and sends Gmail through [Temporal](https://docs.temporal.io/) workflows. New mail is found by a polling workflow (Gmail `history.list`). Mail, drafts and sent records live in Postgres.

Read `docs/CODE-STORY.md` for how the files fit together (parts about Mailpit and the webhook are out of date: Gmail replaced Mailpit and polling replaced the webhook).

## Architecture

```
                         +--------------------------+
   you                   |  Temporal server         |
    |                    |  workflow history,       |
    v                    |  timers, retries,        |
+-----------+  start     |  task queue "mail"       |
| CLI       |----------->|                          |
| client.ts |            +--------------------------+
+-----------+                  ^             |
                         results|             | tasks
                               |             v
                  +-----------------------------------------+
                  | Worker  (worker.ts, queue "mail")       |
                  |                                         |
                  |  workflows.ts    decide the order       |
                  |       |          of steps, no I/O       |
                  |       v                                 |
                  |  activities.ts   do the work,           |
                  |       |          safe to repeat         |
                  |       v                                 |
                  |  mail/index.ts   MAIL_PROVIDER          |
                  |    |        |                           |
                  |  gmail.ts  mailpit.ts                   |
                  +-----|--------|-------------|------------+
                        |        |             |
                  HTTPS |        | SMTP/HTTP   | SQL
                        v        v             v
                  +-----------+ +---------+ +------------------+
                  | Gmail API | | Mailpit | | Postgres 16      |
                  | (default) | | (tests) | | emails           |
                  +-----------+ +---------+ | drafts           |
                                            | sent             |
                                            +------------------+
```

How a new mail gets stored:

```
 poller workflow            read workflow              worker / Gmail / DB
 ---------------            -------------              -------------------
 sleep 30 s
 listNewMessageIds(cursor) ------------------------->  Gmail history.list
 for each new id:
   start email-<id> ------->  fetchMessage(id) ---->   Gmail messages.get
                              storeEmail(mail) ---->   INSERT ... ON CONFLICT
 keep new cursor, loop
 (Continue-As-New after 500 polls)
```

### Approach

- **Temporal owns the state, the worker owns the side effects.** Workflows only decide the order of steps and are deterministic, so Temporal can replay them after a crash. Everything that touches Gmail or Postgres is an activity.
- **Polling, not webhooks.** Gmail has no webhook. A long-running poller workflow asks `history.list` for changes since a cursor (a Gmail `historyId`), starts one child workflow per new mail, and carries the cursor forward. It restarts itself with Continue-As-New so its history stays small.
- **The workflow ID is the idempotency key.** Child workflows are `email-<id>`, sends are `send-<requestId>`, drafts are `draft-<requestId>`. Starting an ID that already ran is rejected, so the same mail is never read twice and the same request never sends twice.
- **Activities are safe to run twice.** Stores are upserts. Draft creation checks the `drafts` table first. A send checks the `sent` table, then Gmail's Sent folder for the request's Message-ID, then sends.
- **Retries match the risk.** Reads and drafts retry up to 10 times, polling retries forever, sends retry up to 3 times. Failures that retrying cannot fix (`NotFound`, `AuthError`, `SendDisabled`) are non-retryable.
- **One folder per mail provider.** Workflows never see Gmail. `mail/index.ts` exposes one interface, so `gmail.ts` and `mailpit.ts` are interchangeable.
- **Safe by default on a real mailbox.** Sending is refused unless `ALLOW_SEND=true`. Drafts are skipped by the poller.

## Tech stack

| Layer | Choice |
|---|---|
| Language and runtime | TypeScript 5.9 on Node.js (22 or newer) |
| Orchestration | Temporal, TypeScript SDK (`@temporalio/*` 1.24+); local server via `temporal server start-dev` |
| Mail | Gmail API through `googleapis`, OAuth 2.0 with a refresh token |
| MIME building | `nodemailer` (message composer for Gmail sends, SMTP for Mailpit) |
| Local test mail | Mailpit, optional |
| Storage | PostgreSQL 16 in Docker (`docker-compose.yml`), accessed with `pg` |
| Migrations | Plain SQL files in `migrations/`, applied by `npm run migrate` |
| Tests | Mocha, with `@temporalio/testing` (time-skipping test server and fake activities) |
| Tooling | `ts-node`, `tsc --noEmit` for type checks |

## Setup

1. Google Cloud: enable the Gmail API, set up the consent screen with scopes `gmail.modify`, `gmail.send`, `gmail.compose`, and create a **Web** OAuth client with redirect URI `http://localhost:53682/oauth2callback`.
2. `cp .env.example .env` and fill in `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GMAIL_USER`.
3. `docker compose up -d --wait` (Postgres), then `npm install`, `npm run migrate`.
4. `npm run auth` (one-time browser consent; saves `GOOGLE_REFRESH_TOKEN` to `.env`).

## Run

```
temporal server start-dev
npm run worker
npm run client -- start-poller --interval-sec 30   # new mail only, from now
```

## Mailpit (local test server, no Google needed)

Set `MAIL_PROVIDER=mailpit` in `.env` (or the shell) and run Mailpit on the ports in `.env.example`:

```
mailpit --smtp :1026 --listen :8026
curl -s -X POST localhost:8026/api/v1/send -H 'Content-Type: application/json' \
  -d '{"From":{"Email":"a@example.com"},"To":[{"Email":"me@example.com"}],"Subject":"hi","Text":"hello"}'
```

With Mailpit, sending needs no `ALLOW_SEND`, the poller reads the whole inbox on its first run, and drafts live only in Postgres (Mailpit has no drafts). The poller cursor is a different kind for each provider, so stop the poller (`npm run client -- stop-poller`) before switching.

## Commands

```
npm run client -- read --id <gmail id>                                    # print a stored mail
npm run client -- draft --to a@b.c --subject S --text T --request-id d1   # creates a real Gmail draft
npm run client -- send --to a@b.c --subject S --text T --request-id r1    # needs ALLOW_SEND=true
npm run client -- send-draft --draft-id d1                                # needs ALLOW_SEND=true
```

Sending is off unless `ALLOW_SEND=true`. A send checks the `sent` table, then Gmail's Sent folder for the request's Message-ID, before sending, so a retry cannot send twice.

## Tests

`npm test`: workflow tests with fake activities (no Gmail or Postgres needed), plus Mailpit integration tests that are skipped when Mailpit is not running.

## Known limits

- If the poller is down for about a week, Gmail drops the history cursor. The poller restarts from now and logs a warning; mail from the gap is not read.
- Mail received while no poller runs is picked up on the next poll, as long as the cursor is still valid.
