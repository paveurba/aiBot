const TelegramBot = require("node-telegram-bot-api");
const fs = require("fs");

const { createStore } = require("./store");
const queueLib = require("./queue");
const { runAgent: runAgentDirect } = require("../agent_runner");
const { RuntimeOrchestrator } = require("./runtime_orchestrator");
const { AttachmentService } = require("./attachment_service");
const { CommandService } = require("./command_service");
const { stripStaleCoordinatorReply } = require("./reply_guard");

class TelegramBotApp {
  constructor(options) {
    this.token = String(options.token || "").trim();
    if (!this.token) throw new Error("Missing TELEGRAM_BOT_TOKEN in environment (.env).");

    this.workdir = options.workdir || process.cwd();
    this.logDir = options.logDir;
    this.logFile = options.logFile;
    this.errorLogFile = options.errorLogFile;

    this.codexBin = options.codexBin || "codex";
    this.claudeBin = options.claudeBin || "claude";
    this.defaultModel = options.defaultModel || null;
    this.requestTimeoutMs = Number(options.requestTimeoutMs || 180000);
    this.seenTtlMs = Number(options.seenTtlMs || 10 * 60 * 1000);
    this.reuseSessions = Boolean(options.reuseSessions);
    this.codexBypassSandbox = Boolean(options.codexBypassSandbox);

    this.allowlist = Array.isArray(options.allowlist) ? options.allowlist : [];
    this.allowGroups = Boolean(options.allowGroups);
    this.queueEnabled = queueLib.isQueueEnabled();
    this.agentAsyncAck = Boolean(options.agentAsyncAck);

    this.bot = new TelegramBot(this.token, { polling: true });
    this.seenMessages = new Map();
    this.store = createStore({
      settingsPath: options.settingsPath,
      sessionsPath: options.sessionsPath,
    });

    fs.mkdirSync(this.logDir, { recursive: true });

    this.orchestrator = new RuntimeOrchestrator({
      bot: this.bot,
      store: this.store,
      runAgent: (agent, opts) => this.runAgent(agent, opts),
      logInfo: (...parts) => this.logInfo(...parts),
      logError: (...parts) => this.logError(...parts),
      formatErr: (err) => this.formatErr(err),
      trimTelegram: (text) => this.trimTelegram(text),
      config: {
        MAX_WORKER_TASKS: Math.max(1, Number(options.maxWorkerTasks || 10)),
        REQUEST_TIMEOUT_MS: this.requestTimeoutMs,
        AGENT_QUEUE_WAIT_FOR_RESULT_MS: Number(options.agentQueueWaitForResultMs || this.requestTimeoutMs + 15000),
        STT_QUEUE_WAIT_FOR_RESULT_MS: Number(options.sttQueueWaitForResultMs || this.requestTimeoutMs + 15000),
        AGENT_ASYNC_ACK: this.agentAsyncAck,
        JOB_ATTEMPTS: Math.max(1, Number(options.jobAttempts || 2)),
        JOB_BACKOFF_MS: Math.max(0, Number(options.jobBackoffMs || 2000)),
        MAX_COORDINATOR_WORKERS_PER_REQUEST: Math.max(
          1,
          Number(options.maxCoordinatorWorkersPerRequest || process.env.MAX_COORDINATOR_WORKERS_PER_REQUEST || 1)
        ),
        REUSE_SESSIONS: this.reuseSessions,
      },
      queue: queueLib,
    });

    this.attachmentService = new AttachmentService({
      bot: this.bot,
      orchestrator: this.orchestrator,
      workdir: this.workdir,
      requestTimeoutMs: this.requestTimeoutMs,
      sanitizeFileName: (name, fallback) => this.sanitizeFileName(name, fallback),
      spawnEnv: () => this.spawnEnv(),
    });

    this.commandService = new CommandService({
      bot: this.bot,
      store: this.store,
      orchestrator: this.orchestrator,
      defaultModel: this.defaultModel,
      reuseSessions: this.reuseSessions,
      trimTelegram: (text) => this.trimTelegram(text),
      resolveAgent: (selection) => this.resolveAgent(selection),
      resolveCodexModel: (selection) => this.resolveCodexModel(selection),
      logInfo: (...parts) => this.logInfo(...parts),
      logError: (...parts) => this.logError(...parts),
    });
  }

  nowIso() {
    return new Date().toISOString();
  }

  appendLog(filePath, line) {
    try {
      fs.appendFileSync(filePath, `${line}\n`);
    } catch {
      // avoid throwing from logger path
    }
  }

  formatErr(err) {
    if (!err) return "(no error details)";
    if (err instanceof Error) return err.stack || err.message || String(err);
    return String(err);
  }

  logInfo(...parts) {
    const line = `[${this.nowIso()}] INFO ${parts.map((p) => String(p)).join(" ")}`;
    console.log(line);
    this.appendLog(this.logFile, line);
  }

  logError(...parts) {
    const line = `[${this.nowIso()}] ERROR ${parts.map((p) => String(p)).join(" ")}`;
    console.error(line);
    this.appendLog(this.errorLogFile, line);
  }

