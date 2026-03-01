const fs = require("fs");
const https = require("https");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

class RuntimeOrchestrator {
  constructor(options) {
    this.bot = options.bot;
    this.store = options.store;
    this.runAgent = options.runAgent;
    this.logInfo = options.logInfo;
    this.logError = options.logError;
    this.formatErr = options.formatErr;
    this.trimTelegram = options.trimTelegram;
    this.config = options.config;
    this.queue = options.queue;

    this.agentQueue = null;
    this.agentQueueEvents = null;
    this.sttQueue = null;
    this.sttQueueEvents = null;
    this.notifyQueue = null;
    this.notifyQueueEvents = null;
    this.queueInitPromise = null;
    this.queueReady = false;
    this.pendingSingleWorkerDispatches = [];
    this.singleWorkerDispatchPumpRunning = false;
    this.workerCursorByChatAgent = new Map();
    this.workerLocks = new Map();
    this.taskStates = new Map();
    this.taskHeartbeatTimers = new Map();
    this.latestVoiceRequestByChat = new Map();
    this.taskSequence = 0;
    this.lastQueueInitAttemptMs = 0;
    this.queueRetryIntervalMs = Math.max(1000, Number(process.env.QUEUE_INIT_RETRY_MS || 5000));
    this.telegramMinSendIntervalMs = Math.max(0, Number(process.env.TELEGRAM_MIN_SEND_INTERVAL_MS || 200));
    this.telegramSendMaxAttempts = Math.max(1, Number(process.env.TELEGRAM_SEND_MAX_ATTEMPTS || 4));
    this.nextTelegramSendByChat = new Map();
  }

  workerLockKey(chatId, agent, workerId) {
    return `${String(chatId)}:${String(agent)}:${Number(workerId)}`;
  }

  isTerminalTaskState(state) {
    return state === "done" || state === "failed";
  }

  generateTaskId(chatId, agent, workerId) {
    this.taskSequence += 1;
    return [
      "task",
      Date.now(),
      this.taskSequence,
      String(chatId),
      String(agent),
      Number(workerId),
      Math.random().toString(36).slice(2, 8),
    ].join("-");
  }

  updateTaskState(taskId, nextState, extra = {}) {
    const prev = this.taskStates.get(taskId);
    if (!prev) return;

    const now = Date.now();
    const updated = {
      ...prev,
      ...extra,
      state: nextState,
      updatedAt: now,
    };
    if (nextState === "running" && !updated.startedAt) updated.startedAt = now;
    if (this.isTerminalTaskState(nextState)) updated.finishedAt = now;

    this.taskStates.set(taskId, updated);
    const lockKey = this.workerLockKey(updated.chatId, updated.agent, updated.workerId);
    const lock = this.workerLocks.get(lockKey);
    if (lock && lock.taskId === taskId) {
      this.workerLocks.set(lockKey, {
        ...lock,
        state: nextState,
        updatedAt: now,
        attempt: updated.attempt || lock.attempt || 0,
        lastError: updated.lastError || null,
      });
    }
  }

  touchTaskHeartbeat(taskId) {
    const prev = this.taskStates.get(taskId);
    if (!prev) return;

    const now = Date.now();
    this.taskStates.set(taskId, {
      ...prev,
      updatedAt: now,
    });

    const lockKey = this.workerLockKey(prev.chatId, prev.agent, prev.workerId);
    const lock = this.workerLocks.get(lockKey);
    if (lock && lock.taskId === taskId) {
      this.workerLocks.set(lockKey, {
        ...lock,
        updatedAt: now,
      });
    }
  }

  startTaskHeartbeat(taskId, intervalMs = 10000) {
    if (!taskId) return () => {};
    const existing = this.taskHeartbeatTimers.get(taskId);
    if (existing) clearInterval(existing);

    this.touchTaskHeartbeat(taskId);
    const interval = setInterval(() => {
      this.touchTaskHeartbeat(taskId);
    }, Math.max(1000, Number(intervalMs || 10000)));
    interval.unref?.();
    this.taskHeartbeatTimers.set(taskId, interval);

    return () => {
      const timer = this.taskHeartbeatTimers.get(taskId);
      if (timer) {
        clearInterval(timer);
        this.taskHeartbeatTimers.delete(taskId);
      }
    };
  }

