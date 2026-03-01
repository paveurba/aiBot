require("dotenv").config();

const { spawnSync } = require("child_process");
const { createSttWorker, createDeadLetterQueue } = require("./lib/queue");

const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 180000);
const LOCAL_STT_SCRIPT = String(process.env.LOCAL_STT_SCRIPT || "/home/pi/aiBot/scripts/transcribe_voice.sh").trim();
const DEFAULT_LANG = String(process.env.WHISPER_LANG || "auto").trim();

const deadLetterQueue = createDeadLetterQueue();

const worker = createSttWorker(async (job) => {
  const data = job.data || {};
  const filePath = String(data.filePath || "").trim();
  const lang = String(data.lang || DEFAULT_LANG || "auto").trim();
  if (!filePath) throw new Error("Missing filePath");

  const result = spawnSync(LOCAL_STT_SCRIPT, [filePath, lang], {
    encoding: "utf8",
    timeout: REQUEST_TIMEOUT_MS,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(String(result.stderr || result.stdout || `stt exited with ${result.status}`).trim());
  }

  const text = String(result.stdout || "").trim();
  return { text };
});

worker.on("completed", (job) => {
  console.log(`[stt-worker] completed job=${job.id} name=${job.name}`);
});

worker.on("failed", (job, err) => {
  console.error(`[stt-worker] failed job=${job?.id || "unknown"} error=${err?.message || String(err)}`);
  Promise.resolve()
    .then(async () => {
      if (!job) return;
      const optsAttempts = Number(job.opts?.attempts || 1);
      if ((job.attemptsMade || 0) < optsAttempts) return;
      await deadLetterQueue.add("dead.stt", {
        source: "stt",
        jobId: job.id,
        name: job.name,
        data: job.data,
        attemptsMade: job.attemptsMade,
        failedReason: err?.message || String(err),
        ts: Date.now(),
      });
    })
    .catch((e) => {
      console.error(`[stt-worker] dead-letter enqueue failed: ${e?.message || String(e)}`);
    });
});

worker.on("error", (err) => {
  console.error(`[stt-worker] error ${err?.message || String(err)}`);
});

console.log("[stt-worker] started");
console.log("[stt-worker] concurrency:", Number(process.env.STT_WORKER_CONCURRENCY || 1));
