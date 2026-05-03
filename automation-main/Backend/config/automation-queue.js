// BullMQ automation queue backed by Redis.
// The server and worker run in this Node process, while Redis persists queued
// and active jobs across process crashes.
const { Queue, Worker, QueueEvents } = require("bullmq");
const IORedis = require("ioredis");

const QUEUE_NAME = process.env.AUTOMATION_QUEUE_NAME || "paysheet-automation";
const REDIS_URL = process.env.REDIS_URL || "redis://127.0.0.1:6379";
let lastRedisErrorLogAt = 0;

function logRedisError(message) {
  const now = Date.now();
  if (now - lastRedisErrorLogAt < 30000) return;
  lastRedisErrorLogAt = now;
  console.error(message);
}

function createRedisConnection(options = {}) {
  const connection = new IORedis(REDIS_URL, {
    maxRetriesPerRequest: options.blocking ? null : 1,
    connectTimeout: 5000,
    enableReadyCheck: false,
    retryStrategy: (times) => Math.min(times * 500, 5000)
  });

  connection.on("error", (err) => {
    logRedisError(`Redis connection error (${REDIS_URL}): ${err.message}`);
  });

  return connection;
}

const queueConnection = createRedisConnection();

const automationQueue = new Queue(QUEUE_NAME, {
  connection: queueConnection,
  defaultJobOptions: {
    attempts: 1,
    removeOnComplete: {
      age: 24 * 60 * 60,
      count: 100
    },
    removeOnFail: {
      age: 7 * 24 * 60 * 60,
      count: 500
    }
  }
});

let automationWorker = null;
let queueEvents = null;

function automationJobId(runId) {
  return `automation:${runId}`;
}

async function enqueueAutomationRun(data) {
  if (!data?.runId) {
    throw new Error("Automation runId is required before queueing a job.");
  }

  return automationQueue.add("automation-run", data, {
    jobId: automationJobId(data.runId)
  });
}

function startAutomationWorker(processor, handlers = {}) {
  if (automationWorker) return automationWorker;

  automationWorker = new Worker(
    QUEUE_NAME,
    processor,
    {
      connection: createRedisConnection({ blocking: true }),
      concurrency: 1,
      lockDuration: 30 * 60 * 1000
    }
  );

  queueEvents = new QueueEvents(QUEUE_NAME, {
    connection: createRedisConnection({ blocking: true })
  });

  automationWorker.on("active", (job) => handlers.active?.(job));
  automationWorker.on("completed", (job) => handlers.completed?.(job));
  automationWorker.on("failed", (job, err) => handlers.failed?.(job, err));
  automationWorker.on("error", (err) => {
    logRedisError(`Automation queue worker error: ${err.message}`);
  });

  queueEvents.on("stalled", ({ jobId }) => {
    console.warn(`Automation queue job stalled and will be retried by BullMQ: ${jobId}`);
  });
  queueEvents.on("error", (err) => {
    logRedisError(`Automation queue events error: ${err.message}`);
  });

  return automationWorker;
}

async function getAutomationQueueStatus() {
  const [waiting, active, delayed, completed, failed, redisPing] = await Promise.all([
    automationQueue.getWaitingCount(),
    automationQueue.getActiveCount(),
    automationQueue.getDelayedCount(),
    automationQueue.getCompletedCount(),
    automationQueue.getFailedCount(),
    queueConnection.ping()
  ]);

  return {
    name: QUEUE_NAME,
    redisUrl: REDIS_URL,
    redis: redisPing === "PONG" ? "connected" : "unknown",
    waiting,
    active,
    delayed,
    completed,
    failed
  };
}

async function closeAutomationQueue() {
  await Promise.allSettled([
    automationWorker?.close(),
    queueEvents?.close(),
    automationQueue.close(),
    queueConnection.quit()
  ]);
}

module.exports = {
  enqueueAutomationRun,
  getAutomationQueueStatus,
  startAutomationWorker,
  closeAutomationQueue
};