  acquireWorkerLock({ chatId, agent, workerId, task, attemptsMax, timeoutMs }) {
    const lockKey = this.workerLockKey(chatId, agent, workerId);
    const existing = this.workerLocks.get(lockKey);
    if (existing && !this.isTerminalTaskState(existing.state)) return null;

    const taskId = this.generateTaskId(chatId, agent, workerId);
    const now = Date.now();
    const record = {
      taskId,
      chatId: String(chatId),
      agent: String(agent),
      workerId: Number(workerId),
      task: String(task || ""),
      state: "pending",
      createdAt: now,
      updatedAt: now,
      startedAt: null,
      finishedAt: null,
      attempt: 0,
      attemptsMax: Math.max(1, Number(attemptsMax || 1)),
      timeoutMs: Math.max(1000, Number(timeoutMs || this.config.REQUEST_TIMEOUT_MS)),
      lastError: null,
      jobId: null,
    };
    this.taskStates.set(taskId, record);
    this.workerLocks.set(lockKey, {
      taskId,
      chatId: String(chatId),
      agent: String(agent),
      workerId: Number(workerId),
      state: "pending",
      updatedAt: now,
      attempt: 0,
      lastError: null,
    });
    return record;
  }

  releaseWorkerLock(chatId, agent, workerId, taskId) {
    const lockKey = this.workerLockKey(chatId, agent, workerId);
    const existing = this.workerLocks.get(lockKey);
    if (!existing) return;
    if (taskId && existing.taskId !== taskId) return;
    this.workerLocks.delete(lockKey);
    this.scheduleSingleWorkerDispatchPump();
  }

  chooseIdleWorkerId({ chatId, agent, preferredWorkerId, reservedWorkerIds }) {
    const reserved = reservedWorkerIds || new Set();
    const candidates = [];
    if (Number.isInteger(preferredWorkerId) && preferredWorkerId >= 2 && preferredWorkerId <= this.config.MAX_WORKER_TASKS) {
      candidates.push(preferredWorkerId);
    }
    for (let id = 2; id <= this.config.MAX_WORKER_TASKS; id += 1) {
      if (!candidates.includes(id)) candidates.push(id);
    }

    for (const workerId of candidates) {
      if (reserved.has(workerId)) continue;
      const lockKey = this.workerLockKey(chatId, agent, workerId);
      const existing = this.workerLocks.get(lockKey);
      if (!existing || this.isTerminalTaskState(existing.state)) return workerId;
    }
    return null;
  }

  nextPreferredWorkerId(chatId, agent) {
    const maxWorker = Math.max(2, Number(this.config.MAX_WORKER_TASKS || 10));
    const key = `${String(chatId)}:${String(agent || "codex")}`;
    const prev = Number(this.workerCursorByChatAgent.get(key) || 1);
    let next = prev + 1;
    if (next < 2 || next > maxWorker) next = 2;
    this.workerCursorByChatAgent.set(key, next);
    return next;
  }

  countPendingSingleWorkerDispatches(chatId, agent = null) {
    const chatKey = String(chatId);
    const agentKey = agent ? String(agent) : null;
    return this.pendingSingleWorkerDispatches.filter(
      (item) => String(item.chatId) === chatKey && (!agentKey || String(item.agent) === agentKey)
    ).length;
  }

  scheduleSingleWorkerDispatchPump() {
    Promise.resolve()
      .then(() => this.pumpPendingSingleWorkerDispatches())
      .catch((e) => {
        this.logError("single_worker_dispatch_pump_failed", this.formatErr(e));
      });
  }

  async dispatchSingleWorkerRequest({ chatId, agent, codexModel, goal, requestId = null }) {
    const chatKey = String(chatId);
    const model = String(agent || "codex");
    const taskText = String(goal || "").trim();
    if (!taskText) {
      return { status: "rejected", reason: "empty_goal" };
    }

    const preferredWorkerId = this.nextPreferredWorkerId(chatKey, model);
    const workerId = this.chooseIdleWorkerId({
      chatId: chatKey,
      agent: model,
      preferredWorkerId,
      reservedWorkerIds: new Set(),
    });
    if (workerId) {
      const taskMeta = this.acquireWorkerLock({
        chatId: chatKey,
        agent: model,
        workerId,
        task: taskText,
        attemptsMax: this.config.JOB_ATTEMPTS,
        timeoutMs: this.config.REQUEST_TIMEOUT_MS,
      });
      if (taskMeta) {
        this.dispatchSingleWorkerMeta({
          ...taskMeta,
          workerId,
          prompt: taskText,
          codexModel: codexModel || null,
          requestId: requestId || null,
        });
        return { status: "dispatched", workerId };
      }
    }

    this.pendingSingleWorkerDispatches.push({
      chatId: chatKey,
      agent: model,
      codexModel: codexModel || null,
      goal: taskText,
      requestId: requestId || null,
      enqueuedAt: Date.now(),
    });
    const position = this.countPendingSingleWorkerDispatches(chatKey, model);
    this.logInfo(
      `single_worker_request_queued chat=${chatKey} agent=${model} request_id=${requestId || "n/a"} position=${position}`
    );
    return { status: "queued", position };
  }

