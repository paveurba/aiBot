const test = require("node:test");
const assert = require("node:assert/strict");

const { CommandService } = require("../lib/command_service");

test("/manager runs independent manager conversation using diagnostics context", async () => {
  const botMessages = [];
  const replies = [];
  let coordinatorCalled = 0;
  let decisionCalled = 0;
  const managerPrompts = [];
  const diagCalls = [];

  const service = new CommandService({
    bot: {
      sendMessage: async (chatId, text) => {
        botMessages.push({ chatId, text });
      },
    },
    store: {
      getChatSettings: async () => ({}),
      setChatSettings: async () => {},
      clearChat: async () => {},
      getSession: async () => null,
      setSession: async () => {},
    },
    orchestrator: {
      getDispatchStatus: () => null,
      clearDispatchStatus: () => {},
      getManagerDiagnostics: async (...args) => {
        diagCalls.push(args);
        return {
        timestamp: "2026-03-01T09:00:00.000Z",
        chatId: "77",
        coordinator: { active: false },
        codexWorkerStatus: {
          workersOnline: true,
          activeJobs: 1,
          waitingJobs: 2,
          failedJobs: 0,
        },
        queue: { enabled: true, ready: true },
        runtime: {
          pid: 1234,
          uptimeSec: 99,
          memoryRssMb: 42.5,
          requestTimeoutMs: 180000,
        },
      };
      },
      sendReply: async (chatId, text) => {
        replies.push({ chatId, text });
      },
      runCoordinatorDispatch: async () => {
        coordinatorCalled += 1;
      },
      decideExecutionMode: async () => {
        decisionCalled += 1;
        return { mode: "direct", tasks: [] };
      },
      runAgentDispatch: async (_agent, options) => {
        managerPrompts.push(options.prompt);
        return { sessionId: null, reply: "manager reply" };
      },
    },
    defaultModel: "codex",
    reuseSessions: false,
    trimTelegram: (text) => String(text),
    resolveAgent: () => "codex",
    resolveCodexModel: () => null,
    logInfo: () => {},
    logError: () => {},
  });

  const handled = await service.handleMessage("77", "/manager what worker do now");
  assert.equal(handled, true);
  assert.equal(botMessages.length, 0);
  assert.equal(replies.length, 1);
  assert.equal(replies[0].text, "manager reply");
  assert.equal(managerPrompts.length, 1);
  assert.deepEqual(diagCalls, [["77", { scope: "global" }]]);
  assert.match(managerPrompts[0], /You are manager worker-1 running in independent mode\./);
  assert.match(managerPrompts[0], /User request: what worker do now/);
  assert.match(managerPrompts[0], /Diagnostics JSON:/);
  assert.equal(coordinatorCalled, 0);
  assert.equal(decisionCalled, 0);
});

test("/manager stores session in dedicated manager scope when reuse is enabled", async () => {
  const setManagerSessions = [];
  let coordinatorSessionSetCalls = 0;

  const service = new CommandService({
    bot: {
      sendMessage: async () => {},
    },
    store: {
      getChatSettings: async () => ({}),
      setChatSettings: async () => {},
      clearChat: async () => {},
      getSession: async () => null,
      setSession: async () => {},
      getManagerSession: async () => "mgr-old",
      setManagerSession: async (_chatId, _agent, sessionId) => {
        setManagerSessions.push(sessionId);
      },
    },
    orchestrator: {
      getDispatchStatus: () => null,
      clearDispatchStatus: () => {},
      getManagerDiagnostics: async () => ({
        timestamp: "2026-03-01T09:00:00.000Z",
      }),
      sendReply: async () => {},
      runCoordinatorDispatch: async () => {},
      decideExecutionMode: async () => ({ mode: "direct", tasks: [] }),
      runAgentDispatch: async (_agent, options) => {
        assert.equal(options.sessionId, "mgr-old");
        return { sessionId: "mgr-new", reply: "manager ok" };
      },
      setCoordinatorSession: async () => {
        coordinatorSessionSetCalls += 1;
      },
    },
    defaultModel: "codex",
    reuseSessions: true,
    trimTelegram: (text) => String(text),
    resolveAgent: () => "codex",
    resolveCodexModel: () => null,
    logInfo: () => {},
    logError: () => {},
  });

  const handled = await service.handleMessage("77", "/manager");
  assert.equal(handled, true);
  assert.deepEqual(setManagerSessions, ["mgr-new"]);
  assert.equal(coordinatorSessionSetCalls, 0);
});

