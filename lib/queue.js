const { Queue, QueueEvents, Worker } = require("bullmq");
const IORedis = require("ioredis");

const REDIS_URL = String(process.env.REDIS_URL || "").trim();
const REDIS_PREFIX = String(process.env.REDIS_PREFIX || "aibot").trim();
const AGENT_QUEUE_NAME = String(process.env.AGENT_QUEUE_NAME || "agent_tasks").trim();
const STT_QUEUE_NAME = String(process.env.STT_QUEUE_NAME || "stt_tasks").trim();
const NOTIFY_QUEUE_NAME = String(process.env.NOTIFY_QUEUE_NAME || "notify_tasks").trim();
const DEAD_LETTER_QUEUE_NAME = String(process.env.DEAD_LETTER_QUEUE_NAME || "dead_letter").trim();
const JOB_ATTEMPTS = Math.max(1, Number(process.env.JOB_ATTEMPTS || 2));
const JOB_BACKOFF_MS = Math.max(0, Number(process.env.JOB_BACKOFF_MS || 2000));

function isQueueEnabled() {
  return String(process.env.USE_BULLMQ || "").trim() === "1" || Boolean(REDIS_URL);
}

function createConnection() {
  if (!REDIS_URL) {
    return new IORedis({
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
    });
  }
  return new IORedis(REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  });
}

function defaultJobOptions() {
  return {
    removeOnComplete: 200,
    removeOnFail: 500,
    attempts: JOB_ATTEMPTS,
    backoff: JOB_BACKOFF_MS > 0 ? { type: "exponential", delay: JOB_BACKOFF_MS } : undefined,
  };
}

function createQueueByName(name) {
  const connection = createConnection();
  return new Queue(name, {
    connection,
    prefix: REDIS_PREFIX,
    defaultJobOptions: defaultJobOptions(),
  });
}

function createQueueEventsByName(name) {
  const connection = createConnection();
  return new QueueEvents(name, {
    connection,
    prefix: REDIS_PREFIX,
  });
}

function createWorkerByName(name, processor, opts = {}) {
  const connection = createConnection();
  return new Worker(name, processor, {
    connection,
    prefix: REDIS_PREFIX,
    concurrency: Number(opts.concurrency || 1),
  });
}

function createAgentQueue() {
  return createQueueByName(AGENT_QUEUE_NAME);
}

function createSttQueue() {
  return createQueueByName(STT_QUEUE_NAME);
}

function createNotifyQueue() {
  return createQueueByName(NOTIFY_QUEUE_NAME);
}

function createDeadLetterQueue() {
  return createQueueByName(DEAD_LETTER_QUEUE_NAME);
}

function createAgentQueueEvents() {
  return createQueueEventsByName(AGENT_QUEUE_NAME);
}

function createSttQueueEvents() {
  return createQueueEventsByName(STT_QUEUE_NAME);
}

function createNotifyQueueEvents() {
  return createQueueEventsByName(NOTIFY_QUEUE_NAME);
}

function createAgentWorker(processor, opts = {}) {
  return createWorkerByName(AGENT_QUEUE_NAME, processor, {
    concurrency: Number(process.env.AGENT_WORKER_CONCURRENCY || opts.concurrency || 2),
  });
}

function createSttWorker(processor, opts = {}) {
  return createWorkerByName(STT_QUEUE_NAME, processor, {
    concurrency: Number(process.env.STT_WORKER_CONCURRENCY || opts.concurrency || 1),
  });
}

function createNotifyWorker(processor, opts = {}) {
  return createWorkerByName(NOTIFY_QUEUE_NAME, processor, {
    concurrency: Number(process.env.NOTIFY_WORKER_CONCURRENCY || opts.concurrency || 2),
  });
}

module.exports = {
  AGENT_QUEUE_NAME,
  STT_QUEUE_NAME,
  NOTIFY_QUEUE_NAME,
  DEAD_LETTER_QUEUE_NAME,
  createAgentQueue,
  createSttQueue,
  createNotifyQueue,
  createDeadLetterQueue,
  createAgentQueueEvents,
  createSttQueueEvents,
  createNotifyQueueEvents,
  createAgentWorker,
  createSttWorker,
  createNotifyWorker,
  createConnection,
  isQueueEnabled,
};