  dispatchSingleWorkerMeta(meta) {
    const chatKey = String(meta.chatId);
    const model = String(meta.agent || "codex");
    const requestTag = meta.requestId ? ` request_id=${meta.requestId}` : "";
    this.logInfo(`single_worker_dispatch_start chat=${chatKey} agent=${model} worker=${meta.workerId}${requestTag}`);
    Promise.resolve()
      .then(async () => {
        const item = await this.executeInlineTaskWithRetry(meta);
        this.logInfo(`single_worker_dispatch_done chat=${chatKey} agent=${model} worker=${item.workerId}${requestTag}`);
        const out = this.trimTelegram(`worker-${item.workerId} [${model}]\n${item.reply}`);
        const sentDirect = await this.sendDirectWithRetry(chatKey, out, this.telegramSendMaxAttempts);
        if (!sentDirect) {
          await this.sendReply(chatKey, out, { requestId: meta.requestId || null });
          this.logInfo(`single_worker_dispatch_reply_queued chat=${chatKey} agent=${model} worker=${item.workerId}${requestTag}`);
        }
      })
      .catch(async (e) => {
        this.logError(
          `single_worker_dispatch_failed chat=${chatKey} agent=${model} worker=${meta.workerId}${requestTag}`,
          this.formatErr(e)
        );
        const out = this.trimTelegram(`worker-${meta.workerId} [${model}] failed: ${e?.message || String(e)}`);
        const sentDirect = await this.sendDirectWithRetry(chatKey, out, this.telegramSendMaxAttempts);
        if (!sentDirect) {
          await this.sendReply(chatKey, out, { requestId: meta.requestId || null });
        }
      })
      .finally(() => {
        this.scheduleSingleWorkerDispatchPump();
      });
  }

  async pumpPendingSingleWorkerDispatches() {
    if (this.singleWorkerDispatchPumpRunning) return;
    this.singleWorkerDispatchPumpRunning = true;
    try {
      let dispatched = true;
      while (dispatched) {
        dispatched = false;
        for (let i = 0; i < this.pendingSingleWorkerDispatches.length; i += 1) {
          const pending = this.pendingSingleWorkerDispatches[i];
          const preferredWorkerId = this.nextPreferredWorkerId(pending.chatId, pending.agent);
          const workerId = this.chooseIdleWorkerId({
            chatId: pending.chatId,
            agent: pending.agent,
            preferredWorkerId,
            reservedWorkerIds: new Set(),
          });
          if (!workerId) continue;
          const taskMeta = this.acquireWorkerLock({
            chatId: pending.chatId,
            agent: pending.agent,
            workerId,
            task: pending.goal,
            attemptsMax: this.config.JOB_ATTEMPTS,
            timeoutMs: this.config.REQUEST_TIMEOUT_MS,
          });
          if (!taskMeta) continue;
          this.pendingSingleWorkerDispatches.splice(i, 1);
          i -= 1;
          dispatched = true;
          this.dispatchSingleWorkerMeta({
            ...taskMeta,
            workerId,
            prompt: pending.goal,
            codexModel: pending.codexModel || null,
            requestId: pending.requestId || null,
          });
        }
      }
    } finally {
      this.singleWorkerDispatchPumpRunning = false;
    }
  }

  async withTaskTimeout(promise, timeoutMs, taskId) {
    let timeoutHandle = null;
    const timeoutPromise = new Promise((_, reject) => {
      timeoutHandle = setTimeout(() => {
        const err = new Error(`Task timed out after ${timeoutMs}ms`);
        err.code = "TASK_TIMEOUT";
        err.taskId = taskId;
        reject(err);
      }, timeoutMs);
    });

    try {
      return await Promise.race([promise, timeoutPromise]);
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
    }
  }

  async initQueueClients() {
    if (this.queueReady && this.agentQueue && this.agentQueueEvents) return true;
    if (!this.queue.isQueueEnabled()) return false;
    if (this.queueInitPromise) return this.queueInitPromise;
    const now = Date.now();
    if (now - this.lastQueueInitAttemptMs < this.queueRetryIntervalMs) return false;
    this.lastQueueInitAttemptMs = now;

    this.queueInitPromise = (async () => {
      try {
        this.agentQueue = this.queue.createAgentQueue();
        this.agentQueueEvents = this.queue.createAgentQueueEvents();
        this.sttQueue = this.queue.createSttQueue();
        this.sttQueueEvents = this.queue.createSttQueueEvents();
        this.notifyQueue = this.queue.createNotifyQueue();
        this.notifyQueueEvents = this.queue.createNotifyQueueEvents();
        await this.agentQueueEvents.waitUntilReady();
        await this.agentQueue.waitUntilReady();
        await this.sttQueueEvents.waitUntilReady();
        await this.sttQueue.waitUntilReady();
        await this.notifyQueueEvents.waitUntilReady();
        await this.notifyQueue.waitUntilReady();
        this.queueReady = true;
        this.logInfo("BullMQ queue ready");
        return true;
      } catch (e) {
        this.logError("queue_init_failed", this.formatErr(e));
        this.queueReady = false;
        this.agentQueue = null;
        this.agentQueueEvents = null;
        this.sttQueue = null;
        this.sttQueueEvents = null;
        this.notifyQueue = null;
        this.notifyQueueEvents = null;
        return false;
      } finally {
        this.queueInitPromise = null;
      }
    })();

    return this.queueInitPromise;
  }

