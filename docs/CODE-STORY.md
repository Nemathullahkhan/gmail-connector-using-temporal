# Code story: how the files connect

Two stories: a mail arriving, and a mail being sent. Both end in the same place: an activity doing real work.

## The cast

| File | Role | Rule it follows |
|---|---|---|
| `src/types.ts` | Shared shapes, queue name, workflow-ID helpers | No I/O, because workflows import it |
| `src/config.ts` | Settings from environment, with defaults | Only Node-side code imports it |
| `src/mail/mailpit.ts` | `getMessage` (HTTP) and `smtpSend` (SMTP) | Plain functions, no Temporal |
| `src/activities.ts` | Five activities wrapping the above plus file I/O | Safe to run twice |
| `src/workflows.ts` | Four workflows: order of steps, retry policy | Deterministic: no I/O |
| `src/worker.ts` | Runs workflows and activities for the `mail` queue | The only process that executes our code |
| `src/start.ts` | `startOnce`: start a workflow under a fixed ID, at most once | Shared by the CLI (and any future caller) |
| `src/client.ts` | CLI: send, draft, send-draft, read, start-poller, stop-poller | Hands jobs to Temporal |

## Story 1: a mail arrives (polling)

1. You run `npm run client -- start-poller`. `client.ts` calls `startOnce('pollMailboxWorkflow', 'poller', [{ pollMs }])`. The ID `poller` means only one poller can run. A second `start-poller` finds it and prints "already running".
2. The worker runs `pollMailboxWorkflow` (`workflows.ts`). It is a loop that lives for days.
3. Each loop, the workflow calls the activity `listNewMessageIds(cursor)`. The activity calls `mail/mailpit.ts listMessagesSince`, which reads `GET /api/v1/messages` page by page, newest first, and keeps mail received at or after the cursor. It returns the IDs (oldest first) and the newest received time.
4. For each ID the workflow starts a child workflow `readEmailWorkflow` with ID `email-<id>`. If that ID is already taken (the cursor is inclusive, so the newest mail is listed again each poll), Temporal refuses and the workflow skips it. This is the only deduplication needed.
5. The workflow saves the newest received time as the new cursor, then calls `sleep(pollMs)`. This is a Temporal timer, so it survives a worker restart.
6. The child `readEmailWorkflow` calls `fetchMessage` (HTTP `GET /api/v1/message/{id}`), then `storeEmail` (writes `data/emails/<id>.json`). Retry rules are as before: 404 fails at once, other errors retry up to 10 times.
7. After 500 polls (or when Temporal suggests it) the poller restarts itself with the same cursor (Continue-As-New), so its history never grows without limit. Children are started with `PARENT_CLOSE_POLICY_ABANDON`, so a restart does not cancel a read in progress.
8. If the mail server is down, `listNewMessageIds` retries forever with back-off and the poller waits. If the worker is down, nothing is lost: the next poll after it returns finds everything since the cursor.

## Story 2: a mail is sent

1. You run `npm run client -- send --to ... --request-id r1`. `client.ts` builds a `MailRequest` and calls `startOnce('sendEmailWorkflow', sendWorkflowId('r1'), [req])`.
2. First time: a new workflow `send-r1` starts. Second time with the same ID: `startOnce` returns a handle to the existing one, so nothing is sent again and the CLI prints the original result.
3. The worker runs `sendEmailWorkflow`, which calls `sendActivities.sendMessage(req)`. This uses a stricter retry policy (3 attempts), because a send that timed out may have succeeded.
4. `activities.sendMessage` calls `mail/mailpit.ts smtpSend`, which delivers over SMTP to Mailpit.
5. The workflow returns `{ smtpMessageId }`. The CLI's `handle.result()` receives it and prints it.
6. Mailpit now has a new mail. The next poll in Story 1 finds it and stores it like any other.

Drafts follow the same shape: `draft` runs `createDraftWorkflow` which writes `drafts/<requestId>.json`; `send-draft` runs `sendDraftWorkflow` which loads that file and calls `smtpSend`.

## Dependency map

```
client.ts ──> start.ts ──> Temporal server <── worker.ts ──> workflows.ts ──> (types.ts)
                                                  └─────────> activities.ts ──> mail/mailpit.ts
                                                                   └────────> config.ts, types.ts
```

Workflows only ever point at `activities.ts` by type (`import type`) and at `types.ts`. Everything that touches the outside world sits below `activities.ts`. To move to a different mail provider, replace `mail/mailpit.ts` and leave the rest alone.
