// Command line tool: npm run client -- <command> ...
//   send       --to a@b.c --subject S --text T --request-id ID
//   draft      --to a@b.c --subject S --text T --request-id ID
//   send-draft --draft-id ID
//   read       --id GMAIL_ID
//   start-poller [--interval-sec 10]   start the loop that looks for new mail (safe to repeat)
//   stop-poller
import { parseArgs } from 'node:util';
import { WorkflowIdReusePolicy } from '@temporalio/common';
import { closePool, getPool } from './db';
import { getClient, startOnce } from './start';
import { POLLER_WORKFLOW_ID, assertSafeId, draftWorkflowId, sendDraftWorkflowId, sendWorkflowId } from './types';
import type { MailRequest } from './types';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    to: { type: 'string', multiple: true },
    subject: { type: 'string' },
    text: { type: 'string' },
    'request-id': { type: 'string' },
    'draft-id': { type: 'string' },
    id: { type: 'string' },
    'interval-sec': { type: 'string' },
  },
});

function need<T>(value: T | undefined, flag: string): T {
  if (value === undefined) throw new Error(`Missing --${flag}`);
  return value;
}

function mailRequest(): MailRequest {
  const requestId = need(values['request-id'], 'request-id');
  assertSafeId('request-id', requestId);
  return { requestId, to: need(values.to, 'to'), subject: need(values.subject, 'subject'), text: need(values.text, 'text') };
}

async function main() {
  const command = positionals[0];
  switch (command) {
    case 'send': {
      const req = mailRequest();
      const { handle, existed } = await startOnce('sendEmailWorkflow', sendWorkflowId(req.requestId), [req]);
      console.log(existed ? 'already requested, not sending again:' : 'sent:', await handle.result());
      break;
    }
    case 'draft': {
      const req = mailRequest();
      const { handle, existed } = await startOnce('createDraftWorkflow', draftWorkflowId(req.requestId), [req]);
      console.log(existed ? 'draft already exists:' : 'draft created:', await handle.result());
      break;
    }
    case 'send-draft': {
      const draftId = need(values['draft-id'], 'draft-id');
      assertSafeId('draft-id', draftId);
      const { handle, existed } = await startOnce('sendDraftWorkflow', sendDraftWorkflowId(draftId), [draftId]);
      console.log(existed ? 'draft already sent:' : 'draft sent:', await handle.result());
      break;
    }
    case 'read': {
      const id = need(values.id, 'id');
      assertSafeId('id', id);
      const { rows } = await getPool().query('SELECT * FROM emails WHERE id=$1', [id]);
      console.log(rows[0] ? JSON.stringify(rows[0], null, 2) : `no stored mail ${id}`);
      await closePool();
      break;
    }
    case 'start-poller': {
      const pollMs = Number(values['interval-sec'] ?? 10) * 1000;
      if (!(pollMs >= 1000)) throw new Error('--interval-sec must be at least 1');
      // ALLOW_DUPLICATE_FAILED_ONLY: a poller that was stopped or crashed may start again; a running one may not.
      const { existed } = await startOnce('pollMailboxWorkflow', POLLER_WORKFLOW_ID, [{ pollMs }], WorkflowIdReusePolicy.ALLOW_DUPLICATE_FAILED_ONLY);
      console.log(existed ? 'poller already running' : `poller started, polling every ${pollMs / 1000}s`);
      break;
    }
    case 'stop-poller': {
      await (await getClient()).workflow.getHandle(POLLER_WORKFLOW_ID).terminate('stopped from CLI');
      console.log('poller stopped');
      break;
    }
    default:
      console.log('Commands: send | draft | send-draft | read | start-poller | stop-poller  (see top of src/client.ts)');
  }
  process.exit(0); // the Temporal connection keeps Node alive otherwise
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