  async getQueueDiagnostics() {
    const queueEnabled = this.queue.isQueueEnabled();
    const queueReady = await this.initQueueClients();
    const diagnostics = {
      enabled: queueEnabled,
      ready: queueReady,
      agent: null,
      stt: null,
      notify: null,
    };

    const buildQueueSnapshot = async (queueInstance) => {
      if (!queueInstance || typeof queueInstance.getJobCounts !== "function") {
        return {
          workersOnline: false,
          counts: null,
        };
      }

      const workersOnline = await this.queueHasWorkers(queueInstance);
      let counts = null;
      try {
        counts = await queueInstance.getJobCounts(
          "active",
          "waiting",
          "delayed",
          "completed",
          "failed",
          "paused",
          "prioritized"
        );
      } catch (e) {
        this.logError("queue_counts_failed", this.formatErr(e));
      }

      return {
        workersOnline,
        counts,
      };
    };

    diagnostics.agent = await buildQueueSnapshot(this.agentQueue);
    diagnostics.stt = await buildQueueSnapshot(this.sttQueue);
    diagnostics.notify = await buildQueueSnapshot(this.notifyQueue);
    return diagnostics;
  }

  async getManagerDiagnostics(chatId, options = {}) {
    const scope = String(options.scope || "global").trim().toLowerCase() === "chat" ? "chat" : "global";
    const queue = await this.getQueueDiagnostics();
    const uptimeSec = Math.floor(process.uptime());
    const memory = process.memoryUsage();
    const resolvedAgent = "codex";
    const now = Date.now();
    const lockDiagnostics = [];
    for (const lock of this.workerLocks.values()) {
      if (scope === "chat" && String(lock?.chatId || "") !== String(chatId)) continue;
      const task = lock?.taskId ? this.taskStates.get(lock.taskId) : null;
      const acquiredAtMs = Number(task?.createdAt || lock?.updatedAt || now);
      const ttlMs = Math.max(0, Number(task?.timeoutMs || this.config.AGENT_QUEUE_WAIT_FOR_RESULT_MS || 0));
      const ageMs = Math.max(0, now - acquiredAtMs);
      const staleLock = Boolean(!this.isTerminalTaskState(lock?.state) && ttlMs > 0 && ageMs > ttlMs);
      lockDiagnostics.push({
        taskId: lock?.taskId || null,
        lockOwner: `${lock?.agent || "unknown"}:worker-${Number(lock?.workerId || 0)}`,
        chatId: String(lock?.chatId || ""),
        workerId: Number(lock?.workerId || 0),
        state: String(lock?.state || "unknown"),
        acquiredAt: new Date(acquiredAtMs).toISOString(),
        ttlMs,
        ttlRemainingMs: Math.max(0, ttlMs - ageMs),
        staleLock,
        attempt: Number(lock?.attempt || 0),
        lastError: lock?.lastError || null,
      });
    }

    const workers =
      scope === "chat"
        ? this.buildWorkerStatusList(chatId, resolvedAgent)
        : this.buildGlobalWorkerStatusList();
    const workersBusy = workers.filter((w) => w.state !== "idle").length;
    return {
      timestamp: new Date().toISOString(),
      scope,
      chatId: String(chatId),
      agent: resolvedAgent,
      coordinator: {
        active: false,
        token: null,
        startedAt: null,
        goal: null,
        activeCount: 0,
        activeDispatches: [],
      },
      codexWorkerStatus: {
        workersOnline: Boolean(queue.agent?.workersOnline),
        activeJobs: Number(queue.agent?.counts?.active || 0),
        waitingJobs: Number(queue.agent?.counts?.waiting || 0),
        failedJobs: Number(queue.agent?.counts?.failed || 0),
      },
      workers: {
        total: workers.length,
        busy: workersBusy,
        idle: Math.max(0, workers.length - workersBusy),
        list: workers,
      },
      locks: lockDiagnostics.sort((a, b) => a.workerId - b.workerId),
      queue,
      runtime: {
        pid: process.pid,
        uptimeSec,
        memoryRssMb: Math.round((memory.rss / (1024 * 1024)) * 100) / 100,
        requestTimeoutMs: this.config.REQUEST_TIMEOUT_MS,
      },
    };
  }

