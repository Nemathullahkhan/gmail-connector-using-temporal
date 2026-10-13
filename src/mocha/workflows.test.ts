// Workflow tests with fake activities: no Gmail, no real mail. Temporal's test server
// skips time, so retry back-offs finish instantly.
import * as assert from 'node:assert';
import { ApplicationFailure } from '@temporalio/activity';
import { WorkflowFailedError } from '@temporalio/client';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import type * as activities from '../activities';
import type { Email, MailRequest } from '../types';

const email: Email = { id: 'm1', messageId: 'x', from: 'a@b.c', to: ['d@e.f'], subject: 's', date: 'd', text: 't', html: '' };
const request: MailRequest = { requestId: 'r1', to: ['d@e.f'], subject: 's', text: 't' };

describe('workflows', function () {
  let env: TestWorkflowEnvironment;
  before(async () => {
    env = await TestWorkflowEnvironment.createTimeSkipping();
  });
  after(async () => {
    await env?.teardown();
  });

  /** Runs `fn` with a worker that uses the given fake activities. */
  async function withWorker<T>(fake: Partial<typeof activities>, fn: (queue: string) => Promise<T>): Promise<T> {
    const taskQueue = `test-${Math.random().toString(36).slice(2)}`;
    const worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue,
      workflowsPath: require.resolve('../workflows'),
      activities: fake,
    });
    return worker.runUntil(fn(taskQueue));
  }

  it('readEmail fetches then stores', async () => {
    const stored: Email[] = [];
    await withWorker({ fetchMessage: async () => email, storeEmail: async (e) => void stored.push(e) }, (taskQueue) =>
      env.client.workflow.execute('readEmailWorkflow', { taskQueue, workflowId: 'w1', args: ['m1'] }),
    );
    assert.deepStrictEqual(stored, [email]);
  });

  it('readEmail retries a transient failure', async () => {
    let calls = 0;
    await withWorker(
      {
        fetchMessage: async () => {
          if (++calls < 3) throw new Error('server down');
          return email;
        },
        storeEmail: async () => {},
      },
      (taskQueue) => env.client.workflow.execute('readEmailWorkflow', { taskQueue, workflowId: 'w2', args: ['m1'] }),
    );
    assert.strictEqual(calls, 3);
  });

  it('readEmail does not retry NotFound', async () => {
    let calls = 0;
    const run = withWorker(
      {
        fetchMessage: async () => {
          calls++;
          throw ApplicationFailure.nonRetryable('gone', 'NotFound');
        },
      },
      (taskQueue) => env.client.workflow.execute('readEmailWorkflow', { taskQueue, workflowId: 'w3', args: ['m1'] }),
    );
    await assert.rejects(run, WorkflowFailedError);
    assert.strictEqual(calls, 1);
  });

  it('send workflow returns the send result', async () => {
    const result = await withWorker({ sendMessage: async () => ({ smtpMessageId: 'abc' }) }, (taskQueue) =>
      env.client.workflow.execute('sendEmailWorkflow', { taskQueue, workflowId: 'w4', args: [request] }),
    );
    assert.deepStrictEqual(result, { smtpMessageId: 'abc' });
  });

  it('send gives up after 3 attempts', async () => {
    let calls = 0;
    const run = withWorker(
      {
        sendMessage: async () => {
          calls++;
          throw new Error('smtp down');
        },
      },
      (taskQueue) => env.client.workflow.execute('sendEmailWorkflow', { taskQueue, workflowId: 'w5', args: [request] }),
    );
    await assert.rejects(run, WorkflowFailedError);
    assert.strictEqual(calls, 3);
  });

  it('poller starts one read per new mail, passes the cursor on, and ignores repeats', async () => {
    const stored: string[] = [];
    const cursors: (string | undefined)[] = [];
    const fake: Partial<typeof activities> = {
      listNewMessageIds: async (cursor) => {
        cursors.push(cursor);
        if (cursors.length === 1) return { ids: ['a', 'b'], nextCursor: 't1' };
        if (cursors.length === 2) return { ids: ['b', 'c'], nextCursor: 't2' }; // b is a repeat
        return { ids: [], nextCursor: undefined };
      },
      fetchMessage: async (id) => ({ ...email, id }),
      storeEmail: async (e) => void stored.push(e.id),
    };
    await withWorker(fake, async (taskQueue) => {
      const handle = await env.client.workflow.start('pollMailboxWorkflow', {
        taskQueue,
        workflowId: 'poller-test',
        args: [{ pollMs: 5000 }],
      });
      await env.sleep('1 minute'); // time skipping: the poller loops many times
      await handle.terminate();
    });
    assert.deepStrictEqual([...stored].sort(), ['a', 'b', 'c']); // each mail stored exactly once
    assert.strictEqual(cursors[0], undefined);
    assert.strictEqual(cursors[1], 't1');
    assert.strictEqual(cursors[2], 't2'); // cursor kept when a poll finds nothing
  });

  it('poller survives Continue-As-New and keeps its cursor', async () => {
    const cursors: (string | undefined)[] = [];
    const fake: Partial<typeof activities> = {
      listNewMessageIds: async (cursor) => {
        cursors.push(cursor);
        return cursors.length === 1 ? { ids: [], nextCursor: 't1' } : { ids: [], nextCursor: undefined };
      },
    };
    await withWorker(fake, async (taskQueue) => {
      const handle = await env.client.workflow.start('pollMailboxWorkflow', {
        taskQueue,
        workflowId: 'poller-can',
        args: [{ pollMs: 1000, maxLoops: 2 }],
      });
      await env.sleep('30 seconds');
      await handle.terminate();
    });
    assert.ok(cursors.length > 4);
    assert.ok(cursors.slice(1).every((c) => c === 't1'), 'cursor lost across restart');
  });
});
