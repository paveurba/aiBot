const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { RuntimeOrchestrator } = require("../lib/runtime_orchestrator");

function createOrchestrator(overrides = {}) {
  return new RuntimeOrchestrator({
    bot: { sendMessage: async () => {} },
    store: {
      getWorkerSession: async () => null,
      setWorkerSession: async () => {},
    },
    runAgent: async () => ({ sessionId: null, reply: "ok" }),
    logInfo: () => {},
    logError: () => {},
    formatErr: (err) => String(err?.message || err || ""),
    trimTelegram: (text) => String(text || ""),
    config: {
      MAX_WORKER_TASKS: 4,
      MAX_COORDINATOR_WORKERS_PER_REQUEST: 4,
      REQUEST_TIMEOUT_MS: 2000,
      AGENT_QUEUE_WAIT_FOR_RESULT_MS: 2000,
      STT_QUEUE_WAIT_FOR_RESULT_MS: 2000,
      AGENT_ASYNC_ACK: true,
      JOB_ATTEMPTS: 2,
      JOB_BACKOFF_MS: 10,
      REUSE_SESSIONS: false,
    },
    queue: {
      isQueueEnabled: () => false,
    },
    ...overrides,
  });
}

test("worker routing chooses idle worker when preferred worker is locked", () => {
  const orchestrator = createOrchestrator();
  const lock = orchestrator.acquireWorkerLock({
    chatId: "chat-1",
    agent: "codex",
    workerId: 2,
    task: "busy task",
    attemptsMax: 2,
    timeoutMs: 2000,
  });
  assert.ok(lock);

  const routed = orchestrator.chooseIdleWorkerId({
    chatId: "chat-1",
    agent: "codex",
    preferredWorkerId: 2,
    reservedWorkerIds: new Set(),
  });
  assert.equal(routed, 3);
});

test("busy-worker scheduling respects locks and reserved workers", () => {
  const orchestrator = createOrchestrator();
  const lock2 = orchestrator.acquireWorkerLock({
    chatId: "chat-busy",
    agent: "codex",
    workerId: 2,
    task: "busy-2",
    attemptsMax: 2,
    timeoutMs: 2000,
  });
  const lock3 = orchestrator.acquireWorkerLock({
    chatId: "chat-busy",
    agent: "codex",
    workerId: 3,
    task: "busy-3",
    attemptsMax: 2,
    timeoutMs: 2000,
  });
  assert.ok(lock2);
  assert.ok(lock3);

  const rerouted = orchestrator.chooseIdleWorkerId({
    chatId: "chat-busy",
    agent: "codex",
    preferredWorkerId: 2,
    reservedWorkerIds: new Set(),
  });
  assert.equal(rerouted, 4);

  const unavailable = orchestrator.chooseIdleWorkerId({
    chatId: "chat-busy",
    agent: "codex",
    preferredWorkerId: 3,
    reservedWorkerIds: new Set([4]),
  });
  assert.equal(unavailable, null);
});

test("single-worker dispatcher assigns different free workers across concurrent requests", async () => {
  const orchestrator = createOrchestrator();
  const dispatched = [];
  orchestrator.dispatchSingleWorkerMeta = (meta) => {
    dispatched.push(meta);
  };

  const first = await orchestrator.dispatchSingleWorkerRequest({
    chatId: "chat-par",
    agent: "codex",
    codexModel: null,
    goal: "task one",
    requestId: "req-a",
  });
  const second = await orchestrator.dispatchSingleWorkerRequest({
    chatId: "chat-par",
    agent: "codex",
    codexModel: null,
    goal: "task two",
    requestId: "req-b",
  });

  assert.equal(first.status, "dispatched");
  assert.equal(second.status, "dispatched");
  assert.equal(dispatched.length, 2);
  assert.notEqual(dispatched[0].workerId, dispatched[1].workerId);
});