  buildGlobalWorkerStatusList() {
    const maxWorkers = Math.max(2, Number(this.config.MAX_WORKER_TASKS || 10));
    const workers = [];

    for (let workerId = 2; workerId <= maxWorkers; workerId += 1) {
      const activeLocks = [];
      for (const lock of this.workerLocks.values()) {
        if (Number(lock?.workerId) !== workerId) continue;
        if (this.isTerminalTaskState(lock?.state)) continue;
        activeLocks.push(lock);
      }
      const latestHeartbeatMs =
        activeLocks.length > 0
          ? Math.max(...activeLocks.map((lock) => Number(lock?.updatedAt || 0)))
          : null;
      workers.push({
        workerId,
        state: activeLocks.length > 0 ? "running" : "idle",
        currentTaskId: activeLocks[0]?.taskId || null,
        activeLocks: activeLocks.length,
        activeChats: Array.from(new Set(activeLocks.map((lock) => String(lock?.chatId || ""))).values()).filter(Boolean),
        activeAgents: Array.from(new Set(activeLocks.map((lock) => String(lock?.agent || ""))).values()).filter(Boolean),
        taskIds: activeLocks.map((lock) => String(lock?.taskId || "")).filter(Boolean),
        lastHeartbeatMs: latestHeartbeatMs || null,
        lastHeartbeatIso: latestHeartbeatMs ? new Date(latestHeartbeatMs).toISOString() : null,
      });
    }

    return workers;
  }

  buildWorkerStatusList(chatId, agent) {
    const chat = String(chatId);
    const model = String(agent || "codex");
    const maxWorkers = Math.max(2, Number(this.config.MAX_WORKER_TASKS || 10));
    const workers = [];

    for (let workerId = 2; workerId <= maxWorkers; workerId += 1) {
      const lockKey = this.workerLockKey(chat, model, workerId);
      const lock = this.workerLocks.get(lockKey);
      const lockBusy = Boolean(lock && !this.isTerminalTaskState(lock.state));

      let latestTask = null;
      for (const task of this.taskStates.values()) {
        if (String(task.chatId) !== chat) continue;
        if (String(task.agent) !== model) continue;
        if (Number(task.workerId) !== workerId) continue;
        if (!latestTask || Number(task.updatedAt || 0) > Number(latestTask.updatedAt || 0)) {
          latestTask = task;
        }
      }

      const heartbeatMs = Number((lockBusy ? lock?.updatedAt : latestTask?.updatedAt) || 0) || null;
      workers.push({
        workerId,
        state: lockBusy ? String(lock.state || "running") : "idle",
        currentTaskId: lockBusy ? String(lock.taskId || "") || null : null,
        lastHeartbeatMs: heartbeatMs,
        lastHeartbeatIso: heartbeatMs ? new Date(heartbeatMs).toISOString() : null,
      });
    }

    return workers;
  }

  async queueHasWorkers(queueInstance) {
    if (!queueInstance || typeof queueInstance.getWorkersCount !== "function") return false;
    try {
      return Number(await queueInstance.getWorkersCount()) > 0;
    } catch (e) {
      this.logError("queue_workers_count_failed", this.formatErr(e));
      return false;
    }
  }

  buildJobOptions(timeoutMs) {
    return {
      attempts: this.config.JOB_ATTEMPTS,
      backoff:
        this.config.JOB_BACKOFF_MS > 0
          ? { type: "exponential", delay: this.config.JOB_BACKOFF_MS }
          : undefined,
      timeout: timeoutMs,
    };
  }

  async sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async throttleTelegramSend(chatId) {
    const key = String(chatId);
    const now = Date.now();
    const nextAllowedAt = Number(this.nextTelegramSendByChat.get(key) || 0);
    if (nextAllowedAt > now) {
      await this.sleep(nextAllowedAt - now);
    }
    this.nextTelegramSendByChat.set(key, Date.now() + this.telegramMinSendIntervalMs);
  }

  parseRetryAfterMs(message) {
    const m = String(message || "").match(/retry after\s+(\d+)/i);
    if (!m) return null;
    const sec = Number(m[1]);
    if (!Number.isFinite(sec) || sec <= 0) return null;
    return sec * 1000;
  }

  async sendDirectWithRetry(chatId, text, attempts = null) {
    let lastErr = null;
    const maxAttempts = Math.max(1, Number(attempts || this.telegramSendMaxAttempts));
    for (let i = 1; i <= maxAttempts; i += 1) {
      try {
        await this.throttleTelegramSend(chatId);
        await this.bot.sendMessage(chatId, text);
        return true;
      } catch (e) {
        lastErr = e;
        const msg = e?.message || String(e);
        const retryAfterMs = this.parseRetryAfterMs(msg);
        const transient = /429|502|503|504|ETIMEDOUT|ECONNRESET|EAI_AGAIN/i.test(msg);
        if (i >= maxAttempts || (!transient && !retryAfterMs)) break;
        await this.sleep(retryAfterMs || i * 1500);
      }
    }
    this.logError("send_direct_failed", `chat=${chatId}`, this.formatErr(lastErr));
    return false;
  }

