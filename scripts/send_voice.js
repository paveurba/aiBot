#!/usr/bin/env node
require("dotenv").config();

const fs = require("fs");
const path = require("path");
const { sendVoiceWithRetry, validateVoiceFile } = require("../lib/voice_delivery");

function usage() {
  const msg = [
    "Usage:",
    "  node scripts/send_voice.js --file /tmp/voice.ogg [--chat-id 12345] [--caption \"...\"]",
    "",
    "Options:",
    "  --file       Required. Path to OGG/Opus voice file.",
    "  --chat-id    Optional. Defaults to first TELEGRAM_ALLOWLIST id.",
    "  --caption    Optional caption.",
  ].join("\n");
  process.stderr.write(`${msg}\n`);
}

function parseArgs(argv) {
  const result = { file: "", chatId: "", caption: "" };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--file") {
      result.file = String(argv[i + 1] || "");
      i += 1;
      continue;
    }
    if (arg === "--chat-id") {
      result.chatId = String(argv[i + 1] || "");
      i += 1;
      continue;
    }
    if (arg === "--caption") {
      result.caption = String(argv[i + 1] || "");
      i += 1;
      continue;
    }
    if (arg === "-h" || arg === "--help") {
      result.help = true;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return result;
}

function appendVoiceLog(logFilePath, event, fields = {}) {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    event,
    ...fields,
  });
  fs.appendFileSync(logFilePath, `${line}\n`);
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    usage();
    process.exit(1);
    return;
  }

  if (args.help) {
    usage();
    process.exit(0);
    return;
  }

  const token = String(process.env.TELEGRAM_BOT_TOKEN || "").trim();
  const chatId = String(args.chatId || process.env.TELEGRAM_ALLOWLIST?.split(",")[0] || "").trim();
  const logFile = String(process.env.VOICE_SEND_LOG_FILE || "/home/pi/aiBot/logs/voice-send.log").trim();
  const maxAttempts = Math.max(1, Number(process.env.VOICE_SEND_MAX_ATTEMPTS || 3));
  const baseDelayMs = Math.max(100, Number(process.env.VOICE_SEND_RETRY_BASE_MS || 1500));
  const timeoutMs = Math.max(1000, Number(process.env.VOICE_SEND_TIMEOUT_MS || 30000));

  if (!token) throw new Error("Missing TELEGRAM_BOT_TOKEN in environment");
  if (!chatId) throw new Error("Missing chat id (use --chat-id or TELEGRAM_ALLOWLIST)");
  if (!args.file) throw new Error("Missing --file argument");

  const filePath = validateVoiceFile(args.file);
  const logDir = path.dirname(logFile);
  fs.mkdirSync(logDir, { recursive: true });

  const logger = (event, fields) => appendVoiceLog(logFile, event, fields);
  logger("voice_send_start", { chatId, filePath, maxAttempts, timeoutMs });

  try {
    await sendVoiceWithRetry({
      token,
      chatId,
      filePath,
      caption: args.caption || "",
      maxAttempts,
      baseDelayMs,
      timeoutMs,
      logger,
    });
  } catch (error) {
    logger("voice_send_exit_failure", {
      chatId,
      filePath,
      error: String(error?.message || error),
    });
    throw error;
  }

  logger("voice_send_exit_success", { chatId, filePath });
  process.stdout.write(`Voice message sent to chat_id=${chatId}\n`);
}

main().catch((error) => {
  process.stderr.write(`${String(error?.message || error)}\n`);
  process.exit(1);
});