test("single-worker dispatcher queues when all workers are busy and pumps when a worker frees", async () => {
  const orchestrator = createOrchestrator({
    config: {
      MAX_WORKER_TASKS: 3,
      MAX_COORDINATOR_WORKERS_PER_REQUEST: 3,
      REQUEST_TIMEOUT_MS: 2000,
      AGENT_QUEUE_WAIT_FOR_RESULT_MS: 2000,
      STT_QUEUE_WAIT_FOR_RESULT_MS: 2000,
      AGENT_ASYNC_ACK: true,
      JOB_ATTEMPTS: 2,
      JOB_BACKOFF_MS: 10,
      REUSE_SESSIONS: false,
    },
  });
  const dispatched = [];
  orchestrator.dispatchSingleWorkerMeta = (meta) => {
    dispatched.push(meta);
  };

  const lock2 = orchestrator.acquireWorkerLock({
    chatId: "chat-q",
    agent: "codex",
    workerId: 2,
    task: "busy-2",
    attemptsMax: 2,
    timeoutMs: 2000,
  });
  const lock3 = orchestrator.acquireWorkerLock({
    chatId: "chat-q",
    agent: "codex",
    workerId: 3,
    task: "busy-3",
    attemptsMax: 2,
    timeoutMs: 2000,
  });
  assert.ok(lock2);
  assert.ok(lock3);

  const queued = await orchestrator.dispatchSingleWorkerRequest({
    chatId: "chat-q",
    agent: "codex",
    codexModel: null,
    goal: "queued task",
    requestId: "req-q",
  });
  assert.equal(queued.status, "queued");
  assert.equal(orchestrator.countPendingSingleWorkerDispatches("chat-q", "codex"), 1);

  orchestrator.releaseWorkerLock("chat-q", "codex", 2, lock2.taskId);
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0].workerId, 2);
  assert.equal(orchestrator.countPendingSingleWorkerDispatches("chat-q", "codex"), 0);
});

test("sendReply throws when notify queue is unavailable and direct fallback delivery fails", async () => {
  const orchestrator = createOrchestrator();
  orchestrator.sendDirectWithRetry = async () => false;
  await assert.rejects(
    async () => {
      await orchestrator.sendReply("chat-x", "hello", { requestId: "req-fail" });
    },
    /direct fallback failed/
  );
});

test("manager diagnostics reports worker and lock state accurately", async () => {
  const orchestrator = createOrchestrator();
  const now = Date.now();

  const activeLock = orchestrator.acquireWorkerLock({
    chatId: "chat-diag",
    agent: "codex",
    workerId: 2,
    task: "active-task",
    attemptsMax: 2,
    timeoutMs: 2000,
  });
  assert.ok(activeLock);
  orchestrator.updateTaskState(activeLock.taskId, "running", { attempt: 1 });

  const staleLock = orchestrator.acquireWorkerLock({
    chatId: "chat-diag",
    agent: "codex",
    workerId: 3,
    task: "stale-task",
    attemptsMax: 2,
    timeoutMs: 1000,
  });
  assert.ok(staleLock);
  orchestrator.updateTaskState(staleLock.taskId, "running", { attempt: 1 });

  // Simulate stale lock/task heartbeat.
  const staleTask = orchestrator.taskStates.get(staleLock.taskId);
  staleTask.createdAt = now - 5000;
  staleTask.updatedAt = now - 5000;
  staleTask.timeoutMs = 1000;
  orchestrator.taskStates.set(staleLock.taskId, staleTask);

  const staleLockKey = orchestrator.workerLockKey("chat-diag", "codex", 3);
  const staleLockRecord = orchestrator.workerLocks.get(staleLockKey);
  staleLockRecord.updatedAt = now - 5000;
  orchestrator.workerLocks.set(staleLockKey, staleLockRecord);

  const diagnostics = await orchestrator.getManagerDiagnostics("chat-diag");

  assert.equal(diagnostics.workers.total, 3); // workers 2..4 for MAX_WORKER_TASKS=4
  assert.equal(diagnostics.workers.busy, 2);
  assert.equal(diagnostics.workers.idle, 1);

  const worker2 = diagnostics.workers.list.find((w) => w.workerId === 2);
  const worker3 = diagnostics.workers.list.find((w) => w.workerId === 3);
  const worker4 = diagnostics.workers.list.find((w) => w.workerId === 4);
  assert.equal(worker2.state, "running");
  assert.equal(worker3.state, "running");
  assert.equal(worker4.state, "idle");
  assert.equal(worker2.currentTaskId, activeLock.taskId);
  assert.equal(worker3.currentTaskId, staleLock.taskId);

  const stale = diagnostics.locks.find((l) => l.taskId === staleLock.taskId);
  assert.ok(stale);
  assert.equal(stale.workerId, 3);
  assert.equal(stale.staleLock, true);
  assert.equal(stale.ttlRemainingMs, 0);
});