  async sendReply(chatId, text, options = {}) {
    const queueReady = await this.initQueueClients();
    if (!queueReady || !this.notifyQueue || !(await this.queueHasWorkers(this.notifyQueue))) {
      const sent = await this.sendDirectWithRetry(chatId, text, this.telegramSendMaxAttempts);
      if (!sent) {
        const err = new Error("notify send failed and direct fallback failed");
        this.logError("send_reply_delivery_failed", `chat=${chatId}`, options?.requestId ? `request_id=${options.requestId}` : "", err.message);
        throw err;
      }
      return;
    }
    await this.notifyQueue.add(
      "notify.send",
      { chatId: String(chatId), text: String(text), requestId: options?.requestId ? String(options.requestId) : null },
      this.buildJobOptions(30000)
    );
  }

  async sendVoiceFile(chatId, filePath, caption = "") {
    const normalizedPath = String(filePath || "").trim();
    if (!normalizedPath || !fs.existsSync(normalizedPath)) {
      throw new Error("Voice file missing");
    }

    let lastErr = null;
    const maxAttempts = this.telegramSendMaxAttempts;
    for (let i = 1; i <= maxAttempts; i += 1) {
      try {
        await this.throttleTelegramSend(chatId);
        await this.bot.sendVoice(String(chatId), normalizedPath, caption ? { caption: String(caption) } : {});
        return;
      } catch (e) {
        lastErr = e;
        const msg = e?.message || String(e);
        const retryAfterMs = this.parseRetryAfterMs(msg);
        const transient = /429|502|503|504|ETIMEDOUT|ECONNRESET|EAI_AGAIN/i.test(msg);
        if (i >= maxAttempts || (!transient && !retryAfterMs)) break;
        await this.sleep(retryAfterMs || i * 1500);
      }
    }
    throw lastErr || new Error("Failed to send voice");
  }

