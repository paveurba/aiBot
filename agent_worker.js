require("dotenv").config();

const { createAgentWorker, createDeadLetterQueue, createNotifyQueue } = require("./lib/queue");
const { runAgent } = require("./agent_runner");

const WORKDIR = process.env.BOT_WORKDIR || process.cwd();
const CODEX_BIN = (process.env.CODEX_BIN || "codex").trim();
const CLAUDE_BIN = (process.env.CLAUDE_BIN || "claude").trim();
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 180000);
const REUSE_SESSIONS = String(process.env.REUSE_SESSIONS || "1") === "1";
const CODEX_BYPASS_SANDBOX = String(process.env.CODEX_BYPASS_SANDBOX || "1") === "1";

const config = {
  WORKDIR,
  CODEX_BIN,
  CLAUDE_BIN,
  REQUEST_TIMEOUT_MS,
  REUSE_SESSIONS,
  CODEX_BYPASS_SANDBOX,
};

const deadLetterQueue = createDeadLetterQueue();
const notifyQueue = createNotifyQueue();

function classifyFailure(message) {
  const raw = String(message || "").trim();
  const lower = raw.toLowerCase();
  if (lower.includes("stalled")) {
    return {
      code: "stalled",
      summary: "Worker was interrupted (restart/crash) and BullMQ marked the job stalled.",
    };
  }
  if (lower.includes("timed out") || lower.includes("timeout")) {
    return {
      code: "timeout",
      summary: "Task exceeded configured timeout while waiting for completion.",
    };
  }
  if (
    lower.includes("exited with code") ||
    lower.includes("spawn") ||
    lower.includes("econnreset") ||
    lower.includes("eai_again")
  ) {
    return {
      code: "agent_process",
      summary: "Agent process exited or runtime dependency failed.",
    };
  }
  return {
    code: "execution_error",
    summary: "Task failed due to an execution error in the worker/agent pipeline.",
  };
}

function buildFailureNotice({ job, errMessage }) {
  const details = classifyFailure(errMessage);
  const requestId = String(job?.data?.requestId || "").trim();
  const lines = [
    `Task failed (id=${job?.id || "unknown"}).`,
    `Reason: ${details.summary}`,
    `Error: ${errMessage}`,
  ];
  if (requestId) lines.push(`request_id: ${requestId}`);
  return lines.join("\n").slice(0, 3900);
}

const worker = createAgentWorker(async (job) => {
  const data = job.data || {};
  const agent = data.agent || "codex";
  const requestId = data.requestId ? String(data.requestId) : "";
  if (requestId) {
    console.log(`[worker] start request_id=${requestId} job=${job.id}`);
  }
  const result = await runAgent(agent, {
    sessionId: data.sessionId || null,
    prompt: String(data.prompt || ""),
    model: data.model || null,
    requestId: requestId || null,
    config,
  });
  if (requestId) {
    console.log(`[worker] done request_id=${requestId} job=${job.id}`);
  }
  return result;
});

worker.on("completed", (job) => {
  console.log(`[worker] completed job=${job.id} name=${job.name}`);
});

worker.on("failed", (job, err) => {
  const errMessage = err?.message || String(err);
  console.error(`[worker] failed job=${job?.id || "unknown"} error=${errMessage}`);
  Promise.resolve()
    .then(async () => {
      if (!job) return;
      const state = String((await job.getState().catch(() => "")) || "");
      const optsAttempts = Number(job.opts?.attempts || 1);
      const isTerminalFailure = state === "failed" || Number(job.attemptsMade || 0) >= optsAttempts;
      if (!isTerminalFailure) return;
      await deadLetterQueue.add("dead.agent", {
        source: "agent",
        jobId: job.id,
        name: job.name,
        data: job.data,
        attemptsMade: job.attemptsMade,
        failedReason: errMessage,
        ts: Date.now(),
      });
      const chatId = String(job.data?.chatId || "").trim();
      if (chatId) {
        await notifyQueue.add(
          "notify.text",
          {
            chatId,
            requestId: String(job.data?.requestId || "").trim() || null,
            text: buildFailureNotice({ job, errMessage }),
          },
          { jobId: `failed-alert:${job.id}` }
        );
      }
    })
    .catch((e) => {
      console.error(`[worker] dead-letter enqueue failed: ${e?.message || String(e)}`);
    });
});

worker.on("error", (err) => {
  console.error(`[worker] error ${err?.message || String(err)}`);
});

console.log("[worker] agent worker started");
console.log("[worker] concurrency:", Number(process.env.AGENT_WORKER_CONCURRENCY || 2));
