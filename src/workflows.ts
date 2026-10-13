// Workflows decide the order of steps. They must be deterministic: no network, no disk,
// no Date.now(), no Math.random(). Anything like that belongs in an activity.
// Temporal can replay a workflow from its history after a crash, which only works
// if the same history always leads to the same decisions.
import {
  ParentClosePolicy,
  WorkflowIdReusePolicy,
  continueAsNew,
  proxyActivities,
  sleep,
  startChild,
  workflowInfo,
} from '@temporalio/workflow';
import { WorkflowExecutionAlreadyStartedError } from '@temporalio/common';
import type * as activities from './activities';
import { emailWorkflowId } from './types';
import type { DraftResult, MailRequest, PollInput, SendResult } from './types';

// Reading and drafting are safe to repeat, so retry freely (default: forever, with backoff).
const safe = proxyActivities<typeof activities>({
  startToCloseTimeout: '30 seconds', // one attempt may run at most this long
  retry: { initialInterval: '1 second', maximumInterval: '30 seconds', maximumAttempts: 10 },
});

// A send that times out may still have reached the server, so a retry could send twice.
// Keep attempts low. The workflow ID (send-<requestId>) already stops a second *request*.
const sendActivities = proxyActivities<typeof activities>({
  startToCloseTimeout: '30 seconds',
  retry: { initialInterval: '2 seconds', maximumAttempts: 3 },
});

// Listing is read-only and must keep going while the mail server is down, so it retries forever
// (no maximumAttempts). The poller then survives an outage instead of dying.
const poll = proxyActivities<typeof activities>({
  startToCloseTimeout: '30 seconds',
  retry: { initialInterval: '1 second', maximumInterval: '30 seconds' },
});

/**
 * Long-running loop: ask what is new, start one readEmailWorkflow per mail, remember the cursor, sleep.
 * sleep() is a Temporal timer: it survives worker restarts and costs nothing while waiting.
 * A workflow history cannot grow forever, so after maxLoops polls we restart ourselves with the
 * current cursor (Continue-As-New).
 */
export async function pollMailboxWorkflow(input: PollInput): Promise<void> {
  let cursor = input.cursor;
  const maxLoops = input.maxLoops ?? 500;
  for (let loops = 0; ; loops++) {
    const found = await poll.listNewMessageIds(cursor);
    for (const id of found.ids) {
      try {
        await startChild(readEmailWorkflow, {
          workflowId: emailWorkflowId(id),
          args: [id],
          parentClosePolicy: ParentClosePolicy.PARENT_CLOSE_POLICY_ABANDON, // the read keeps going if we restart
          workflowIdReusePolicy: WorkflowIdReusePolicy.WORKFLOW_ID_REUSE_POLICY_REJECT_DUPLICATE,
        });
      } catch (err) {
        if (err instanceof WorkflowExecutionAlreadyStartedError) continue; // seen before: skip
        throw err;
      }
    }
    cursor = found.nextCursor ?? cursor;
    await sleep(input.pollMs);
    if (loops + 1 >= maxLoops || workflowInfo().continueAsNewSuggested) {
      return continueAsNew<typeof pollMailboxWorkflow>({ cursor, pollMs: input.pollMs, maxLoops: input.maxLoops });
    }
  }
}

/** Reads one mail: fetch it, then store it. Started by the poller, one per new mail. */
export async function readEmailWorkflow(gmailId: string): Promise<void> {
  const email = await safe.fetchMessage(gmailId);
  await safe.storeEmail(email);
}

export async function sendEmailWorkflow(req: MailRequest): Promise<SendResult> {
  return sendActivities.sendMessage(req);
}

export async function createDraftWorkflow(req: MailRequest): Promise<DraftResult> {
  return safe.createDraft(req);
}

export async function sendDraftWorkflow(draftId: string): Promise<SendResult> {
  return sendActivities.sendDraft(draftId);
}
