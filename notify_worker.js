require("dotenv").config();

const https = require("https");
const { createNotifyWorker, createDeadLetterQueue } = require("./lib/queue");

const TOKEN = String(process.env.TELEGRAM_BOT_TOKEN || "").trim();
const MAX_ATTEMPTS = Math.max(1, Number(process.env.TELEGRAM_SEND_MAX_ATTEMPTS || 4));
const BASE_RETRY_MS = Math.max(250, Number(process.env.TELEGRAM_SEND_RETRY_BASE_MS || 1200));
const MIN_SEND_INTERVAL_MS = Math.max(0, Number(process.env.TELEGRAM_MIN_SEND_INTERVAL_MS || 200));
const deadLetterQueue = createDeadLetterQueue();
const nextSendByChat = new Map();

if (!TOKEN) {
  console.error("Missing TELEGRAM_BOT_TOKEN in environment (.env).");
  process.exit(1);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseRetryAfterMs(message) {
  const m = String(message || "").match(/retry after\s+(\d+)/i);
  if (!m) return null;
  const sec = Number(m[1]);
  if (!Number.isFinite(sec) || sec <= 0) return null;
  return sec * 1000;
}

async function throttleChatSend(chatId) {
  const key = String(chatId);
  const now = Date.now();
  const next = Number(nextSendByChat.get(key) || 0);
  if (next > now) await sleep(next - now);
  nextSendByChat.set(key, Date.now() + MIN_SEND_INTERVAL_MS);
}

function sendTelegramMessageOnce(chatId, text) {
  return new Promise((resolve, reject) => {
    const payload = new URLSearchParams({
      chat_id: String(chatId),
      text: String(text),
    }).toString();

    const req = https.request(
      {
        hostname: "api.telegram.org",
        path: `/bot${TOKEN}/sendMessage`,
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Content-Length": Buffer.byteLength(payload),
        },
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            return resolve(body);
          }
          reject(new Error(`Telegram HTTP ${res.statusCode || "unknown"}: ${body}`));
        });
      }
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

async function sendTelegramMessage(chatId, text) {
  let lastErr = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      await throttleChatSend(chatId);
      await sendTelegramMessageOnce(chatId, text);
      return;
    } catch (e) {
      lastErr = e;
      const msg = e?.message || String(e);
      const retryAfterMs = parseRetryAfterMs(msg);
      const transient = /429|502|503|504|ETIMEDOUT|ECONNRESET|EAI_AGAIN/i.test(msg);
      if (attempt >= MAX_ATTEMPTS || (!retryAfterMs && !transient)) break;
      await sleep(retryAfterMs || BASE_RETRY_MS * attempt);
    }
  }
  throw lastErr || new Error("notify send failed");
}

const worker = createNotifyWorker(async (job) => {
  const data = job.data || {};
  const chatId = String(data.chatId || "").trim();
  const text = String(data.text || "").trim();
  const requestId = String(data.requestId || "").trim();
  if (!chatId || !text) throw new Error("Missing chatId or text");

  await sendTelegramMessage(chatId, text);
  if (requestId) {
    console.log(`[notify-worker] delivered request_id=${requestId} chat=${chatId}`);
  }
  return { ok: true };
});

worker.on("completed", (job) => {
  console.log(`[notify-worker] completed job=${job.id} name=${job.name}`);
});

worker.on("failed", (job, err) => {
  console.error(`[notify-worker] failed job=${job?.id || "unknown"} error=${err?.message || String(err)}`);
  Promise.resolve()
    .then(async () => {
      if (!job) return;
      const optsAttempts = Number(job.opts?.attempts || 1);
      if ((job.attemptsMade || 0) < optsAttempts) return;
      await deadLetterQueue.add("dead.notify", {
        source: "notify",
        jobId: job.id,
        name: job.name,
        data: job.data,
        attemptsMade: job.attemptsMade,
        failedReason: err?.message || String(err),
        ts: Date.now(),
      });
    })
    .catch((e) => {
      console.error(`[notify-worker] dead-letter enqueue failed: ${e?.message || String(e)}`);
    });
});

worker.on("error", (err) => {
  console.error(`[notify-worker] error ${err?.message || String(err)}`);
});

console.log("[notify-worker] started");
console.log("[notify-worker] concurrency:", Number(process.env.NOTIFY_WORKER_CONCURRENCY || 2));
