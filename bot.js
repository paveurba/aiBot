require("dotenv").config();

const path = require("path");
const fs = require("fs");
const { TelegramBotApp } = require("./lib/telegram_bot_app");

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error("Missing TELEGRAM_BOT_TOKEN in environment (.env).");
  process.exit(1);
}

const workdir = process.env.BOT_WORKDIR || process.cwd();
const settingsPath = path.join(__dirname, "settings.json");
const sessionsPath = path.join(__dirname, "sessions.json");
const logDir = (process.env.BOT_LOG_DIR || path.join(__dirname, "logs")).trim();
const logFile = (process.env.BOT_LOG_FILE || path.join(logDir, "bot.log")).trim();
const errorLogFile = (process.env.BOT_ERROR_LOG_FILE || path.join(logDir, "bot.error.log")).trim();

const allowlist = (process.env.TELEGRAM_ALLOWLIST || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const singletonLockPath = String(process.env.BOT_SINGLETON_LOCK || "/tmp/aibot-telegram-polling.lock").trim();
let singletonLockFd = null;

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function releaseSingletonLock() {
  try {
    if (singletonLockFd !== null) fs.closeSync(singletonLockFd);
  } catch {
    // ignore
  }
  singletonLockFd = null;
  try {
    fs.rmSync(singletonLockPath, { force: true });
  } catch {
    // ignore
  }
}

function acquireSingletonLock() {
  const writeLockFile = () => {
    singletonLockFd = fs.openSync(singletonLockPath, "wx");
    fs.writeFileSync(singletonLockFd, String(process.pid), "utf8");
  };

  try {
    writeLockFile();
  } catch (e) {
    if (e?.code !== "EEXIST") throw e;
    let existingPid = null;
    try {
      const raw = fs.readFileSync(singletonLockPath, "utf8").trim();
      existingPid = Number(raw);
    } catch {
      // ignore
    }
    if (existingPid && Number.isFinite(existingPid) && processExists(existingPid)) {
      console.error(`Another bot polling process is running (pid=${existingPid}). Exiting.`);
      process.exit(1);
    }
    try {
      fs.rmSync(singletonLockPath, { force: true });
    } catch {
      // ignore
    }
    writeLockFile();
  }
}

acquireSingletonLock();
process.on("exit", releaseSingletonLock);
process.on("SIGINT", () => {
  releaseSingletonLock();
  process.exit(0);
});
process.on("SIGTERM", () => {
  releaseSingletonLock();
  process.exit(0);
});

const app = new TelegramBotApp({
  token,
  workdir,
  settingsPath,
  sessionsPath,
  logDir,
  logFile,
  errorLogFile,
  codexBin: (process.env.CODEX_BIN || "codex").trim(),
  claudeBin: (process.env.CLAUDE_BIN || "claude").trim(),
  defaultModel: (process.env.DEFAULT_MODEL || "").trim() || null,
  requestTimeoutMs: Number(process.env.REQUEST_TIMEOUT_MS || 180000),
  seenTtlMs: Number(process.env.SEEN_TTL_MS || 10 * 60 * 1000),
  reuseSessions: String(process.env.REUSE_SESSIONS || "1") === "1",
  codexBypassSandbox: String(process.env.CODEX_BYPASS_SANDBOX || "1") === "1",
  maxWorkerTasks: Math.max(1, Number(process.env.MAX_WORKER_TASKS || 10)),
  agentQueueWaitForResultMs: Number(
    process.env.AGENT_QUEUE_WAIT_FOR_RESULT_MS || Number(process.env.REQUEST_TIMEOUT_MS || 180000) + 15000
  ),
  sttQueueWaitForResultMs: Number(
    process.env.STT_QUEUE_WAIT_FOR_RESULT_MS || Number(process.env.REQUEST_TIMEOUT_MS || 180000) + 15000
  ),
  agentAsyncAck: String(process.env.AGENT_ASYNC_ACK || "1") === "1",
  jobAttempts: Math.max(1, Number(process.env.JOB_ATTEMPTS || 2)),
  jobBackoffMs: Math.max(0, Number(process.env.JOB_BACKOFF_MS || 2000)),
  maxCoordinatorWorkersPerRequest: Math.max(1, Number(process.env.MAX_COORDINATOR_WORKERS_PER_REQUEST || 1)),
  allowlist,
  allowGroups: String(process.env.ALLOW_GROUPS || "0") === "1",
});

app.start();
