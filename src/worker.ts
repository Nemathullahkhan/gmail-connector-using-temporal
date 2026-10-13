// The worker is the process that actually runs our code. The Temporal server only keeps
// the history and the queue. The worker polls the "mail" queue, runs workflow code in
// a sandbox and activity code as normal Node code.
import { NativeConnection, Worker } from '@temporalio/worker';
import * as activities from './activities';
import { config } from './config';
import { TASK_QUEUE } from './types';

async function main() {
  const connection = await NativeConnection.connect({ address: config.temporalAddress });
  const worker = await Worker.create({
    connection,
    taskQueue: TASK_QUEUE,
    workflowsPath: require.resolve('./workflows'),
    activities,
  });
  console.log(`worker running on queue "${TASK_QUEUE}"`);
  await worker.run();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