  async synthesizeVoiceWithOpenAI(text) {
    const apiKey = String(process.env.OPENAI_API_KEY || "").trim();
    if (!apiKey) return null;

    const model = String(process.env.OPENAI_TTS_MODEL || "tts-1").trim();
    const voice = String(process.env.OPENAI_TTS_VOICE || "alloy").trim();
    const responseFormat = String(process.env.OPENAI_TTS_FORMAT || "mp3").trim().toLowerCase();
    const input = String(text || "").trim();
    if (!input) return null;

    const body = JSON.stringify({
      model,
      voice,
      input: input.slice(0, 3500),
      response_format: responseFormat,
    });

    const bin = await new Promise((resolve, reject) => {
      const req = https.request(
        {
          hostname: "api.openai.com",
          path: "/v1/audio/speech",
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(body),
          },
        },
        (res) => {
          const chunks = [];
          res.on("data", (chunk) => chunks.push(chunk));
          res.on("end", () => {
            const data = Buffer.concat(chunks);
            if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
              return resolve(data);
            }
            reject(new Error(`OpenAI TTS HTTP ${res.statusCode || "unknown"}: ${data.toString("utf8")}`));
          });
        }
      );
      req.on("error", reject);
      req.write(body);
      req.end();
    });

    const tempDir = path.join(os.tmpdir(), "ai-bot-tts");
    fs.mkdirSync(tempDir, { recursive: true });
    const ext = responseFormat === "opus" ? "opus" : responseFormat === "wav" ? "wav" : "mp3";
    const outPath = path.join(tempDir, `tts-${Date.now()}-${Math.random().toString(16).slice(2)}.${ext}`);
    fs.writeFileSync(outPath, bin);
    return outPath;
  }

  synthesizeVoiceWithLocalScript(text) {
    const scriptPath = String(
      process.env.LOCAL_TTS_SCRIPT || path.resolve(__dirname, "../scripts/tts_to_telegram_voice.sh")
    ).trim();
    if (!scriptPath || !fs.existsSync(scriptPath)) return null;

    const tempDir = path.join(os.tmpdir(), "ai-bot-tts");
    fs.mkdirSync(tempDir, { recursive: true });
    const outPath = path.join(tempDir, `voice-local-${Date.now()}-${Math.random().toString(16).slice(2)}.ogg`);
    const lang = String(process.env.TTS_LANG || "en").trim();
    const result = spawnSync(
      scriptPath,
      ["--text", String(text || ""), "--output", outPath, "--lang", lang],
      {
        cwd: process.env.BOT_WORKDIR || process.cwd(),
        env: process.env,
        encoding: "utf8",
        timeout: 120000,
        maxBuffer: 8 * 1024 * 1024,
      }
    );

    if (result.error) throw result.error;
    if (result.status !== 0 || !fs.existsSync(outPath)) {
      throw new Error(String(result.stderr || result.stdout || "local tts script failed").trim());
    }
    return outPath;
  }

  transcodeToTelegramVoice(inputPath) {
    const ffmpegBin = String(process.env.FFMPEG_BIN || "ffmpeg").trim();
    const tempDir = path.join(os.tmpdir(), "ai-bot-tts");
    fs.mkdirSync(tempDir, { recursive: true });
    const outPath = path.join(tempDir, `voice-${Date.now()}-${Math.random().toString(16).slice(2)}.ogg`);

    const result = spawnSync(
      ffmpegBin,
      ["-y", "-i", inputPath, "-c:a", "libopus", "-b:a", "24k", "-vbr", "on", "-compression_level", "10", outPath],
      {
        encoding: "utf8",
        timeout: 120000,
        maxBuffer: 8 * 1024 * 1024,
      }
    );

    if (result.error) throw result.error;
    if (result.status !== 0 || !fs.existsSync(outPath)) {
      throw new Error(String(result.stderr || result.stdout || "ffmpeg voice transcode failed").trim());
    }
    return outPath;
  }

  tagVoiceFileWithRequestId(inputPath, requestId, userId) {
    const normalized = String(inputPath || "").trim();
    if (!normalized || !fs.existsSync(normalized)) {
      throw new Error("voice file missing before request binding");
    }

    const tag = String(requestId || "").trim();
    const user = String(userId || "").trim();
    if (!tag || !user) {
      throw new Error("missing request_id/user_id for voice binding");
    }

    const ffmpegBin = String(process.env.FFMPEG_BIN || "ffmpeg").trim();
    const tempDir = path.join(os.tmpdir(), "ai-bot-tts");
    fs.mkdirSync(tempDir, { recursive: true });
    const outPath = path.join(tempDir, `voice-tagged-${Date.now()}-${Math.random().toString(16).slice(2)}.ogg`);

    const result = spawnSync(
      ffmpegBin,
      [
        "-y",
        "-i",
        normalized,
        "-map_metadata",
        "-1",
        "-c:a",
        "copy",
        "-metadata",
        `request_id=${tag}`,
        "-metadata",
        `user_id=${user}`,
        "-metadata",
        `comment=voice-request:${tag}`,
        outPath,
      ],
      {
        encoding: "utf8",
        timeout: 120000,
        maxBuffer: 8 * 1024 * 1024,
      }
    );

    if (result.error || result.status !== 0 || !fs.existsSync(outPath)) {
      throw result.error || new Error(String(result.stderr || result.stdout || "ffmpeg remux failed").trim());
    }

    return outPath;
  }

  containsTopic(text, topic) {
    const value = String(text || "").toLowerCase();
    const normalizedTopic = String(topic || "").trim().toLowerCase();
    if (!normalizedTopic) return true;
    return value.includes(normalizedTopic);
  }

  async sendVoiceReply(chatId, text, options = {}) {
    const caption = String(options.caption || "").trim();
    const requestId = String(options.requestId || `voice-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`).trim();
    const userId = String(options.userId || chatId || "").trim();
    const requiredTopic = String(options.requiredTopic || "").trim();
    const sourcePrompt = String(options.sourcePrompt || "").trim();
    const chatKey = String(chatId);
    this.latestVoiceRequestByChat.set(chatKey, requestId);
    let ttsPath = null;
    let voicePath = null;
    let deliveryPath = null;
    try {
      if (!requestId || !userId) {
        throw new Error("voice request binding requires request_id and user_id");
      }
      if (requiredTopic) {
        const matchesTranscript = this.containsTopic(text, requiredTopic);
        const matchesPrompt = this.containsTopic(sourcePrompt, requiredTopic);
        if (!matchesTranscript && !matchesPrompt) {
          this.logError(
            "send_voice_reply_blocked_topic_validation",
            `chat=${chatKey}`,
            `required_topic=${requiredTopic}`
          );
          return false;
        }
      }
      ttsPath = await this.synthesizeVoiceWithOpenAI(text);
      if (ttsPath) {
        voicePath = this.transcodeToTelegramVoice(ttsPath);
      } else {
        voicePath = this.synthesizeVoiceWithLocalScript(text);
      }
      if (!voicePath) return false;
      if (this.latestVoiceRequestByChat.get(chatKey) !== requestId) {
        this.logInfo(`voice_request_stale_drop chat=${chatKey} request_id=${requestId}`);
        return false;
      }
      deliveryPath = this.tagVoiceFileWithRequestId(voicePath, requestId, userId);
      await this.sendVoiceFile(chatKey, deliveryPath || voicePath, caption);
      return true;
    } catch (e) {
      this.logError("send_voice_reply_failed", this.formatErr(e));
      return false;
    } finally {
      if (this.latestVoiceRequestByChat.get(chatKey) === requestId) {
        this.latestVoiceRequestByChat.delete(chatKey);
      }
      if (ttsPath) fs.rmSync(ttsPath, { force: true });
      if (voicePath) fs.rmSync(voicePath, { force: true });
      if (deliveryPath && deliveryPath !== voicePath) fs.rmSync(deliveryPath, { force: true });
    }
  }

  async runAgentDispatch(agent, options) {
    const queueReady = await this.initQueueClients();
    if (!queueReady || !this.agentQueue || !this.agentQueueEvents || !(await this.queueHasWorkers(this.agentQueue))) {
      return this.runAgent(agent, options);
    }

    try {
      const job = await this.agentQueue.add(
        "agent.run",
        {
          agent,
          chatId: options.chatId || null,
          sessionId: options.sessionId || null,
          prompt: options.prompt,
          model: options.model || null,
          requestId: options.requestId || null,
        },
        this.buildJobOptions(this.config.REQUEST_TIMEOUT_MS)
      );
      const result = await job.waitUntilFinished(
        this.agentQueueEvents,
        this.config.AGENT_QUEUE_WAIT_FOR_RESULT_MS
      );
      if (!result || typeof result !== "object") {
        throw new Error("Queue returned empty result");
      }
      return result;
    } catch (e) {
      this.logError("queue_dispatch_failed_fallback_direct", this.formatErr(e));
      return this.runAgent(agent, options);
    }
  }

  async enqueueAgentJob(agent, options) {
    const queueReady = await this.initQueueClients();
    if (!queueReady || !this.agentQueue || !(await this.queueHasWorkers(this.agentQueue))) return null;
    return this.agentQueue.add(
      "agent.run",
      {
        agent,
        chatId: options.chatId || null,
        sessionId: options.sessionId || null,
        prompt: options.prompt,
        model: options.model || null,
        requestId: options.requestId || null,
      },
      this.buildJobOptions(this.config.REQUEST_TIMEOUT_MS)
    );
  }

  async transcribeAudioWithQueue(filePath, lang) {
    const queueReady = await this.initQueueClients();
    if (!queueReady || !this.sttQueue || !this.sttQueueEvents || !(await this.queueHasWorkers(this.sttQueue))) {
      return "";
    }

    const job = await this.sttQueue.add(
      "stt.transcribe",
      {
        filePath,
        lang: lang || String(process.env.WHISPER_LANG || "auto").trim(),
      },
      this.buildJobOptions(this.config.REQUEST_TIMEOUT_MS)
    );
    const result = await job.waitUntilFinished(this.sttQueueEvents, this.config.STT_QUEUE_WAIT_FOR_RESULT_MS);
    return String(result?.text || "").trim();
  }

  async executeInlineTaskWithRetry(meta) {
    try {
      for (let attempt = 1; attempt <= meta.attemptsMax; attempt += 1) {
        this.updateTaskState(meta.taskId, "running", {
          attempt,
          lastError: null,
          jobId: null,
        });
        const stopHeartbeat = this.startTaskHeartbeat(meta.taskId);
        try {
          const item = await this.withTaskTimeout(
            this.runWorkerTask({
              chatId: meta.chatId,
              agent: meta.agent,
              codexModel: meta.codexModel,
              workerId: meta.workerId,
              prompt: meta.prompt,
              requestId: meta.requestId || null,
            }),
            meta.timeoutMs,
            meta.taskId
          );
          this.updateTaskState(meta.taskId, "done", { lastError: null });
          return item;
        } catch (e) {
          const errMsg = e?.message || String(e);
          const isFinal = attempt >= meta.attemptsMax;
          if (isFinal) {
            this.updateTaskState(meta.taskId, "failed", { lastError: errMsg });
            throw e;
          }
          this.updateTaskState(meta.taskId, "pending", { attempt, lastError: errMsg });
        } finally {
          stopHeartbeat();
        }
      }
      throw new Error("Unexpected inline retry flow termination");
    } finally {
      this.releaseWorkerLock(meta.chatId, meta.agent, meta.workerId, meta.taskId);
    }
  }

  async runWorkerTask({ chatId, agent, codexModel, workerId, prompt, requestId = null }) {
    const workerSessionId = this.config.REUSE_SESSIONS
      ? await this.store.getWorkerSession(chatId, agent, workerId)
      : null;
    const { sessionId: newWorkerSession, reply } = await this.runAgentDispatch(agent, {
      chatId,
      sessionId: workerSessionId,
      prompt,
      model: codexModel,
      requestId,
    });
    if (
      this.config.REUSE_SESSIONS &&
      newWorkerSession &&
      newWorkerSession !== workerSessionId
    ) {
      await this.store.setWorkerSession(chatId, agent, workerId, newWorkerSession);
    }
    return { workerId, reply: String(reply || "").trim() || "(no text output)" };
  }
}

module.exports = {
  RuntimeOrchestrator,
};