test("task-like message is scheduled as single-worker dispatch even when active dispatch exists", async () => {
  const botMessages = [];
  const dispatchCalls = [];

  const service = new CommandService({
    bot: {
      sendMessage: async (_chatId, text) => {
        botMessages.push(text);
      },
    },
    store: {
      getChatSettings: async () => ({}),
      setChatSettings: async () => {},
      clearChat: async () => {},
      getSession: async () => null,
      setSession: async () => {},
    },
    orchestrator: {
      getDispatchStatus: () => ({ token: "tok-1", agent: "codex" }),
      clearDispatchStatus: () => {},
      getManagerDiagnostics: async () => ({}),
      sendReply: async () => {},
      dispatchSingleWorkerRequest: async (payload) => {
        dispatchCalls.push(payload);
        return { status: "queued", position: 2 };
      },
      runCoordinatorDispatch: async () => {},
      decideExecutionMode: async () => ({ mode: "direct", tasks: [] }),
      runAgentDispatch: async () => ({ sessionId: null, reply: "unused" }),
    },
    defaultModel: "codex",
    reuseSessions: false,
    trimTelegram: (text) => String(text),
    resolveAgent: () => "codex",
    resolveCodexModel: () => null,
    logInfo: () => {},
    logError: () => {},
  });

  const handled = await service.handleMessage("77", "build a deployment pipeline", { requestId: "req-123" });
  assert.equal(handled, true);
  assert.equal(dispatchCalls.length, 1);
  assert.equal(dispatchCalls[0].goal, "build a deployment pipeline");
  assert.equal(dispatchCalls[0].requestId, "req-123");
  assert.ok(botMessages.some((m) => String(m).includes("All workers are busy")));
  assert.ok(botMessages.some((m) => String(m).includes("Queue position: 2")));
});

test("natural voice-request phrase triggers voice reply path without slash command", async () => {
  const botMessages = [];
  let dispatchCalls = 0;
  let voiceCalls = 0;
  let textReplies = 0;
  const runPrompts = [];

  const service = new CommandService({
    bot: {
      sendMessage: async (_chatId, text) => {
        botMessages.push(text);
      },
    },
    store: {
      getChatSettings: async () => ({}),
      setChatSettings: async () => {},
      clearChat: async () => {},
      getSession: async () => null,
      setSession: async () => {},
    },
    orchestrator: {
      getManagerDiagnostics: async () => ({}),
      sendReply: async () => {
        textReplies += 1;
      },
      sendVoiceReply: async () => {
        voiceCalls += 1;
        return true;
      },
      dispatchSingleWorkerRequest: async () => {
        dispatchCalls += 1;
        return { status: "dispatched", workerId: 2 };
      },
      runAgentDispatch: async (_agent, options) => {
        runPrompts.push(String(options.prompt || ""));
        return { sessionId: null, reply: "voice answer" };
      },
    },
    defaultModel: "codex",
    reuseSessions: false,
    trimTelegram: (text) => String(text),
    resolveAgent: () => "codex",
    resolveCodexModel: () => null,
    logInfo: () => {},
    logError: () => {},
  });

  const handled = await service.handleMessage("77", "Create a short bear story and send as voice message");
  assert.equal(handled, true);
  assert.equal(dispatchCalls, 0);
  assert.equal(voiceCalls, 1);
  assert.equal(textReplies, 0);
  assert.equal(botMessages.length, 0);
  assert.ok(runPrompts.length === 1);
  assert.ok(/bear story/i.test(runPrompts[0]));
});

test("quick ping message does not reset active dispatch", async () => {
  let clearDispatchCalls = 0;
  const replies = [];

  const service = new CommandService({
    bot: {
      sendMessage: async () => {},
    },
    store: {
      getChatSettings: async () => ({}),
      setChatSettings: async () => {},
      clearChat: async () => {},
      getSession: async () => null,
      setSession: async () => {},
    },
    orchestrator: {
      getDispatchStatus: () => ({ token: "tok-2", agent: "codex" }),
      clearDispatchStatus: () => {
        clearDispatchCalls += 1;
      },
      setPendingDispatchGoal: () => {},
      getManagerDiagnostics: async () => ({}),
      sendReply: async (_chatId, text) => {
        replies.push(text);
      },
      runCoordinatorDispatch: async () => {},
      decideExecutionMode: async () => ({ mode: "direct", tasks: [] }),
      runAgentDispatch: async () => ({ sessionId: null, reply: "pong-reply" }),
      sendVoiceReply: async () => true,
    },
    defaultModel: "codex",
    reuseSessions: false,
    trimTelegram: (text) => String(text),
    resolveAgent: () => "codex",
    resolveCodexModel: () => null,
    logInfo: () => {},
    logError: () => {},
  });

  const handled = await service.handleMessage("77", "Ping", { requestId: "req-ping-1" });
  assert.equal(handled, true);
  assert.equal(clearDispatchCalls, 0);
  assert.deepEqual(replies, ["pong-reply"]);
});