test("manager diagnostics is global by default and supports chat-scoped filter", async () => {
  const orchestrator = createOrchestrator();

  const lockChatA = orchestrator.acquireWorkerLock({
    chatId: "chat-a",
    agent: "codex",
    workerId: 2,
    task: "task-a",
    attemptsMax: 2,
    timeoutMs: 2000,
  });
  const lockChatB = orchestrator.acquireWorkerLock({
    chatId: "chat-b",
    agent: "codex",
    workerId: 3,
    task: "task-b",
    attemptsMax: 2,
    timeoutMs: 2000,
  });
  assert.ok(lockChatA);
  assert.ok(lockChatB);
  orchestrator.updateTaskState(lockChatA.taskId, "running", { attempt: 1 });
  orchestrator.updateTaskState(lockChatB.taskId, "running", { attempt: 1 });

  const globalDiag = await orchestrator.getManagerDiagnostics("chat-a");
  assert.equal(globalDiag.scope, "global");
  assert.equal(globalDiag.locks.length, 2);
  assert.equal(globalDiag.coordinator.activeCount, 0);
  assert.ok(globalDiag.locks.some((l) => l.chatId === "chat-a"));
  assert.ok(globalDiag.locks.some((l) => l.chatId === "chat-b"));

  const worker2 = globalDiag.workers.list.find((w) => w.workerId === 2);
  const worker3 = globalDiag.workers.list.find((w) => w.workerId === 3);
  assert.equal(worker2.state, "running");
  assert.equal(worker3.state, "running");
  assert.equal(worker2.activeLocks, 1);
  assert.equal(worker3.activeLocks, 1);
  assert.ok(worker2.activeChats.includes("chat-a"));
  assert.ok(worker3.activeChats.includes("chat-b"));

  const chatDiag = await orchestrator.getManagerDiagnostics("chat-a", { scope: "chat" });
  assert.equal(chatDiag.scope, "chat");
  assert.equal(chatDiag.locks.length, 1);
  assert.equal(chatDiag.locks[0].chatId, "chat-a");
});

test("sendVoiceReply sends tagged fresh audio artifact when request id is provided", async () => {
  const orchestrator = createOrchestrator();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "voice-fresh-test-"));
  const sourcePath = path.join(tempDir, "source.ogg");
  const taggedPath = path.join(tempDir, "tagged.ogg");
  fs.writeFileSync(sourcePath, Buffer.from("OggSvoicecontent", "utf8"));
  fs.writeFileSync(taggedPath, Buffer.from("OggStaggedcontent", "utf8"));

  const sent = [];
  orchestrator.synthesizeVoiceWithOpenAI = async () => null;
  orchestrator.synthesizeVoiceWithLocalScript = () => sourcePath;
  orchestrator.tagVoiceFileWithRequestId = (inputPath, requestId, userId) => {
    assert.equal(inputPath, sourcePath);
    assert.equal(requestId, "req-123");
    assert.equal(userId, "chat-voice");
    return taggedPath;
  };
  orchestrator.sendVoiceFile = async (chatId, filePath, caption) => {
    sent.push({ chatId, filePath, caption });
  };

  const ok = await orchestrator.sendVoiceReply("chat-voice", "hello", {
    requestId: "req-123",
    caption: "cap",
  });

  assert.equal(ok, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].chatId, "chat-voice");
  assert.equal(sent[0].filePath, taggedPath);
  assert.equal(sent[0].caption, "cap");
  assert.equal(fs.existsSync(sourcePath), false);
  assert.equal(fs.existsSync(taggedPath), false);
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("sendVoiceReply blocks voice send when required topic is missing", async () => {
  const orchestrator = createOrchestrator();
  let sent = false;
  orchestrator.synthesizeVoiceWithOpenAI = async () => {
    throw new Error("should not synthesize when topic validation fails");
  };
  orchestrator.sendVoiceFile = async () => {
    sent = true;
  };

  const ok = await orchestrator.sendVoiceReply("chat-topic", "short story about wolves", {
    requestId: "req-topic",
    userId: "chat-topic",
    requiredTopic: "bear",
    sourcePrompt: "tell me a wolf story",
  });

  assert.equal(ok, false);
  assert.equal(sent, false);
});