  summarizeMessage(msg) {
    const chatId = String(msg.chat?.id || "");
    const messageId = String(msg.message_id || "");
    const fromId = String(msg.from?.id || "");
    const type = msg.voice
      ? "voice"
      : msg.audio
      ? "audio"
      : msg.document
      ? "document"
      : Array.isArray(msg.photo)
      ? "photo"
      : "text";
    const text = String(msg.text || msg.caption || "").replace(/\s+/g, " ").slice(0, 120);
    return `chat=${chatId} msg=${messageId} from=${fromId} type=${type} text=\"${text}\"`;
  }

  buildRequestId(msg) {
    const chatId = String(msg.chat?.id || "chat");
    const messageId = String(msg.message_id || "msg");
    return `req-${chatId}-${messageId}-${Date.now()}`;
  }

  isAllowedUser(msg) {
    if (this.allowlist.length === 0) return true;
    return this.allowlist.includes(String(msg.from?.id || ""));
  }

  isAllowedChat(msg) {
    return this.allowGroups || msg.chat?.type === "private";
  }

  resolveAgent(selection) {
    return String(selection || "").trim().toLowerCase() === "claude" ? "claude" : "codex";
  }

  resolveCodexModel(selection) {
    const normalized = String(selection || "").trim().toLowerCase();
    if (!normalized || normalized === "codex" || normalized === "claude") return null;
    return selection;
  }

  spawnEnv() {
    const mergedPath =
      (process.env.BOT_PATH || "").trim() || process.env.PATH || "/usr/bin:/bin:/usr/sbin:/sbin";
    return { ...process.env, PATH: mergedPath };
  }

  isDuplicateMessage(msg) {
    const chatId = String(msg.chat?.id || "");
    const messageId = String(msg.message_id || "");
    if (!chatId || !messageId) return false;

    const key = `${chatId}:${messageId}`;
    const now = Date.now();
    for (const [k, ts] of this.seenMessages) {
      if (now - ts > this.seenTtlMs) this.seenMessages.delete(k);
    }
    if (this.seenMessages.has(key)) return true;
    this.seenMessages.set(key, now);
    return false;
  }

  trimTelegram(text) {
    const t = stripStaleCoordinatorReply(String(text || ""));
    return t.length > 4000 ? `${t.slice(0, 4000)}\n…(truncated)` : t;
  }

  sanitizeFileName(name, fallback = "file") {
    const base = String(name || "").trim() || fallback;
    return base.replace(/[^a-zA-Z0-9._-]/g, "_");
  }

  runAgent(agent, options) {
    return runAgentDirect(agent, {
      ...options,
      config: {
        WORKDIR: this.workdir,
        CODEX_BIN: this.codexBin,
        CLAUDE_BIN: this.claudeBin,
        REQUEST_TIMEOUT_MS: this.requestTimeoutMs,
        REUSE_SESSIONS: this.reuseSessions,
        CODEX_BYPASS_SANDBOX: this.codexBypassSandbox,
      },
    });
  }

  async handleMessage(msg) {
    const chatId = String(msg.chat?.id || "");
    if (!chatId || this.isDuplicateMessage(msg)) return;
    const requestId = this.buildRequestId(msg);

    this.logInfo("incoming", this.summarizeMessage(msg), `request_id=${requestId}`);

    if (!this.isAllowedChat(msg)) return;
    if (!this.isAllowedUser(msg)) {
      await this.bot.sendMessage(chatId, "Not allowed.");
      return;
    }

    let text = "";
    try {
      text = await this.attachmentService.buildPromptFromMessage(msg);
    } catch (e) {
      this.logError("attachment_processing_failed", this.summarizeMessage(msg), this.formatErr(e));
      await this.bot.sendMessage(
        chatId,
        this.trimTelegram(`Failed to process attachment: ${e.message || String(e)}`)
      );
      return;
    }

    if (!text) return;

    try {
      await this.commandService.handleMessage(chatId, text, {
        requestId,
        messageId: String(msg.message_id || ""),
        sourceType: msg.voice ? "voice" : msg.audio ? "audio" : "text",
      });
    } catch (e) {
      this.logError(`chat_job_failed chat=${chatId} request_id=${requestId}`, this.formatErr(e));
      await this.bot.sendMessage(chatId, `Error: ${(e.message || String(e)).slice(0, 3993)}`);
    }
  }

  start() {
    this.bot.on("message", async (msg) => {
      await this.handleMessage(msg);
    });

    this.bot.on("polling_error", (err) => {
      this.logError("polling_error", this.formatErr(err));
    });

    this.bot.on("webhook_error", (err) => {
      this.logError("webhook_error", this.formatErr(err));
    });

    process.on("uncaughtException", (err) => {
      this.logError("uncaughtException", this.formatErr(err));
    });

    process.on("unhandledRejection", (reason) => {
      this.logError("unhandledRejection", this.formatErr(reason));
    });

    this.logInfo("Telegram bot running.");
    this.logInfo("BOT_WORKDIR:", this.workdir);
    this.logInfo("Default model:", this.defaultModel || "(none)");
    this.logInfo("Reuse sessions:", this.reuseSessions);
    this.logInfo("Codex bypass sandbox:", this.codexBypassSandbox);
    this.logInfo("Groups allowed:", this.allowGroups);
    this.logInfo("Allowlist:", this.allowlist.length ? this.allowlist.join(", ") : "(empty -> allows all)");
    this.logInfo("Queue enabled:", this.queueEnabled);
    this.logInfo("Queue async ack:", this.agentAsyncAck);
  }
}

module.exports = {
  TelegramBotApp,
};
