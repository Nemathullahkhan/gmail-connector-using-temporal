// One helper for starting a workflow under a fixed ID, at most once.
import { Client, Connection, WorkflowExecutionAlreadyStartedError } from '@temporalio/client';
import type { WorkflowHandle } from '@temporalio/client';
import { WorkflowIdReusePolicy } from '@temporalio/common';
import { config } from './config';
import { TASK_QUEUE } from './types';

let client: Client | undefined;

export async function getClient(): Promise<Client> {
  if (!client) {
    const connection = await Connection.connect({ address: config.temporalAddress });
    client = new Client({ connection });
  }
  return client;
}

/**
 * Starts `workflow` with the given ID. If a workflow with that ID already ran or is running,
 * nothing new starts and we get a handle to the existing one (`existed: true`).
 * REJECT_DUPLICATE matters: by default Temporal would start a *new* run once the old one
 * has finished, and a finished "send" would send again.
 */
export async function startOnce(
  workflow: string,
  workflowId: string,
  args: unknown[],
  reusePolicy: WorkflowIdReusePolicy = WorkflowIdReusePolicy.REJECT_DUPLICATE,
): Promise<{ handle: WorkflowHandle; existed: boolean }> {
  const c = await getClient();
  try {
    const handle = await c.workflow.start(workflow, {
      taskQueue: TASK_QUEUE,
      workflowId,
      args,
      workflowIdReusePolicy: reusePolicy,
    });
    return { handle, existed: false };
  } catch (err) {
    if (err instanceof WorkflowExecutionAlreadyStartedError) {
      return { handle: c.workflow.getHandle(workflowId), existed: true };
    }
    throw err;
  }
}
