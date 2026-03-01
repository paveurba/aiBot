const fs = require("fs");
const https = require("https");
const path = require("path");

const SUPPORTED_EXTENSIONS = new Set([".ogg", ".opus"]);

function parseRetryAfterMs(message) {
  const m = String(message || "").match(/retry after\s+(\d+)/i);
  if (!m) return null;
  const sec = Number(m[1]);
  if (!Number.isFinite(sec) || sec <= 0) return null;
  return sec * 1000;
}

function isRetryableStatusCode(statusCode) {
  return statusCode === 429 || statusCode === 502 || statusCode === 503 || statusCode === 504;
}

function shouldRetryError(error) {
  const msg = String(error?.message || error || "");
  if (parseRetryAfterMs(msg)) return true;
  if (/429|502|503|504|ETIMEDOUT|ECONNRESET|EAI_AGAIN/i.test(msg)) return true;
  return false;
}

function validateVoiceFile(filePath) {
  const absolutePath = path.resolve(String(filePath || "").trim());
  if (!absolutePath) throw new Error("Voice file path is required");
  if (!fs.existsSync(absolutePath)) throw new Error(`Voice file not found: ${absolutePath}`);
  const stat = fs.statSync(absolutePath);
  if (!stat.isFile()) throw new Error(`Voice path is not a file: ${absolutePath}`);
  if (stat.size <= 0) throw new Error(`Voice file is empty: ${absolutePath}`);

  const ext = path.extname(absolutePath).toLowerCase();
  if (!SUPPORTED_EXTENSIONS.has(ext)) {
    throw new Error(
      `Unsupported voice file format: ${ext || "(none)"}; expected one of ${Array.from(
        SUPPORTED_EXTENSIONS
      ).join(", ")}`
    );
  }

  const fd = fs.openSync(absolutePath, "r");
  try {
    const header = Buffer.alloc(4);
    const bytesRead = fs.readSync(fd, header, 0, 4, 0);
    if (bytesRead < 4 || header.toString("utf8") !== "OggS") {
      throw new Error(`Invalid OGG container header in ${absolutePath}`);
    }
  } finally {
    fs.closeSync(fd);
  }

  return absolutePath;
}

function sendVoiceOnce({ token, chatId, filePath, caption = "", timeoutMs = 30000, requestFn = null }) {
  const botToken = String(token || "").trim();
  const targetChatId = String(chatId || "").trim();
  if (!botToken) throw new Error("TELEGRAM_BOT_TOKEN is required");
  if (!targetChatId) throw new Error("chatId is required");

  const validatedPath = validateVoiceFile(filePath);
  const fileName = path.basename(validatedPath);
  const fileData = fs.readFileSync(validatedPath);
  const boundary = `----aiBotVoiceBoundary${Date.now()}${Math.random().toString(16).slice(2)}`;
  const parts = [];

  const appendField = (name, value) => {
    parts.push(
      Buffer.from(
        `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="${name}"\r\n\r\n` +
          `${String(value)}\r\n`
      )
    );
  };

  appendField("chat_id", targetChatId);
  if (caption) appendField("caption", caption);
  parts.push(
    Buffer.from(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="voice"; filename="${fileName}"\r\n` +
        "Content-Type: audio/ogg\r\n\r\n"
    )
  );
  parts.push(fileData);
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
  const body = Buffer.concat(parts);

  const options = {
    hostname: "api.telegram.org",
    path: `/bot${botToken}/sendVoice`,
    method: "POST",
    timeout: timeoutMs,
    headers: {
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
      "Content-Length": String(body.length),
    },
  };

  const runner =
    typeof requestFn === "function"
      ? requestFn
      : (reqOptions, reqBody) =>
          new Promise((resolve, reject) => {
            const req = https.request(reqOptions, (res) => {
              let raw = "";
              res.setEncoding("utf8");
              res.on("data", (chunk) => {
                raw += chunk;
              });
              res.on("end", () => {
                resolve({
                  statusCode: Number(res.statusCode || 0),
                  body: raw,
                });
              });
            });
            req.on("error", reject);
            req.on("timeout", () => {
              req.destroy(new Error(`sendVoice request timeout after ${timeoutMs}ms`));
            });
            req.write(reqBody);
            req.end();
          });

  return runner(options, body);
}

async function sendVoiceWithRetry({
  token,
  chatId,
  filePath,
  caption = "",
  maxAttempts = 3,
  baseDelayMs = 1500,
  timeoutMs = 30000,
  logger = () => {},
  sleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  requestFn = null,
}) {
  let lastError = null;
  const attempts = Math.max(1, Number(maxAttempts || 1));

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    logger("voice_send_attempt", { attempt, chatId: String(chatId), filePath: String(filePath) });
    try {
      const response = await sendVoiceOnce({
        token,
        chatId,
        filePath,
        caption,
        timeoutMs,
        requestFn,
      });
      const statusCode = Number(response?.statusCode || 0);
      const rawBody = String(response?.body || "");
      let parsed = null;
      try {
        parsed = JSON.parse(rawBody);
      } catch {
        parsed = null;
      }

      if (statusCode >= 200 && statusCode < 300 && parsed?.ok !== false) {
        logger("voice_send_success", { attempt, statusCode, chatId: String(chatId) });
        return { statusCode, body: rawBody };
      }

      const retryAfterSec = Number(parsed?.parameters?.retry_after || 0);
      const err = new Error(
        `Telegram voice send failed status=${statusCode} description=${parsed?.description || rawBody || "unknown"}`
      );
      lastError = err;
      const retryable = isRetryableStatusCode(statusCode) || retryAfterSec > 0;
      if (attempt >= attempts || !retryable) throw err;

      const waitMs = retryAfterSec > 0 ? retryAfterSec * 1000 : baseDelayMs * attempt;
      logger("voice_send_retry", {
        attempt,
        nextAttempt: attempt + 1,
        waitMs,
        statusCode,
      });
      await sleepFn(waitMs);
    } catch (error) {
      lastError = error;
      const retryable = shouldRetryError(error);
      if (attempt >= attempts || !retryable) {
        logger("voice_send_failed", {
          attempt,
          chatId: String(chatId),
          error: String(error?.message || error),
        });
        throw error;
      }
      const waitMs = parseRetryAfterMs(error?.message || "") || baseDelayMs * attempt;
      logger("voice_send_retry", {
        attempt,
        nextAttempt: attempt + 1,
        waitMs,
        error: String(error?.message || error),
      });
      await sleepFn(waitMs);
    }
  }

  throw lastError || new Error("Voice send failed without explicit error");
}

module.exports = {
  SUPPORTED_EXTENSIONS,
  parseRetryAfterMs,
  validateVoiceFile,
  sendVoiceOnce,
  sendVoiceWithRetry,
};
