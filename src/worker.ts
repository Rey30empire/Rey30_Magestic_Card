import { env } from "./config/env";
import { closePostgresMirror, initPostgresMirror } from "./db/postgres";
import { closeSqlServerConnection } from "./db/sqlserver";
import { initDb } from "./db/sqlite";
import { startTrainingQueueConsumer, stopTrainingQueue, isRedisTrainingQueueEnabled } from "./services/training-queue";
import {
  processTrainingJobQueueAttempt,
  startTrainingJobWorkerPolling,
  stopTrainingJobWorkerPolling
} from "./services/training-jobs";

let shuttingDown = false;

async function shutdown(code = 0): Promise<void> {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  stopTrainingJobWorkerPolling();
  await Promise.allSettled([stopTrainingQueue(), closeSqlServerConnection(), closePostgresMirror()]);
  process.exit(code);
}

async function bootstrapWorker(): Promise<void> {
  await initDb();
  await initPostgresMirror();

  if (isRedisTrainingQueueEnabled()) {
    await startTrainingQueueConsumer(async (context) => {
      await processTrainingJobQueueAttempt(context);
    });
  } else {
    await startTrainingJobWorkerPolling({
      pollMs: env.TRAINING_WORKER_POLL_MS
    });
  }

  console.log(
    `[training-worker] started (db=${env.DB_PATH}, mode=${env.TRAINING_RUNNER_MODE}, queueBackend=${env.TRAINING_QUEUE_BACKEND}, pollMs=${env.TRAINING_WORKER_POLL_MS})`
  );

  process.on("SIGINT", () => {
    void shutdown(0);
  });

  process.on("SIGTERM", () => {
    void shutdown(0);
  });
}

bootstrapWorker().catch((error) => {
  console.error("[training-worker] failed to start", error);
  void Promise.allSettled([closeSqlServerConnection(), closePostgresMirror()]).finally(() => process.exit(1));
});