test("sendVoiceReply does not fallback to untagged file when binding fails", async () => {
  const orchestrator = createOrchestrator();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "voice-binding-test-"));
  const sourcePath = path.join(tempDir, "source.ogg");
  fs.writeFileSync(sourcePath, Buffer.from("OggSvoicecontent", "utf8"));

  let sent = false;
  orchestrator.synthesizeVoiceWithOpenAI = async () => null;
  orchestrator.synthesizeVoiceWithLocalScript = () => sourcePath;
  orchestrator.tagVoiceFileWithRequestId = () => {
    throw new Error("binding failed");
  };
  orchestrator.sendVoiceFile = async () => {
    sent = true;
  };

  const ok = await orchestrator.sendVoiceReply("chat-bind", "bear story", {
    requestId: "req-bind",
    userId: "chat-bind",
    requiredTopic: "bear",
    sourcePrompt: "bear story",
  });

  assert.equal(ok, false);
  assert.equal(sent, false);
  assert.equal(fs.existsSync(sourcePath), false);
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("sendVoiceReply drops stale in-flight audio when a newer request arrives for the same chat", async () => {
  const orchestrator = createOrchestrator();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "voice-stale-drop-test-"));
  const sent = [];

  orchestrator.synthesizeVoiceWithOpenAI = async (text) => {
    const isSlow = String(text) === "slow-request";
    await new Promise((resolve) => setTimeout(resolve, isSlow ? 50 : 5));
    const outPath = path.join(tempDir, `${String(text)}.ogg`);
    fs.writeFileSync(outPath, Buffer.from("OggSvoicecontent", "utf8"));
    return outPath;
  };
  orchestrator.transcodeToTelegramVoice = (inputPath) => inputPath;
  orchestrator.tagVoiceFileWithRequestId = (inputPath) => inputPath;
  orchestrator.sendVoiceFile = async (_chatId, filePath) => {
    sent.push(filePath);
  };

  const slow = orchestrator.sendVoiceReply("chat-race", "slow-request", { requestId: "req-slow" });
  await new Promise((resolve) => setTimeout(resolve, 10));
  const fast = orchestrator.sendVoiceReply("chat-race", "fast-request", { requestId: "req-fast" });

  const [slowResult, fastResult] = await Promise.all([slow, fast]);
  assert.equal(slowResult, false);
  assert.equal(fastResult, true);
  assert.equal(sent.length, 1);
  assert.ok(String(sent[0]).includes("fast-request.ogg"));
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("bear voice requests always send fresh request-bound audio artifacts", async () => {
  const orchestrator = createOrchestrator();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "voice-bear-fresh-test-"));
  const sent = [];
  let synthCounter = 0;

  orchestrator.synthesizeVoiceWithOpenAI = async () => null;
  orchestrator.synthesizeVoiceWithLocalScript = (text) => {
    synthCounter += 1;
    const source = path.join(tempDir, `bear-source-${synthCounter}.ogg`);
    fs.writeFileSync(source, Buffer.from(`OggS-${String(text)}-${synthCounter}`, "utf8"));
    return source;
  };
  orchestrator.tagVoiceFileWithRequestId = (inputPath, requestId, userId) => {
    const tagged = path.join(tempDir, `tagged-${requestId}-${userId}.ogg`);
    fs.copyFileSync(inputPath, tagged);
    return tagged;
  };
  orchestrator.sendVoiceFile = async (_chatId, filePath) => {
    sent.push(filePath);
  };

  const first = await orchestrator.sendVoiceReply("bear-chat", "Bear facts one", {
    requestId: "bear-req-1",
    userId: "bear-chat",
    requiredTopic: "bear",
    sourcePrompt: "tell me bear facts one",
  });
  const second = await orchestrator.sendVoiceReply("bear-chat", "Bear facts two", {
    requestId: "bear-req-2",
    userId: "bear-chat",
    requiredTopic: "bear",
    sourcePrompt: "tell me bear facts two",
  });

  assert.equal(first, true);
  assert.equal(second, true);
  assert.equal(sent.length, 2);
  assert.notEqual(sent[0], sent[1], "expected fresh artifact per bear request");
  assert.ok(String(sent[0]).includes("bear-req-1"));
  assert.ok(String(sent[1]).includes("bear-req-2"));
  fs.rmSync(tempDir, { recursive: true, force: true });
});
